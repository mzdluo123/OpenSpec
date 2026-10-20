import { afterEach, describe, expect, it } from 'vitest';
import { defaultTreeConfig, parseTreeConfig } from '../../../src/core/tree/config.js';
import { buildInventoryFromContents, buildTreeInventory } from '../../../src/core/tree/inventory.js';
import { runTreeRules } from '../../../src/core/tree/rules.js';
import { createTreeProject, spec, type TreeProject } from '../../fixtures/tree/builder.js';

const config = defaultTreeConfig();

function specOfLines(lines: number): string {
  const head = spec('long', ['Only requirement']);
  const filler = Array.from({ length: lines - head.split('\n').length + 1 }, (_, index) => `Note ${index}.`);
  // Filler goes into Purpose so the requirement count stays at one.
  return head.replace('## Requirements', `${filler.join('\n')}\n## Requirements`);
}

function inventoryOf(specs: Record<string, string>, dirs: string[] = []) {
  return buildInventoryFromContents('/specs', new Map(Object.entries(specs)), dirs);
}

describe('tree structural rules', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  it('flags fanout only above maxChildren (20 passes, 21 fails)', () => {
    const children = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`domain/c${String(i).padStart(2, '0')}`, spec(`c${i}`, ['R'])]));
    const at = runTreeRules({ inventory: inventoryOf(children(20)), config }).filter((f) => f.code === 'TREE_FANOUT');
    const over = runTreeRules({ inventory: inventoryOf(children(21)), config }).filter((f) => f.code === 'TREE_FANOUT');
    expect(at).toEqual([]);
    expect(over).toMatchObject([{ node: 'domain', actual: 21, limit: 20, level: 'warning' }]);
  });

  it('flags spec length only above maxSpecLines (300 passes, 301 fails)', () => {
    const exactly = specOfLines(300);
    const above = specOfLines(301);
    expect(exactly.split('\n').length - 1).toBe(300);
    expect(runTreeRules({ inventory: inventoryOf({ a: exactly }), config }).some((f) => f.code === 'TREE_SPEC_TOO_LONG')).toBe(false);
    expect(runTreeRules({ inventory: inventoryOf({ a: above }), config })).toContainEqual(
      expect.objectContaining({ code: 'TREE_SPEC_TOO_LONG', node: 'a', actual: 301, limit: 300 })
    );
  });

  it('flags requirement count above maxRequirements independently of length', () => {
    const many = spec('many', Array.from({ length: 16 }, (_, i) => `Requirement ${i}`));
    const findings = runTreeRules({ inventory: inventoryOf({ many }), config });
    expect(findings).toContainEqual(expect.objectContaining({ code: 'TREE_SPEC_TOO_LONG', actual: 16, limit: 15 }));
  });

  it('lets a parent capability coexist with child capabilities without an empty-node finding', async () => {
    project = await createTreeProject({
      specs: {
        'review/working-draft': spec('working-draft', ['Shared naming']),
        'review/working-draft/naming': spec('naming', ['Name rule']),
      },
    });
    const inventory = await buildTreeInventory(project.paths.specsDir);
    expect(inventory.nodes.get('review/working-draft')).toMatchObject({ hasSpec: true, children: ['review/working-draft/naming'] });
    const findings = runTreeRules({ inventory, config });
    expect(findings.filter((f) => f.code === 'TREE_EMPTY_NODE')).toEqual([]);
  });

  it('reports empty directories as errors and excessive depth as warnings', async () => {
    project = await createTreeProject({ specs: { 'a/b/c/d/e': spec('e', ['R']) } });
    await project.write('openspec/specs/empty/.keep', '');
    const findings = runTreeRules({ inventory: await buildTreeInventory(project.paths.specsDir), config });
    expect(findings).toContainEqual(expect.objectContaining({ code: 'TREE_EMPTY_NODE', node: 'empty', level: 'error' }));
    expect(findings).toContainEqual(expect.objectContaining({ code: 'TREE_DEPTH', node: 'a/b/c/d/e', actual: 5 }));
  });

  it('only marks short specs as merge candidates when a sibling capability exists', () => {
    const findings = runTreeRules({ inventory: inventoryOf({ 'd/alone': spec('alone', ['R']), 'e/x': spec('x', ['R']), 'e/y': spec('y', ['R']) }), config });
    const short = findings.filter((f) => f.code === 'TREE_SPEC_TOO_SHORT').map((f) => f.node);
    expect(short).toEqual(['e/x', 'e/y']);
    expect(findings.find((f) => f.code === 'TREE_SPEC_TOO_SHORT')?.level).toBe('info');
  });

  it('filters by --scope and caps out-of-scope errors at warning', () => {
    const inventory = inventoryOf({ 'a/x': spec('x', ['R']), 'b/y': spec('y', ['R']) }, ['a/empty', 'b/empty']);
    const scoped = runTreeRules({ inventory, config }, { scope: 'a' });
    expect(scoped.every((f) => f.node === 'a' || f.node.startsWith('a/'))).toBe(true);

    const { config: batched } = parseTreeConfig({ enabled: true, scope: ['a'] });
    const levels = Object.fromEntries(
      runTreeRules({ inventory, config: batched! })
        .filter((f) => f.code === 'TREE_EMPTY_NODE')
        .map((f) => [f.node, f.level])
    );
    expect(levels).toEqual({ 'a/empty': 'error', 'b/empty': 'warning' });
  });

  it('turns a rule off entirely with enforcement off', () => {
    const { config: off } = parseTreeConfig({ enabled: true, enforcement: { TREE_EMPTY_NODE: 'off' } });
    const inventory = inventoryOf({ 'a/x': spec('x', ['R']) }, ['a/empty']);
    expect(runTreeRules({ inventory, config: off! }).some((f) => f.code === 'TREE_EMPTY_NODE')).toBe(false);
  });

  it('reports a subtree for review after reviewAfterArchives archives since its last review', () => {
    const inventory = inventoryOf({ 'a/x': spec('x', ['R']), 'a/y': spec('y', ['R']), 'b/z': spec('z', ['R']) });
    const archives = (count: number, date: string) =>
      Array.from({ length: count }, (_, i) => ({ name: `${date}-c${i}`, date, capabilities: ['a/x'] }));
    const review = (state: { node: string; reviewedAt: string }[]) =>
      runTreeRules({
        inventory,
        config: { ...config, reviewAfterArchives: 3 },
        archives: [...archives(2, '2026-01-01'), ...archives(2, '2026-03-01')],
        state: { version: 1, reviews: state.map((entry) => ({ ...entry, change: 'r' })) },
      }).filter((f) => f.code === 'TREE_REVIEW_DUE');

    expect(review([])).toMatchObject([{ node: 'a', actual: 4, level: 'info' }]);
    expect(review([{ node: 'a', reviewedAt: '2026-02-01' }])).toEqual([]);
  });

  it('rejects an invalid tree section instead of half-applying it', () => {
    expect(parseTreeConfig({ enabled: true, maxChildren: -1 }).error).toMatch(/maxChildren/);
    expect(parseTreeConfig({ enabled: true, enforcement: { TREE_FANOUT: 'loud' } }).error).toBeDefined();
    expect(parseTreeConfig({ enabled: true, maxSpecLines: 100, minSpecLines: 60 }).error).toMatch(/at least twice minSpecLines/);
    expect(parseTreeConfig({ enabled: true, maxSpecLines: 120, minSpecLines: 60 }).config).toMatchObject({ minSpecLines: 60, minRequirements: 3 });
  });
});
