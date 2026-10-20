import { compareCodePoints } from './inventory.js';
import { targetKey, type IndexedChange, type TargetOp } from './change-index.js';

export interface OverlapGroup {
  capability: string;
  requirement: string;
  changes: Array<{ change: string; ops: TargetOp[] }>;
}

/**
 * Requirements that two or more in-flight changes MODIFY, REMOVE or RENAME,
 * keyed by (capability, folded requirement name). Whichever archives second
 * overwrites the first, so each group is a merge the authors must coordinate.
 */
export function findOverlaps(changes: readonly IndexedChange[]): OverlapGroup[] {
  const groups = new Map<string, OverlapGroup>();
  for (const change of changes) {
    for (const target of change.targets) {
      const key = targetKey(target.capability, target.name);
      let group = groups.get(key);
      if (!group) {
        group = { capability: target.capability, requirement: target.name, changes: [] };
        groups.set(key, group);
      }
      group.changes.push({ change: change.name, ops: [...target.ops] });
    }
  }
  return [...groups.values()]
    .filter((group) => new Set(group.changes.map((entry) => entry.change)).size > 1)
    .sort(
      (a, b) =>
        compareCodePoints(a.capability, b.capability) || compareCodePoints(a.requirement, b.requirement)
    );
}
