import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { TreeContext } from '../../../src/core/tree/context.js';
import { defaultTreeConfig } from '../../../src/core/tree/config.js';
import { parseManifest } from '../../../src/core/tree/manifest.js';
import { planRestructure, type RestructurePlan } from '../../../src/core/tree/restructure.js';
import { createTreeProject, requirement, spec, type TreeProject } from '../../fixtures/tree/builder.js';

const NAMING_PURPOSE = 'Formal version naming rules for finalized working drafts, shared by every view.';

describe('restructure manifest simulation and conservation', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  async function plan(
    operations: unknown[],
    extra: { files?: Record<string, string>; instruction?: string; specs?: Record<string, string>; realFloor?: boolean } = {}
  ) {
    project = await createTreeProject({
      specs: extra.specs ?? {
        'review/working-draft': spec('working-draft', ['Save draft', { name: 'Save as version', scenarios: ['Custom name', 'Invalid name'] }]),
        'review/product-interface': spec('product-interface', [
          'Show toolbar',
          { name: 'Version name entry', scenarios: ['Reviewer edits a name', 'Reviewer submits an overlong name'] },
        ]),
        'review/orchestration': spec('orchestration', ['Run stages']),
      },
      changes: {
        reshape: {
          metadata: { restructure: true },
          files: {
            'restructure.yaml': stringify({ version: 1, ...(extra.instruction ? { instruction: extra.instruction } : {}), operations }),
            ...(extra.files ?? {}),
          },
        },
      },
    });
    // Fixture specs are tiny; only the floor test uses the real minimum.
    const context = new TreeContext(
      project.paths,
      extra.realFloor ? defaultTreeConfig() : defaultTreeConfig({ minSpecLines: 1, minRequirements: 1 })
    );
    return planRestructure(context, 'reshape');
  }

  const errors = (result: RestructurePlan) =>
    result.issues.filter((issue) => issue.level === 'ERROR').map((issue) => issue.code);

  it('moves capabilities and requirements byte-identically and reports no conservation issues', async () => {
    const result = await plan([
      { op: 'create-namespace', path: 'review/run' },
      { op: 'move-capability', from: 'review/orchestration', to: 'review/run/orchestration' },
      { op: 'create-capability', path: 'review/working-draft/naming', purpose: NAMING_PURPOSE },
      { op: 'move-requirement', from: 'review/working-draft', to: 'review/working-draft/naming', requirement: 'Save as version' },
    ]);
    expect(errors(result)).toEqual([]);
    const files = result.specOperations.map((op) => `${op.action} ${op.path}`);
    expect(files).toEqual([
      'write review/run/orchestration/spec.md',
      'write review/working-draft/naming/spec.md',
      'write review/working-draft/spec.md',
      'delete review/orchestration/spec.md',
    ]);
    const naming = result.specOperations.find((op) => op.path === 'review/working-draft/naming/spec.md')!.content!.toString();
    expect(naming).toContain(requirement({ name: 'Save as version', scenarios: ['Custom name', 'Invalid name'] }));
    expect(result.redirectSteps).toEqual([
      { capability: { from: 'review/orchestration', to: 'review/run/orchestration' } },
      {
        requirement: {
          from: { capability: 'review/working-draft', name: 'Save as version' },
          to: { capability: 'review/working-draft/naming', name: 'Save as version' },
        },
      },
    ]);
  });

  it('applies operations in order so a later move can depend on an earlier one (chained moves)', async () => {
    const result = await plan([
      { op: 'move-capability', from: 'review/orchestration', to: 'review/orchestrator' },
      { op: 'create-namespace', path: 'review/core' },
      { op: 'move-capability', from: 'review/orchestrator', to: 'review/core/orchestrator' },
    ]);
    expect(errors(result)).toEqual([]);
    expect(result.specOperations.map((op) => `${op.action} ${op.path}`)).toEqual([
      'write review/core/orchestrator/spec.md',
      'delete review/orchestration/spec.md',
    ]);
  });

  it.each([
    ['create-namespace on an existing path', [{ op: 'create-namespace', path: 'review/orchestration' }], /path already exists/],
    ['create-namespace without parent', [{ op: 'create-namespace', path: 'nowhere/deep' }], /parent nowhere does not exist/],
    ['create-capability with a short purpose', [{ op: 'create-capability', path: 'review/x', purpose: 'too short' }], /at least 50/],
    ['move-capability of a missing node', [{ op: 'move-capability', from: 'review/missing', to: 'review/y' }], /does not exist/],
    ['move-capability onto an existing node', [{ op: 'move-capability', from: 'review/orchestration', to: 'review/working-draft' }], /already exists/],
    ['move-capability into its own subtree', [{ op: 'move-capability', from: 'review', to: 'review/inner' }], /own subtree/],
    ['move-requirement that is absent', [{ op: 'move-requirement', from: 'review/working-draft', to: 'review/orchestration', requirement: 'Nope' }], /0 requirements named "Nope"/],
    ['move-requirement onto an existing name', [{ op: 'move-requirement', from: 'review/working-draft', to: 'review/working-draft', requirement: 'Save draft', renameTo: 'save AS version' }], /already has a requirement/],
    ['retire-capability that still has requirements', [{ op: 'retire-capability', path: 'review/orchestration' }], /still has 1 requirement/],
    ['merge-requirement with a missing keep', [{ op: 'merge-requirement', keep: { capability: 'review/working-draft', requirement: 'Nope' }, drop: { capability: 'review/product-interface', requirement: 'Version name entry' } }], /0 requirements named "Nope"/],
  ])('rejects %s and stops', async (_label, operations, message) => {
    const result = await plan(operations);
    const precondition = result.issues.find((issue) => issue.code === 'RESTRUCTURE_PRECONDITION');
    expect(precondition?.message).toMatch(message);
    expect(result.specOperations).toEqual([]);
  });

  it('rejects a move-capability that only works if the operations run in a different order', async () => {
    const result = await plan([
      { op: 'move-capability', from: 'review/orchestration', to: 'review/run/orchestration' },
      { op: 'create-namespace', path: 'review/run' },
    ]);
    expect(result.issues[0]).toMatchObject({ code: 'RESTRUCTURE_PRECONDITION', message: expect.stringMatching(/^Operation 1 .*parent review\/run does not exist/) });
  });

  it('retires a capability once every requirement has moved out', async () => {
    const result = await plan([
      { op: 'move-requirement', from: 'review/orchestration', to: 'review/working-draft', requirement: 'Run stages' },
      { op: 'retire-capability', path: 'review/orchestration' },
    ]);
    expect(errors(result)).toEqual([]);
    expect(result.specOperations.filter((op) => op.action === 'delete').map((op) => op.path)).toEqual(['review/orchestration/spec.md']);
  });

  it('rejects ADDED/REMOVED deltas and smuggled MODIFIED text in a restructure change', async () => {
    const smuggled = await plan(
      [{ op: 'move-capability', from: 'review/orchestration', to: 'review/orchestrator' }],
      {
        files: {
          'specs/review/orchestrator/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'Run stages', text: 'The system SHALL run stages twice.' })}\n`,
        },
      }
    );
    expect(smuggled.issues).toContainEqual(
      expect.objectContaining({ code: 'CONSERVATION_UNDECLARED_CHANGE', message: expect.stringMatching(/only rewrite a requirement it keeps/) })
    );

    const added = await plan([{ op: 'move-capability', from: 'review/orchestration', to: 'review/orchestrator' }], {
      files: { 'specs/review/orchestrator/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'New thing' })}\n` },
    });
    expect(errors(added)).toContain('RESTRUCTURE_FORBIDDEN_DELTA');
  });

  it('merges a duplicate requirement only when every dropped scenario is mapped onto the kept one', async () => {
    const keepModified = `## MODIFIED Requirements\n\n${requirement({
      name: 'Save as version',
      text: 'The system SHALL preserve the entered display name and reject invalid names.',
      scenarios: ['Custom name', 'Invalid name', 'Overlong name'],
    })}\n`;
    const merge = (scenarios: Record<string, string>) => ({
      op: 'merge-requirement',
      keep: { capability: 'review/working-draft', requirement: 'Save as version' },
      drop: { capability: 'review/product-interface', requirement: 'Version name entry' },
      scenarios,
    });

    const unmapped = await plan([merge({ 'Reviewer edits a name': 'Custom name' })], {
      files: { 'specs/review/working-draft/spec.md': keepModified },
    });
    expect(unmapped.issues).toContainEqual(
      expect.objectContaining({ code: 'CONSERVATION_UNMAPPED_SCENARIO', message: expect.stringContaining('Reviewer submits an overlong name') })
    );

    const missingTarget = await plan([merge({ 'Reviewer edits a name': 'Custom name', 'Reviewer submits an overlong name': 'Overlong name' })]);
    expect(missingTarget.issues).toContainEqual(
      expect.objectContaining({ code: 'CONSERVATION_UNMAPPED_SCENARIO', message: expect.stringContaining('maps to "Overlong name"') })
    );

    const complete = await plan(
      [merge({ 'Reviewer edits a name': 'Custom name', 'Reviewer submits an overlong name': 'Overlong name' })],
      { files: { 'specs/review/working-draft/spec.md': keepModified } }
    );
    expect(errors(complete)).toEqual([]);
    expect(complete.redirectSteps).toEqual([
      {
        merged: {
          from: { capability: 'review/product-interface', name: 'Version name entry' },
          into: { capability: 'review/working-draft', name: 'Save as version' },
        },
      },
    ]);
  });

  it('refuses a split that leaves a created or shrunk capability below the floor', async () => {
    // Specs from the fixture are a handful of lines each, so only the requirement count can clear the floor.
    const big = spec('big', ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1']);
    const tooFine = await plan(
      [
        { op: 'create-capability', path: 'review/big/b', purpose: NAMING_PURPOSE },
        { op: 'move-requirement', from: 'review/big', to: 'review/big/b', requirement: 'B1' },
        { op: 'move-requirement', from: 'review/big', to: 'review/big/b', requirement: 'B2' },
      ],
      { specs: { 'review/big': big }, realFloor: true }
    );
    expect(tooFine.issues.filter((issue) => issue.code === 'RESTRUCTURE_TOO_GRANULAR').map((issue) => issue.path)).toEqual(['review/big/b']);

    const parentLeftThin = await plan(
      [
        { op: 'create-capability', path: 'review/big/rest', purpose: NAMING_PURPOSE },
        ...['A1', 'A2', 'A3', 'B1', 'B2'].map((requirement) => ({ op: 'move-requirement', from: 'review/big', to: 'review/big/rest', requirement })),
      ],
      { specs: { 'review/big': big }, realFloor: true }
    );
    expect(parentLeftThin.issues.filter((issue) => issue.code === 'RESTRUCTURE_TOO_GRANULAR').map((issue) => issue.path)).toEqual(['review/big']);

    const ok = await plan(
      [
        { op: 'create-capability', path: 'review/big/b', purpose: NAMING_PURPOSE },
        ...['B1', 'B2', 'B3'].map((requirement) => ({ op: 'move-requirement', from: 'review/big', to: 'review/big/b', requirement })),
      ],
      { specs: { 'review/big': big }, realFloor: true }
    );
    expect(ok.issues.filter((issue) => issue.level === 'ERROR')).toEqual([]);
  });

  it('refuses operations the named instruction does not allow', async () => {
    const result = await plan([{ op: 'move-requirement', from: 'review/working-draft', to: 'review/orchestration', requirement: 'Save draft' }], {
      instruction: 'split:review',
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'RESTRUCTURE_OP_NOT_ALLOWED' }));
  });

  it('reports structural findings of the restructured tree for the nodes it touched', async () => {
    const result = await plan([{ op: 'create-namespace', path: 'review/empty-group' }]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'TREE_EMPTY_NODE', path: 'review/empty-group', level: 'ERROR' }));
  });

  it('parses manifests strictly', () => {
    expect(() => parseManifest('version: 1\noperations:\n  - op: teleport\n')).toThrow(/Invalid restructure.yaml/);
    expect(() => parseManifest('version: 1\noperations:\n  - op: move-capability\n    from: a\n    to: ../b\n')).toThrow(/capability path/);
    expect(parseManifest('version: 1\noperations: []\n')).toEqual({ version: 1, operations: [] });
  });
});
