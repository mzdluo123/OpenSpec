import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { defaultTreeConfig } from '../../../src/core/tree/config.js';
import { TreeContext } from '../../../src/core/tree/context.js';
import { runTreeChangeRules } from '../../../src/core/tree/change-rules.js';
import {
  extractRequirementEntries,
  insertEntries,
  rewriteChangeTree,
} from '../../../src/core/tree/inflight-rewrite.js';
import {
  movedAwayDestinations,
  resolveCapability,
  resolveRequirement,
  serializeRedirects,
  type RedirectEntry,
} from '../../../src/core/tree/redirects.js';
import { parseDeltaSpec } from '../../../src/core/parsers/requirement-blocks.js';
import { createTreeProject, requirement, spec, type TreeProject } from '../../fixtures/tree/builder.js';
import { runCLI } from '../../helpers/run-cli.js';

const redirects = (entries: RedirectEntry[]) => ({ version: 1 as const, entries });

describe('tree redirects', () => {
  it('folds chains in archive order and survives a later move back', () => {
    const chain = redirects([
      { change: 'c1', capability: { from: 'a', to: 'b' } },
      { change: 'c2', capability: { from: 'b', to: 'c' } },
    ]);
    expect(resolveCapability(chain, 'a')).toEqual({ capability: 'c', moved: true, cycle: false });
    expect(resolveCapability(chain, 'a/child')).toMatchObject({ capability: 'c/child', moved: true });

    const back = redirects([
      { change: 'c1', capability: { from: 'a', to: 'b' } },
      { change: 'c2', capability: { from: 'b', to: 'a' } },
    ]);
    expect(resolveCapability(back, 'a')).toEqual({ capability: 'a', moved: false, cycle: true });
  });

  it('follows requirement moves through later capability moves and reports merges', () => {
    const table = redirects([
      { change: 'c1', requirement: { from: { capability: 'a', name: 'R' }, to: { capability: 'b', name: 'R2' } } },
      { change: 'c2', capability: { from: 'b', to: 'g/b' } },
      { change: 'c3', merged: { from: { capability: 'x', name: 'Dup' }, into: { capability: 'g/b', name: 'R2' } } },
    ]);
    expect(resolveRequirement(table, 'a', 'r')).toMatchObject({ kind: 'moved', capability: 'g/b', name: 'R2' });
    expect(resolveRequirement(table, 'x', 'Dup')).toMatchObject({ kind: 'merged', capability: 'g/b', name: 'R2', mergedFrom: { capability: 'x', name: 'Dup' } });
    expect(resolveRequirement(table, 'a', 'Other')).toMatchObject({ kind: 'unchanged' });
    expect(movedAwayDestinations(table, 'a')).toEqual(['b']);
  });
});

describe('in-flight delta rewriting', () => {
  const delta = [
    '## MODIFIED Requirements',
    '',
    requirement({ name: 'Keep', text: 'The system SHALL keep.' }),
    '',
    requirement({ name: 'Move me', text: 'The system SHALL move.' }),
    '',
    '## REMOVED Requirements',
    '',
    '- `### Requirement: Move me too`',
    '',
    '## RENAMED Requirements',
    '',
    '- FROM: `### Requirement: Old`',
    '- TO: `### Requirement: New`',
    '',
  ].join('\n');

  it('extracts one requirement\'s entries and leaves the rest intact', () => {
    const { content, entries } = extractRequirementEntries(delta, 'Move me');
    expect(entries.modified).toEqual([requirement({ name: 'Move me', text: 'The system SHALL move.' })]);
    const plan = parseDeltaSpec(content);
    expect(plan.modified.map((block) => block.name)).toEqual(['Keep']);
    expect(plan.removed).toEqual(['Move me too']);
    expect(plan.renamed).toEqual([{ from: 'Old', to: 'New' }]);
  });

  it('moves a RENAMED pair together with the MODIFIED block of its new name', () => {
    const { entries } = extractRequirementEntries(delta.replace('### Requirement: Keep', '### Requirement: New'), 'Old');
    expect(entries.renamed).toHaveLength(1);
    expect(entries.modified.map((block) => block.split('\n')[0])).toEqual(['### Requirement: New']);
  });

  it('drops a section that becomes empty and appends into existing sections of the target', () => {
    const { content } = extractRequirementEntries(delta, 'Move me too');
    expect(content).not.toContain('## REMOVED Requirements');
    const target = insertEntries(`## ADDED Requirements\n\n${requirement({ name: 'Fresh' })}\n`, {
      modified: [requirement({ name: 'Move me' })],
      removed: ['- `### Requirement: Gone`'],
      renamed: [],
    });
    const plan = parseDeltaSpec(target);
    expect(plan.added.map((block) => block.name)).toEqual(['Fresh']);
    expect(plan.modified.map((block) => block.name)).toEqual(['Move me']);
    expect(plan.removed).toEqual(['Gone']);
  });

  it('rewrites delta files, bases and conflicts for every manifest step', () => {
    const tree = {
      files: new Map([
        ['a/spec.md', Buffer.from(delta)],
        ['dup/spec.md', Buffer.from(`## MODIFIED Requirements\n\n${requirement({ name: 'Dup' })}\n`)],
        ['old/spec.md', Buffer.from(`## ADDED Requirements\n\n${requirement({ name: 'Added' })}\n`)],
      ]),
      dirs: new Set(['a', 'dup', 'old']),
    };
    const bases = {
      version: 1 as const,
      entries: [
        { capability: 'a', requirement: 'Move me', ops: ['MODIFIED' as const], sha256: 'f'.repeat(64), text: 't', pinnedAt: '2026-01-01', source: 'worktree' as const, previous: null },
      ],
    };
    const result = rewriteChangeTree('other', tree, bases, [
      { kind: 'move-requirement', from: 'a', to: 'b', name: 'Move me', renameTo: 'Moved' },
      { kind: 'move-capability', from: 'old', to: 'new' },
      { kind: 'merge', drop: { capability: 'dup', name: 'Dup' }, keep: { capability: 'a', name: 'Keep' } },
      { kind: 'retire', capability: 'new' },
    ]);
    expect(parseDeltaSpec(result.tree.files.get('b/spec.md')!.toString()).modified.map((block) => block.name)).toEqual(['Moved']);
    expect(result.tree.files.has('new/spec.md')).toBe(true);
    expect(result.tree.files.has('old/spec.md')).toBe(false);
    expect(result.bases?.entries[0]).toMatchObject({ capability: 'b', requirement: 'Moved', sha256: 'f'.repeat(64) });
    expect(result.conflicts.map((conflict) => conflict.reason)).toEqual([
      expect.stringContaining('merged into a#Keep'),
      expect.stringContaining('retires'),
    ]);
  });
});

