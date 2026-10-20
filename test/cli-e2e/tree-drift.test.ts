import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { serializeRedirects } from '../../src/core/tree/redirects.js';
import { createTreeProject, requirement, spec, type TreeProject } from '../fixtures/tree/builder.js';
import { runCLI } from '../helpers/run-cli.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Tree Test',
  GIT_AUTHOR_EMAIL: 'tree@example.com',
  GIT_COMMITTER_NAME: 'Tree Test',
  GIT_COMMITTER_EMAIL: 'tree@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const X = requirement({ name: 'Finalization', text: 'The system SHALL keep the saved name.', scenarios: ['Saved name kept'] });
const Y = requirement({ name: 'Finalization', text: 'The system SHALL keep the saved name and audit it.', scenarios: ['Saved name kept', 'Audit written'] });
const X_PRIME = requirement({ name: 'Finalization', text: 'The system SHALL keep the saved name exactly.', scenarios: ['Saved name kept'] });

function specWith(block: string): string {
  return `# drafts Specification\n\n## Purpose\nDefines how drafts are finalized so every reader finds one authoritative owner.\n\n## Requirements\n\n${block}\n`;
}

describe('base snapshots catch drift that merge-base checks miss (#1387)', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project!.root, env: { ...process.env, ...GIT_ENV }, encoding: 'utf-8' });
  const cli = (...args: string[]) => runCLI(args, { cwd: project!.root, env: GIT_ENV });

  it('refuses archive after rebase, accepts one requirement at a time, then archives', async () => {
    project = await createTreeProject({
      tree: { drift: { baseRef: 'v2' }, enforcement: { CHANGE_PLACEMENT_MISSING: 'off' } },
      specs: { 'review/drafts': specWith(X) },
    });
    git('init', '-q', '-b', 'v2');
    git('add', '-A');
    git('commit', '-qm', 'base');

    // Branch B authors a MODIFIED against X and pins it.
    git('checkout', '-qb', 'feature');
    await project.write('openspec/changes/edit-name/proposal.md', '# Edit\n\n## Why\nTighten naming.\n\n## What Changes\n- Exact names\n');
    await project.write('openspec/changes/edit-name/.openspec.yaml', 'schema: spec-driven\n');
    await project.write('openspec/changes/edit-name/specs/review/drafts/spec.md', `## MODIFIED Requirements\n\n${X_PRIME}\n`);

    const unpinned = JSON.parse((await cli('validate', 'edit-name', '--json')).stdout);
    expect(unpinned.items[0].issues).toContainEqual(expect.objectContaining({ code: 'CHANGE_BASE_UNPINNED', level: 'WARNING' }));
    expect(await project.exists('openspec/changes/edit-name/bases.yaml')).toBe(false);

    expect((await cli('tree', 'pin', 'edit-name')).exitCode).toBe(0);
    git('add', '-A');
    git('commit', '-qm', 'edit-name');

    // Meanwhile v2 archives another change that rewrites the requirement to Y.
    git('checkout', '-q', 'v2');
    await project.write('openspec/specs/review/drafts/spec.md', specWith(Y));
    git('commit', '-qam', 'archive audit change');
    git('checkout', '-q', 'feature');

    const beforeRebase = JSON.parse((await cli('validate', 'edit-name', '--json')).stdout).items[0];
    expect(beforeRebase.valid).toBe(true);
    expect(beforeRebase.issues).toContainEqual(expect.objectContaining({ code: 'CHANGE_REMOTE_DRIFT', level: 'WARNING' }));

    // After the rebase the merge-base is v2's tip: only the pinned base still knows X.
    git('rebase', '-q', 'v2');
    const afterRebase = JSON.parse((await cli('validate', 'edit-name', '--json')).stdout).items[0];
    expect(afterRebase.valid).toBe(false);
    expect(afterRebase.issues).toContainEqual(
      expect.objectContaining({ code: 'CHANGE_DRIFT', level: 'ERROR', message: expect.stringContaining('+The system SHALL keep the saved name and audit it.') })
    );

    const refused = await cli('archive', 'edit-name', '--yes', '--json');
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).status[0].code).toBe('drift');
    expect(await project.read('openspec/specs/review/drafts/spec.md')).toBe(specWith(Y));

    // The author merges Y into the delta and accepts exactly that requirement.
    await project.write('openspec/changes/edit-name/specs/review/drafts/spec.md', `## MODIFIED Requirements\n\n${Y.replace('name and audit', 'name exactly and audit')}\n`);
    const accepted = await cli('tree', 'pin', 'edit-name', '--accept', 'review/drafts#Finalization', '--json');
    expect(accepted.exitCode).toBe(0);
    const bases = parse(await project.read('openspec/changes/edit-name/bases.yaml'));
    expect(bases.entries[0]).toMatchObject({ source: 'accepted', previous: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(bases.entries[0].previous).not.toBe(bases.entries[0].sha256);

    const archived = await cli('archive', 'edit-name', '--yes', '--json');
    expect(archived.exitCode).toBe(0);
    const archivedAs = JSON.parse(archived.stdout).archive.archivedAs;
    expect(await project.exists(`openspec/changes/archive/${archivedAs}/bases.yaml`)).toBe(true);
    expect(await project.read('openspec/specs/review/drafts/spec.md')).toContain('keep the saved name exactly and audit it');
  });

  it('does not report remote drift for a requirement only moved by a local, unmerged restructure', async () => {
    project = await createTreeProject({
      tree: { drift: { baseRef: 'v2' }, enforcement: { CHANGE_PLACEMENT_MISSING: 'off' } },
      specs: { 'review/drafts': specWith(X) },
      changes: { edit: { files: { 'specs/review/drafts/spec.md': `## MODIFIED Requirements\n\n${X_PRIME}\n` } } },
    });
    git('init', '-q', '-b', 'v2');
    git('add', '-A');
    git('commit', '-qm', 'base');
    expect((await cli('tree', 'pin', 'edit')).exitCode).toBe(0);
    // Locally archive a restructure that moves review/drafts to review/run/drafts (not on v2).
    await project.write(
      'openspec/changes/move/restructure.yaml',
      'version: 1\noperations:\n  - op: create-namespace\n    path: review/run\n  - op: move-capability\n    from: review/drafts\n    to: review/run/drafts\n'
    );
    await project.write('openspec/changes/move/.openspec.yaml', 'schema: spec-driven\nrestructure: true\n');
    await project.write('openspec/changes/move/proposal.md', '# Move\n\n## Why\nGroup run specs.\n\n## What Changes\n- Move drafts\n');
    expect((await cli('archive', 'move', '--yes', '--json')).exitCode).toBe(0);
    expect(await project.exists('openspec/changes/edit/specs/review/run/drafts/spec.md')).toBe(true);

    const issues = JSON.parse((await cli('validate', 'edit', '--json')).stdout).items[0].issues;
    expect(issues.filter((issue: { code?: string }) => issue.code === 'CHANGE_REMOTE_DRIFT' || issue.code === 'CHANGE_DRIFT')).toEqual([]);
  });

  it('skips the remote check without a base ref and keeps the local check', async () => {
    project = await createTreeProject({
      tree: { drift: { baseRef: 'origin/missing' }, enforcement: { CHANGE_PLACEMENT_MISSING: 'off' } },
      specs: { 'review/drafts': specWith(X) },
      changes: { edit: { files: { 'specs/review/drafts/spec.md': `## MODIFIED Requirements\n\n${X_PRIME}\n` } } },
    });
    expect((await cli('tree', 'pin', 'edit')).exitCode).toBe(0);
    await project.write('openspec/specs/review/drafts/spec.md', specWith(Y));
    const issues = JSON.parse((await cli('validate', 'edit', '--json')).stdout).items[0].issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'CHANGE_DRIFT', level: 'ERROR' }));
    expect(issues.filter((issue: { code?: string }) => issue.code === 'CHANGE_REMOTE_DRIFT')).toEqual([]);

    await project.write('openspec/specs/review/drafts/spec.md', specWith(X));
    const clean = JSON.parse((await cli('validate', 'edit', '--json')).stdout).items[0].issues;
    expect(clean).toContainEqual(expect.objectContaining({ code: 'CHANGE_REMOTE_DRIFT', level: 'INFO', message: expect.stringContaining('skipped') }));
  });

  it('reports a migrated requirement as moved (stale path), not removed, and a merged one as drift', async () => {
    project = await createTreeProject({
      tree: { enforcement: { CHANGE_PLACEMENT_MISSING: 'off' } },
      specs: { 'review/drafts': specWith(X), 'review/other': spec('other', ['Kept']) },
      changes: {
        moved: { files: { 'specs/review/drafts/spec.md': `## MODIFIED Requirements\n\n${X_PRIME}\n` } },
      },
    });
    expect((await cli('tree', 'pin', 'moved')).exitCode).toBe(0);
    // A restructure moves the requirement to review/naming (byte-identical).
    await project.write('openspec/specs/review/naming/spec.md', specWith(X).replace('# drafts', '# naming'));
    await project.write('openspec/specs/review/drafts/spec.md', spec('drafts', ['Something else']));
    await project.write(
      'openspec/tree-redirects.yaml',
      serializeRedirects({
        version: 1,
        entries: [{ change: 'r', requirement: { from: { capability: 'review/drafts', name: 'Finalization' }, to: { capability: 'review/naming', name: 'Finalization' } } }],
      })
    );
    const drift = JSON.parse((await cli('tree', 'drift', 'moved', '--json')).stdout);
    expect(drift.changes[0].local[0]).toMatchObject({ status: 'moved', current: { capability: 'review/naming' } });
    const issues = JSON.parse((await cli('validate', 'moved', '--json')).stdout).items[0].issues;
    expect(issues.map((issue: { code?: string }) => issue.code)).toContain('CHANGE_STALE_PATH');
    expect(issues.map((issue: { code?: string }) => issue.code)).not.toContain('CHANGE_DRIFT');

    await project.write(
      'openspec/tree-redirects.yaml',
      serializeRedirects({
        version: 1,
        entries: [{ change: 'r', merged: { from: { capability: 'review/drafts', name: 'Finalization' }, into: { capability: 'review/other', name: 'Kept' } } }],
      })
    );
    const merged = JSON.parse((await cli('tree', 'drift', 'moved', '--json')).stdout);
    expect(merged.changes[0].local[0]).toMatchObject({ status: 'merged', mergedInto: { capability: 'review/other', requirement: 'Kept' } });
    await fs.rm(path.join(project.root, 'openspec/tree-redirects.yaml'));
  });
});
