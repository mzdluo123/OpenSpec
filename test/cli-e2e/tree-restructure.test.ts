import { promises as fs } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { createTreeProject, requirement, spec, type TreeProject } from '../fixtures/tree/builder.js';
import { runCLI } from '../helpers/run-cli.js';

const NAMING_PURPOSE = 'Formal version naming rules for finalized working drafts, shared by every view.';

describe('restructure changes end to end', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  const cli = (...args: string[]) => runCLI(args, { cwd: project!.root });

  async function setup() {
    project = await createTreeProject({
      tree: { maxChildren: 3, minSpecLines: 1, minRequirements: 1, enforcement: { CHANGE_PLACEMENT_MISSING: 'off' } },
      specs: {
        'review/working-draft': spec('working-draft', ['Save draft', { name: 'Save as version', scenarios: ['Custom name'] }]),
        'review/orchestration': spec('orchestration', ['Run stages']),
        'review/publish': spec('publish', ['Publish results']),
        'review/retry': spec('retry', ['Retry stage']),
      },
      changes: {
        'tweak-naming': {
          files: {
            'specs/review/working-draft/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'Save as version', text: 'The system SHALL keep the entered name verbatim.', scenarios: ['Custom name'] })}\n`,
          },
        },
        'extend-orchestration': {
          files: { 'specs/review/orchestration/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'Parallel stages' })}\n` },
        },
      },
    });
    expect((await cli('tree', 'pin', '--all')).exitCode).toBe(0);
    const created = await cli('new', 'change', 'split-review', '--restructure', '--json');
    expect(created.exitCode).toBe(0);
    expect(parse(await project.read('openspec/changes/split-review/.openspec.yaml'))).toMatchObject({ restructure: true });
    await project.write(
      'openspec/changes/split-review/restructure.yaml',
      stringify({
        version: 1,
        instruction: 'split:review',
        operations: [
          { op: 'create-namespace', path: 'review/run' },
          { op: 'move-capability', from: 'review/orchestration', to: 'review/run/orchestration' },
          { op: 'move-capability', from: 'review/retry', to: 'review/run/retry' },
        ],
      })
    );
  }

  it('follows the SPLIT instruction, validates strictly, plans, archives and rewrites in-flight changes', async () => {
    await setup();
    const instructions = JSON.parse((await cli('tree', 'instructions', '--op', 'SPLIT', '--json')).stdout).instructions;
    expect(instructions).toContainEqual(
      expect.objectContaining({ id: 'split:review', allowedManifestOps: ['create-namespace', 'move-capability'] })
    );

    const validation = await cli('validate', 'split-review', '--strict', '--json');
    expect(JSON.parse(validation.stdout).items[0]).toMatchObject({ valid: true });

    const plan = JSON.parse((await cli('tree', 'plan', 'split-review', '--json')).stdout);
    expect(plan).toMatchObject({ valid: true, conflicts: [] });
    expect(plan.inflight).toContainEqual(expect.objectContaining({ change: 'extend-orchestration', notes: ['specs/review/orchestration -> specs/review/run/orchestration'] }));
    expect(await project!.exists('openspec/specs/review/run/orchestration/spec.md')).toBe(false);

    const archived = await cli('archive', 'split-review', '--yes', '--json');
    expect(archived.exitCode).toBe(0);
    const result = JSON.parse(archived.stdout).archive;
    expect(result.restructure).toMatchObject({ operations: 3, rewrittenChanges: ['extend-orchestration'], redirectsAppended: 2 });

    expect(await project!.read('openspec/specs/review/run/orchestration/spec.md')).toBe(spec('orchestration', ['Run stages']));
    expect(await project!.exists('openspec/specs/review/orchestration')).toBe(false);
    expect(await project!.exists('openspec/changes/extend-orchestration/specs/review/run/orchestration/spec.md')).toBe(true);
    expect(parse(await project!.read('openspec/tree-redirects.yaml')).entries).toEqual([
      { change: result.archivedAs, capability: { from: 'review/orchestration', to: 'review/run/orchestration' } },
      { change: result.archivedAs, capability: { from: 'review/retry', to: 'review/run/retry' } },
    ]);

    const check = JSON.parse((await cli('tree', 'check', '--scope', 'review', '--json')).stdout);
    expect(check.findings.filter((finding: { code: string }) => finding.code === 'TREE_FANOUT')).toEqual([]);

    // The rewritten in-flight change still validates strictly and archives into the new path.
    expect(JSON.parse((await cli('validate', 'extend-orchestration', '--strict', '--json')).stdout).items[0].valid).toBe(true);
    expect((await cli('archive', 'extend-orchestration', '--yes', '--json')).exitCode).toBe(0);
    expect(await project!.read('openspec/specs/review/run/orchestration/spec.md')).toContain('### Requirement: Parallel stages');
    expect(await project!.exists('openspec/specs/review/orchestration/spec.md')).toBe(false);
  });

  it('refuses to archive while another change targets a requirement the restructure merges away', async () => {
    await setup();
    await project!.write(
      'openspec/changes/split-review/restructure.yaml',
      stringify({
        version: 1,
        operations: [
          { op: 'create-capability', path: 'review/naming', purpose: NAMING_PURPOSE },
          { op: 'move-requirement', from: 'review/publish', to: 'review/naming', requirement: 'Publish results' },
          { op: 'retire-capability', path: 'review/publish' },
          {
            op: 'merge-requirement',
            keep: { capability: 'review/naming', requirement: 'Publish results' },
            drop: { capability: 'review/working-draft', requirement: 'Save as version' },
            scenarios: { 'Custom name': 'Publish results works' },
          },
        ],
      })
    );
    const before = await project!.snapshot();
    const archived = await cli('archive', 'split-review', '--yes', '--json');
    expect(archived.exitCode).toBe(1);
    expect(JSON.parse(archived.stdout).status[0]).toMatchObject({
      code: 'RESTRUCTURE_INFLIGHT_CONFLICT',
      message: expect.stringContaining('tweak-naming'),
    });
    expect(await project!.snapshot()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rolls every file back when a write fails mid-archive',
    async () => {
      await setup();
      const before = await project!.snapshot();
      // Main specs are written first, then the in-flight rewrite. A read-only
      // delta directory makes the rewrite fail after the specs were written.
      const locked = path.join(project!.paths.changesDir, 'extend-orchestration/specs/review');
      await fs.chmod(locked, 0o555);
      let archived;
      try {
        archived = await cli('archive', 'split-review', '--yes', '--json');
      } finally {
        await fs.chmod(locked, 0o755);
      }
      expect(archived.exitCode).toBe(1);
      expect(JSON.parse(archived.stdout).status[0].message).toMatch(/EACCES|permission/i);
      expect(await project!.snapshot()).toEqual(before);
    }
  );

  it('records a REVIEW in tree-state.yaml when a review instruction is archived', async () => {
    await setup();
    await project!.write(
      'openspec/changes/split-review/restructure.yaml',
      stringify({
        version: 1,
        instruction: 'review:review',
        operations: [{ op: 'move-requirement', from: 'review/retry', to: 'review/orchestration', requirement: 'Retry stage' }, { op: 'retire-capability', path: 'review/retry' }],
      })
    );
    expect((await cli('archive', 'split-review', '--yes', '--json')).exitCode).toBe(0);
    expect(parse(await project!.read('openspec/tree-state.yaml')).reviews).toEqual([
      expect.objectContaining({ node: 'review', change: expect.stringMatching(/split-review$/) }),
    ]);
  });
});

describe('placement (PLACE)', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  it('requires a placement entry that names every reviewed neighbour and respects fanout', async () => {
    project = await createTreeProject({
      tree: { maxChildren: 3, enforcement: { CHANGE_PLACEMENT_MISSING: 'error' } },
      specs: {
        review: spec('review', ['Shared rule']),
        'review/working-draft': spec('working-draft', ['Save draft']),
        'review/product-interface': spec('product-interface', ['Toolbar']),
        'review/publish': spec('publish', ['Publish']),
      },
      changes: {
        'add-naming': {
          files: { 'specs/review/working-draft/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'Durable names' })}\n` },
        },
      },
    });
    const validate = async () => JSON.parse((await runCLI(['validate', 'add-naming', '--json'], { cwd: project!.root })).stdout).items[0];

    const missing = await validate();
    expect(missing.valid).toBe(false);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'CHANGE_PLACEMENT_MISSING', message: expect.stringContaining('has no placement entry') }));

    const place = async (entry: Record<string, unknown>) =>
      project!.write('openspec/changes/add-naming/.openspec.yaml', stringify({ schema: 'spec-driven', placement: [{ requirement: 'Durable names', rationale: 'naming belongs to drafts', ...entry }] }));

    await place({ capability: 'review/working-draft', decision: 'existing-capability', reviewed: ['review/working-draft'] });
    const partial = await validate();
    expect(partial.issues).toContainEqual(
      expect.objectContaining({ code: 'CHANGE_PLACEMENT_MISSING', message: expect.stringContaining('missing: review, review/product-interface, review/publish') })
    );

    await place({ capability: 'review/working-draft', decision: 'existing-capability', reviewed: ['review', 'review/working-draft', 'review/product-interface', 'review/publish'] });
    expect((await validate()).valid).toBe(true);

    await project.write('openspec/changes/add-naming/specs/review/naming/spec.md', `## ADDED Requirements\n\n${requirement({ name: 'Naming rule' })}\n`);
    await project.write(
      'openspec/changes/add-naming/.openspec.yaml',
      stringify({
        schema: 'spec-driven',
        placement: [
          { requirement: 'Durable names', capability: 'review/working-draft', decision: 'existing-capability', reviewed: ['review', 'review/working-draft', 'review/product-interface', 'review/publish'], rationale: 'r' },
          { requirement: 'Naming rule', capability: 'review/naming', decision: 'new-capability', reviewed: ['review', 'review/working-draft', 'review/product-interface', 'review/publish'], rationale: 'r' },
        ],
      })
    );
    const fanout = await validate();
    expect(fanout.issues).toContainEqual(expect.objectContaining({ code: 'TREE_FANOUT', message: expect.stringContaining('4 children (limit 3)') }));
    expect(fanout.issues).toContainEqual(
      expect.objectContaining({ code: 'TREE_SPEC_TOO_GRANULAR', level: 'WARNING', path: 'review/naming/spec.md' })
    );
  });

  it('replays align-review-finalize-with-prototype: stale flat path, missing placement, then MODIFIED of the existing requirement', async () => {
    project = await createTreeProject({
      tree: { enforcement: { CHANGE_PLACEMENT_MISSING: 'error' } },
      specs: {
        'contract-review/working-draft': spec('working-draft', ['CAS save advances revision', 'Save as version keeps draft editable']),
        'contract-review/product-interface': spec('product-interface', ['Product routes host the complete design']),
      },
      changes: {
        'align-review-finalize-with-prototype': {
          files: {
            'specs/contract-review-working-draft/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'Formal version names are validated and durable' })}\n`,
          },
        },
      },
      extra: {
        'openspec/tree-redirects.yaml': stringify({
          version: 1,
          entries: [{ change: 'git:4c1d', capability: { from: 'contract-review-working-draft', to: 'contract-review/working-draft' } }],
        }),
      },
    });
    const change = 'align-review-finalize-with-prototype';
    const validate = async () => JSON.parse((await runCLI(['validate', change, '--strict', '--json'], { cwd: project!.root })).stdout).items[0];
    const codes = (item: { issues: Array<{ code?: string; level: string }> }) =>
      item.issues.filter((issue) => issue.code && issue.level === 'ERROR').map((issue) => issue.code);

    expect(codes(await validate())).toEqual(['CHANGE_STALE_PATH', 'CHANGE_PLACEMENT_MISSING']);
    expect((await runCLI(['tree', 'rebase', change], { cwd: project.root })).exitCode).toBe(0);
    expect(codes(await validate())).toEqual(['CHANGE_PLACEMENT_MISSING']);

    // tree context shows the fact already lives in "Save as version keeps draft editable":
    const context = JSON.parse((await runCLI(['tree', 'context', 'contract-review/working-draft', '--json'], { cwd: project.root })).stdout);
    expect(context.target.requirements).toContain('Save as version keeps draft editable');
    // so the author MODIFIES that requirement instead of adding a second definition.
    await project.write(
      `openspec/changes/${change}/specs/contract-review/working-draft/spec.md`,
      `## MODIFIED Requirements\n\n${requirement({
        name: 'Save as version keeps draft editable',
        text: 'The system SHALL keep the draft editable and validate formal version names durably.',
        scenarios: ['Save as version keeps draft editable works', 'Invalid name is rejected'],
      })}\n`
    );
    expect((await runCLI(['tree', 'pin', change], { cwd: project.root })).exitCode).toBe(0);
    const fixed = await validate();
    expect(fixed.valid).toBe(true);
    expect(codes(fixed)).toEqual([]);
  });

  it('returns the neighbours an agent must read via tree context', async () => {
    project = await createTreeProject({
      specs: { review: spec('review', ['Shared rule']), 'review/a': spec('a', ['A1']), 'review/b': spec('b', ['B1']) },
      changes: { touch: { files: { 'specs/review/b/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'B1' })}\n` } } },
    });
    const context = JSON.parse((await runCLI(['tree', 'context', 'review/c', '--json'], { cwd: project.root })).stdout);
    expect(context).toMatchObject({
      path: 'review/c',
      exists: false,
      parent: { path: 'review', requirements: ['Shared rule'] },
      siblings: [{ path: 'review/a', requirements: ['A1'] }, { path: 'review/b', requirements: ['B1'] }],
      openChanges: [{ change: 'touch', capabilities: ['review/b'] }],
    });
  });

  it('leaves validate and archive untouched when tree governance is off', async () => {
    project = await createTreeProject({
      tree: false,
      specs: { review: spec('review', ['Shared rule']) },
      changes: { plain: { files: { 'specs/review/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'New rule' })}\n` } } },
    });
    const report = JSON.parse((await runCLI(['validate', 'plain', '--strict', '--json'], { cwd: project.root })).stdout);
    expect(report.items[0].issues.filter((issue: { code?: string }) => issue.code)).toEqual([]);
    const check = await runCLI(['tree', 'check', '--json'], { cwd: project.root });
    expect(check.exitCode).toBe(1);
    expect(JSON.parse(check.stdout).status[0].code).toBe('TREE_NOT_ENABLED');
    expect((await runCLI(['archive', 'plain', '--yes', '--json'], { cwd: project.root })).exitCode).toBe(0);
  });
});