describe('CHANGE_STALE_PATH and tree rebase', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  it('rejects ADDED to a migrated path, rebases it, and the rebased change validates', async () => {
    project = await createTreeProject({
      tree: { enforcement: { CHANGE_PLACEMENT_MISSING: 'off', CHANGE_BASE_UNPINNED: 'off' } },
      specs: { 'review/working-draft': spec('working-draft', ['Save draft']) },
      changes: {
        stale: {
          files: {
            'specs/review-working-draft/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'Durable names' })}\n`,
          },
        },
      },
      extra: {
        'openspec/tree-redirects.yaml': serializeRedirects(
          redirects([{ change: 'git:abc', capability: { from: 'review-working-draft', to: 'review/working-draft' } }])
        ),
      },
    });
    const context = () => new TreeContext(project!.paths, defaultTreeConfig({ enforcement: { ...defaultTreeConfig().enforcement, CHANGE_PLACEMENT_MISSING: 'off' } }));
    const before = await runTreeChangeRules(context(), 'stale');
    expect(before).toContainEqual(expect.objectContaining({ code: 'CHANGE_STALE_PATH', level: 'ERROR', message: expect.stringContaining('openspec tree rebase stale') }));

    const strict = await runCLI(['validate', 'stale', '--strict', '--json'], { cwd: project.root });
    expect(strict.exitCode).toBe(1);

    const rebase = await runCLI(['tree', 'rebase', 'stale', '--json'], { cwd: project.root });
    expect(rebase.exitCode).toBe(0);
    expect(JSON.parse(rebase.stdout)).toMatchObject({ rebased: true, moves: ['specs/review-working-draft -> specs/review/working-draft'] });
    await expect(fs.access(path.join(project.paths.changesDir, 'stale/specs/review/working-draft/spec.md'))).resolves.toBeUndefined();

    expect((await runTreeChangeRules(context(), 'stale')).filter((issue) => issue.code === 'CHANGE_STALE_PATH')).toEqual([]);
    const after = await runCLI(['validate', 'stale', '--strict', '--json'], { cwd: project.root });
    expect(after.exitCode).toBe(0);
  });

  it('refuses to rebase a change aimed at a merged requirement', async () => {
    project = await createTreeProject({
      specs: { keep: spec('keep', ['Kept']), drop: spec('drop', ['Other']) },
      changes: {
        late: { files: { 'specs/drop/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'Dup' })}\n` } },
      },
      extra: {
        'openspec/tree-redirects.yaml': serializeRedirects(
          redirects([{ change: 'c', merged: { from: { capability: 'drop', name: 'Dup' }, into: { capability: 'keep', name: 'Kept' } } }])
        ),
      },
    });
    const result = await runCLI(['tree', 'rebase', 'late', '--json'], { cwd: project.root });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).conflicts[0].reason).toContain('merged into keep#Kept');
  });
});
