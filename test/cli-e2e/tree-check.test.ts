import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTreeProject, spec, type TreeProject } from '../fixtures/tree/builder.js';
import { runCLI } from '../helpers/run-cli.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Tree Test',
  GIT_AUTHOR_EMAIL: 'tree@example.com',
  GIT_COMMITTER_NAME: 'Tree Test',
  GIT_COMMITTER_EMAIL: 'tree@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

describe('tree check and migration commands', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });
  const cli = (...args: string[]) => runCLI(args, { cwd: project!.root, env: GIT_ENV });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project!.root, env: { ...process.env, ...GIT_ENV }, encoding: 'utf-8' });

  it('initializes governance without touching existing config, then checks and plans phases', async () => {
    project = await createTreeProject({
      tree: false,
      specs: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`domain/c${String(i).padStart(2, '0')}`, spec(`c${i}`, ['R'])])),
    });
    const original = '# keep this comment\nschema: spec-driven\nrules:\n  specs:\n    - A very long rule that must stay on one line even though it is clearly longer than eighty characters.\n';
    await project.write('openspec/config.yaml', original);

    const init = await cli('tree', 'migrate', 'init', '--json');
    expect(init.exitCode).toBe(0);
    const config = await project.read('openspec/config.yaml');
    expect(config.startsWith(original)).toBe(true);
    expect(parse(config).tree).toMatchObject({ enabled: true, scope: [], enforcement: { TREE_EMPTY_NODE: 'warn', TREE_REVIEW_DUE: 'info' } });
    expect(parse(await project.read('openspec/tree-redirects.yaml'))).toEqual({ version: 1, entries: [] });
    expect((await cli('tree', 'migrate', 'init')).exitCode).toBe(1);

    const check = await cli('tree', 'check', '--json');
    expect(check.exitCode).toBe(0);
    const report = JSON.parse(check.stdout);
    expect(report).toMatchObject({
      root: project.root,
      config: { maxChildren: 20, maxSpecLines: 300 },
      summary: { capabilities: 21, errors: 0 },
    });
    expect(report.findings).toContainEqual({
      code: 'TREE_FANOUT',
      level: 'warning',
      node: 'domain',
      actual: 21,
      limit: 20,
      message: 'domain has 21 children (limit 20)',
    });

    const status = JSON.parse((await cli('tree', 'migrate', 'status', '--json')).stdout);
    expect(status).toMatchObject({ enabled: true, phase: 2, rules: { TREE_FANOUT: 1 } });
    const plan = JSON.parse((await cli('tree', 'migrate', 'plan', '--json')).stdout);
    expect(plan.instructions.map((instruction: { id: string }) => instruction.id)).toEqual(['split:domain']);
  });

  it('fails tree check on error-level findings', async () => {
    project = await createTreeProject({ specs: { 'a/x': spec('x', ['R']) } });
    await project.write('openspec/specs/a/empty/notes.txt', '');
    await fs.rm(path.join(project.paths.specsDir, 'a/empty/notes.txt'));
    const check = await cli('tree', 'check', '--json');
    expect(check.exitCode).toBe(1);
    expect(JSON.parse(check.stdout).findings).toContainEqual(expect.objectContaining({ code: 'TREE_EMPTY_NODE', node: 'a/empty', level: 'error' }));
  });

  it('imports capability redirects from git renames after confirmation', async () => {
    project = await createTreeProject({ specs: { 'review-drafts': spec('review-drafts', ['R']) } });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'flat');
    const first = git('rev-parse', 'HEAD').trim();
    await fs.mkdir(path.join(project.paths.specsDir, 'review'), { recursive: true });
    git('mv', 'openspec/specs/review-drafts', 'openspec/specs/review/drafts');
    git('commit', '-qm', 'nest');

    const dryRun = JSON.parse((await cli('tree', 'migrate', 'import-redirects', '--from-git', `${first}..HEAD`, '--json')).stdout);
    expect(dryRun).toMatchObject({ written: 0, found: [{ from: 'review-drafts', to: 'review/drafts' }] });
    expect(await project.exists('openspec/tree-redirects.yaml')).toBe(false);

    const written = JSON.parse((await cli('tree', 'migrate', 'import-redirects', '--from-git', `${first}..HEAD`, '--yes', '--json')).stdout);
    expect(written.written).toBe(1);
    expect(parse(await project.read('openspec/tree-redirects.yaml')).entries).toEqual([
      { change: expect.stringMatching(/^git:[0-9a-f]{12}$/), capability: { from: 'review-drafts', to: 'review/drafts' } },
    ]);
    const again = JSON.parse((await cli('tree', 'migrate', 'import-redirects', '--from-git', `${first}..HEAD`, '--yes', '--json')).stdout);
    expect(again).toMatchObject({ found: [], written: 0 });
  });

  it('applies tree.maxRequirementTextLength to the long-requirement warning', async () => {
    const long = `The system SHALL ${'keep every reviewed clause '.repeat(25)}.`;
    project = await createTreeProject({
      tree: false,
      specs: { review: spec('review', [{ name: 'Long rule', text: long }]) },
    });
    const strict = async () => JSON.parse((await cli('validate', 'review', '--type', 'spec', '--strict', '--json')).stdout).items[0];
    const upstream = await strict();
    expect(upstream.valid).toBe(false);
    expect(upstream.issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining('>500 characters') }));

    await project.write('openspec/config.yaml', 'schema: spec-driven\ntree:\n  enabled: true\n  maxRequirementTextLength: 1000\n');
    expect((await strict()).valid).toBe(true);

    await project.write('openspec/config.yaml', 'schema: spec-driven\ntree:\n  enabled: true\n  maxRequirementTextLength: 600\n');
    expect((await strict()).issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining('>600 characters') }));
  });
});
