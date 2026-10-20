import path from 'path';
import { matchLineEnding } from '../../utils/line-endings.js';
import {
  foldRequirementName,
  normalizeRequirementName,
  parseDeltaSpec,
} from '../parsers/requirement-blocks.js';
import { buildCodeFenceMask } from '../parsers/requirement-text.js';
import { readBases, serializeBases, basesPath, type ChangeBases } from './bases.js';
import { isWithinSubtree } from './config.js';
import type { IndexedChange } from './change-index.js';
import type { TreeInventory } from './inventory.js';
import {
  movedAwayDestinations,
  resolveCapability,
  resolveRequirement,
  type RedirectEntry,
  type TreeRedirects,
} from './redirects.js';
import { cloneTree, diffTrees, readSpecsTree, specKey, type SpecsTree } from './simulate.js';

/**
 * Rewrites other in-flight changes so their deltas follow a restructure:
 * delta files move with their capability, MODIFIED / REMOVED / RENAMED
 * entries follow a moved requirement, and bases.yaml paths follow both.
 * Merges and retirements that another change still targets are conflicts the
 * author must resolve; nothing is guessed.
 */

export type RewriteOp =
  | { kind: 'move-capability'; from: string; to: string }
  | { kind: 'move-requirement'; from: string; to: string; name: string; renameTo?: string }
  | { kind: 'merge'; drop: { capability: string; name: string }; keep: { capability: string; name: string } }
  | { kind: 'retire'; capability: string };

/** One applied manifest step: a redirect entry (without its change) or a retirement. */
export type RestructureStep = Omit<RedirectEntry, 'change'> | { retired: string };

export function stepToRewriteOps(entry: RestructureStep): RewriteOp[] {
  if ('retired' in entry) return [{ kind: 'retire', capability: entry.retired }];
  if (entry.capability) return [{ kind: 'move-capability', from: entry.capability.from, to: entry.capability.to }];
  if (entry.requirement) {
    const { from, to } = entry.requirement;
    const renamed = foldRequirementName(from.name) !== foldRequirementName(to.name);
    return [
      {
        kind: 'move-requirement',
        from: from.capability,
        to: to.capability,
        name: from.name,
        ...(renamed ? { renameTo: to.name } : {}),
      },
    ];
  }
  if (entry.merged) {
    return [
      {
        kind: 'merge',
        drop: { capability: entry.merged.from.capability, name: entry.merged.from.name },
        keep: { capability: entry.merged.into.capability, name: entry.merged.into.name },
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Delta file editing
// ---------------------------------------------------------------------------

const REQUIREMENT_HEADER = /^###\s*Requirement:\s*(.+)\s*$/i;
const REMOVED_BULLET = /^\s*[-*+]\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;
const RENAMED_FROM = /^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;
const RENAMED_TO = /^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;

type SectionKind = 'modified' | 'removed' | 'renamed';
const SECTION_TITLES: Record<SectionKind, string> = {
  modified: 'MODIFIED Requirements',
  removed: 'REMOVED Requirements',
  renamed: 'RENAMED Requirements',
};

interface Section {
  title: string;
  kind?: SectionKind | 'added';
  headerIndex: number;
  /** Exclusive end line index. */
  end: number;
}

function sectionsOf(lines: string[], mask: boolean[]): Section[] {
  const sections: Section[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (mask[index]) continue;
    const match = lines[index].match(/^##\s+(.+)$/);
    if (!match) continue;
    if (sections.length > 0) sections[sections.length - 1].end = index;
    const title = match[1].trim();
    const folded = title.toLowerCase();
    const kind =
      folded === 'added requirements'
        ? 'added'
        : (Object.keys(SECTION_TITLES) as SectionKind[]).find((key) => SECTION_TITLES[key].toLowerCase() === folded);
    sections.push({ title, kind, headerIndex: index, end: lines.length });
  }
  return sections;
}

export interface ExtractedEntries {
  modified: string[];
  removed: string[];
  renamed: string[];
}

function isEmptyExtraction(entries: ExtractedEntries): boolean {
  return entries.modified.length + entries.removed.length + entries.renamed.length === 0;
}

/**
 * Names a delta refers to for one requirement: the requirement itself plus
 * every name this delta renames it to, so a MODIFIED of the new name moves
 * along with the rename.
 */
function relatedNames(content: string, name: string): Set<string> {
  const names = new Set([foldRequirementName(name)]);
  let grew = true;
  const pairs = parseDeltaSpec(content).renamed;
  while (grew) {
    grew = false;
    for (const pair of pairs) {
      if (names.has(foldRequirementName(pair.from)) && !names.has(foldRequirementName(pair.to))) {
        names.add(foldRequirementName(pair.to));
        grew = true;
      }
    }
  }
  return names;
}

/** Remove the MODIFIED / REMOVED / RENAMED entries for `name` from a delta file. */
export function extractRequirementEntries(
  content: string,
  name: string
): { content: string; entries: ExtractedEntries } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const mask = buildCodeFenceMask(lines);
  const names = relatedNames(normalized, name);
  const own = foldRequirementName(name);
  const entries: ExtractedEntries = { modified: [], removed: [], renamed: [] };
  const drop = new Set<number>();

  for (const section of sectionsOf(lines, mask)) {
    if (section.kind === undefined || section.kind === 'added') continue;
    const isHeader = (index: number) => !mask[index] && REQUIREMENT_HEADER.test(lines[index]);
    for (let index = section.headerIndex + 1; index < section.end; index++) {
      if (mask[index]) continue;
      const line = lines[index];
      if (section.kind === 'modified' || section.kind === 'removed') {
        const header = line.match(REQUIREMENT_HEADER);
        if (header) {
          const headerName = foldRequirementName(normalizeRequirementName(header[1]));
          const matches = section.kind === 'modified' ? names.has(headerName) : headerName === own || names.has(headerName);
          let end = index + 1;
          while (end < section.end && !isHeader(end) && !(section.kind === 'removed' && !mask[end] && REMOVED_BULLET.test(lines[end]))) end++;
          if (matches) {
            const block = lines.slice(index, end);
            while (block.length > 1 && block[block.length - 1].trim() === '') block.pop();
            entries[section.kind].push(block.join('\n'));
            for (let cursor = index; cursor < index + block.length; cursor++) drop.add(cursor);
          }
          index = end - 1;
          continue;
        }
        const bullet = section.kind === 'removed' ? line.match(REMOVED_BULLET) : null;
        if (bullet && names.has(foldRequirementName(normalizeRequirementName(bullet[1])))) {
          entries.removed.push(line);
          drop.add(index);
        }
        continue;
      }
      const from = line.match(RENAMED_FROM);
      if (from && foldRequirementName(normalizeRequirementName(from[1])) === own) {
        let toIndex = index + 1;
        while (toIndex < section.end && (mask[toIndex] || !RENAMED_TO.test(lines[toIndex])) && !RENAMED_FROM.test(lines[toIndex])) toIndex++;
        const end = toIndex < section.end && RENAMED_TO.test(lines[toIndex]) ? toIndex : index;
        entries.renamed.push(lines.slice(index, end + 1).join('\n'));
        for (let cursor = index; cursor <= end; cursor++) drop.add(cursor);
        index = end;
      }
    }
  }

  if (isEmptyExtraction(entries)) return { content, entries };
  const remaining = lines.filter((_, index) => !drop.has(index));
  return { content: matchLineEnding(dropEmptySections(remaining).join('\n'), content), entries };
}

/** Remove delta section headers left with nothing but blank lines. */
function dropEmptySections(lines: string[]): string[] {
  const mask = buildCodeFenceMask(lines);
  const sections = sectionsOf(lines, mask);
  const drop = new Set<number>();
  for (const section of sections) {
    if (section.kind === undefined) continue;
    const body = lines.slice(section.headerIndex + 1, section.end);
    if (body.every((line) => line.trim() === '')) {
      for (let index = section.headerIndex; index < section.end; index++) drop.add(index);
    }
  }
  const kept = lines.filter((_, index) => !drop.has(index));
  const collapsed: string[] = [];
  for (const line of kept) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length > 1 && collapsed[collapsed.length - 1].trim() === '' && collapsed[collapsed.length - 2].trim() === '') collapsed.pop();
  return collapsed;
}

/** True when a delta file has no entries left in any of the four sections. */
export function deltaIsEmpty(content: string): boolean {
  const plan = parseDeltaSpec(content);
  return plan.added.length + plan.modified.length + plan.removed.length + plan.renamed.length === 0;
}

/** Rename the requirement `from` to `to` inside extracted entries. */
export function renameEntries(entries: ExtractedEntries, from: string, to: string): ExtractedEntries {
  const own = foldRequirementName(from);
  const renameLine = (line: string, pattern: RegExp): string => {
    const match = line.match(pattern);
    if (!match || foldRequirementName(normalizeRequirementName(match[1])) !== own) return line;
    return line.replace(match[1], to);
  };
  return {
    modified: entries.modified.map((block) => {
      const [header, ...rest] = block.split('\n');
      return [renameLine(header, REQUIREMENT_HEADER), ...rest].join('\n');
    }),
    removed: entries.removed.map((block) => {
      const [first, ...rest] = block.split('\n');
      return [REQUIREMENT_HEADER.test(first) ? renameLine(first, REQUIREMENT_HEADER) : renameLine(first, REMOVED_BULLET), ...rest].join('\n');
    }),
    renamed: entries.renamed.map((pair) => {
      const [first, ...rest] = pair.split('\n');
      return [renameLine(first, RENAMED_FROM), ...rest].join('\n');
    }),
  };
}

/** Append extracted entries to a delta file (created when absent), into the matching sections. */
export function insertEntries(content: string | undefined, entries: ExtractedEntries): string {
  const base = (content ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let lines = base === '' ? [] : base.replace(/\n+$/, '').split('\n');
  for (const kind of ['modified', 'removed', 'renamed'] as const) {
    const items = entries[kind];
    if (items.length === 0) continue;
    const mask = buildCodeFenceMask(lines);
    const section = sectionsOf(lines, mask).find((candidate) => candidate.kind === kind);
    const payload = items.flatMap((item) => ['', ...item.split('\n')]);
    if (section) {
      let insertAt = section.end;
      while (insertAt > section.headerIndex + 1 && lines[insertAt - 1].trim() === '') insertAt--;
      const tail = lines.slice(section.end);
      lines = [...lines.slice(0, insertAt), ...payload, ...(tail.length > 0 ? ['', ...tail] : [])];
    } else {
      lines = [...lines, ...(lines.length > 0 ? [''] : []), `## ${SECTION_TITLES[kind]}`, ...payload];
    }
  }
  const result = `${lines.join('\n')}\n`;
  return content === undefined ? result : matchLineEnding(result, content);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface RewriteConflict {
  change: string;
  reason: string;
}

export interface ChangeRewrite {
  change: string;
  /** Absolute paths. */
  writes: Array<{ path: string; content: Buffer }>;
  deletes: string[];
  /** Human-readable summary of what moved. */
  notes: string[];
}

export interface InflightRewritePlan {
  rewrites: ChangeRewrite[];
  conflicts: RewriteConflict[];
}

function rewriteBases(bases: ChangeBases, op: RewriteOp): ChangeBases {
  return {
    version: 1,
    entries: bases.entries.map((entry) => {
      if (op.kind === 'move-capability' && isWithinSubtree(entry.capability, op.from)) {
        return { ...entry, capability: `${op.to}${entry.capability.slice(op.from.length)}` };
      }
      if (
        op.kind === 'move-requirement' &&
        entry.capability === op.from &&
        foldRequirementName(entry.requirement) === foldRequirementName(op.name)
      ) {
        return { ...entry, capability: op.to, requirement: normalizeRequirementName(op.renameTo ?? entry.requirement) };
      }
      return entry;
    }),
  };
}

/**
 * Apply rewrite ops to one change's specs/ tree and bases. Conflicts are
 * returned instead of applied.
 */
export function rewriteChangeTree(
  changeName: string,
  tree: SpecsTree,
  bases: ChangeBases | undefined,
  ops: readonly RewriteOp[]
): { tree: SpecsTree; bases?: ChangeBases; conflicts: RewriteConflict[]; notes: string[] } {
  const next = cloneTree(tree);
  let nextBases = bases;
  const conflicts: RewriteConflict[] = [];
  const notes: string[] = [];
  const read = (capability: string) => next.files.get(specKey(capability))?.toString('utf-8');

  for (const op of ops) {
    switch (op.kind) {
      case 'move-capability': {
        const moving = [...next.files.keys()].filter((file) => isWithinSubtree(file, op.from));
        const collisions = moving
          .map((file) => `${op.to}${file.slice(op.from.length)}`)
          .filter((file) => next.files.has(file) && !isWithinSubtree(file, op.from));
        if (collisions.length > 0) {
          conflicts.push({ change: changeName, reason: `delta ${collisions[0]} already exists, so specs/${op.from} cannot move onto it` });
          break;
        }
        for (const file of moving) {
          const content = next.files.get(file)!;
          next.files.delete(file);
          next.files.set(`${op.to}${file.slice(op.from.length)}`, content);
        }
        for (const dir of [...next.dirs]) {
          if (isWithinSubtree(dir, op.from)) {
            next.dirs.delete(dir);
            next.dirs.add(`${op.to}${dir.slice(op.from.length)}`);
          }
        }
        if (moving.length > 0) notes.push(`specs/${op.from} -> specs/${op.to}`);
        break;
      }
      case 'move-requirement': {
        const source = read(op.from);
        if (source === undefined) break;
        const extracted = extractRequirementEntries(source, op.name);
        if (isEmptyExtraction(extracted.entries)) break;
        const moved = op.renameTo ? renameEntries(extracted.entries, op.name, op.renameTo) : extracted.entries;
        if (deltaIsEmpty(extracted.content)) next.files.delete(specKey(op.from));
        else next.files.set(specKey(op.from), Buffer.from(extracted.content));
        next.files.set(specKey(op.to), Buffer.from(insertEntries(read(op.to), moved)));
        notes.push(`"${op.name}" ${op.from} -> ${op.to}${op.renameTo ? ` as "${op.renameTo}"` : ''}`);
        break;
      }
      case 'merge': {
        const source = read(op.drop.capability);
        if (source === undefined) break;
        const extracted = extractRequirementEntries(source, op.drop.name);
        if (!isEmptyExtraction(extracted.entries)) {
          conflicts.push({
            change: changeName,
            reason: `it changes ${op.drop.capability}#${op.drop.name}, which is merged into ${op.keep.capability}#${op.keep.name}; rewrite the change against the kept requirement first`,
          });
        }
        break;
      }
      case 'retire': {
        if (next.files.has(specKey(op.capability))) {
          conflicts.push({
            change: changeName,
            reason: `it has a delta for ${op.capability}, which this restructure retires`,
          });
        }
        break;
      }
    }
    if (nextBases && (op.kind === 'move-capability' || op.kind === 'move-requirement')) {
      nextBases = rewriteBases(nextBases, op);
    }
  }
  return { tree: next, ...(nextBases ? { bases: nextBases } : {}), conflicts, notes };
}

/** Plan rewrites for every in-flight change except `excludeChange`. */
export async function planInflightRewrites(
  changes: readonly IndexedChange[],
  ops: readonly RewriteOp[],
  options: { excludeChange?: string } = {}
): Promise<InflightRewritePlan> {
  const plan: InflightRewritePlan = { rewrites: [], conflicts: [] };
  if (ops.length === 0) return plan;
  for (const change of changes) {
    if (change.name === options.excludeChange) continue;
    const specsDir = path.join(change.dir, 'specs');
    const tree = await readSpecsTree(specsDir);
    const bases = await readBases(change.dir);
    const result = rewriteChangeTree(change.name, tree, bases, ops);
    plan.conflicts.push(...result.conflicts);
    const fileOps = diffTrees(tree, result.tree);
    const basesChanged = bases !== undefined && result.bases !== undefined && serializeBases(bases) !== serializeBases(result.bases);
    if (fileOps.length === 0 && !basesChanged) continue;
    plan.rewrites.push({
      change: change.name,
      writes: [
        ...fileOps
          .filter((op) => op.action === 'write')
          .map((op) => ({ path: path.join(specsDir, ...op.path.split('/')), content: op.content! })),
        ...(basesChanged ? [{ path: basesPath(change.dir), content: Buffer.from(serializeBases(result.bases!)) }] : []),
      ],
      deletes: fileOps
        .filter((op) => op.action === 'delete')
        .map((op) => path.join(specsDir, ...op.path.split('/'))),
      notes: result.notes,
    });
  }
  return plan;
}

/**
 * Rewrite ops that bring one change up to date with the redirect table: delta
 * files at a moved capability path move with it, and entries for a moved
 * requirement follow it. Merged requirements and capabilities split across
 * several destinations cannot be rebased automatically and are conflicts.
 */
export function planRebaseOps(
  change: IndexedChange,
  inventory: TreeInventory,
  redirects: TreeRedirects
): { ops: RewriteOp[]; conflicts: RewriteConflict[] } {
  const ops: RewriteOp[] = [];
  const conflicts: RewriteConflict[] = [];
  const exists = (capability: string) => inventory.nodes.get(capability)?.hasSpec === true;
  const effective = new Map<string, string>();
  for (const delta of change.deltas) {
    if (exists(delta.capability)) continue;
    const resolved = resolveCapability(redirects, delta.capability);
    if (resolved.moved && exists(resolved.capability)) {
      ops.push({ kind: 'move-capability', from: delta.capability, to: resolved.capability });
      effective.set(delta.capability, resolved.capability);
      continue;
    }
    const destinations = movedAwayDestinations(redirects, delta.capability);
    if (destinations.length > 0) {
      conflicts.push({
        change: change.name,
        reason: `specs/${delta.capability} was split across ${destinations.join(', ')}; move its deltas by hand`,
      });
    }
  }
  for (const target of change.targets) {
    const capability = effective.get(target.capability) ?? target.capability;
    const node = inventory.nodes.get(capability);
    const present = node?.requirements.some(
      (requirement) => foldRequirementName(requirement.name) === foldRequirementName(target.name)
    );
    if (present || !node?.hasSpec) continue;
    const resolved = resolveRequirement(redirects, target.capability, target.name);
    if (resolved.kind === 'merged') {
      conflicts.push({
        change: change.name,
        reason: `${target.capability}#${target.name} was merged into ${resolved.capability}#${resolved.name}; rewrite the change against the kept requirement`,
      });
    } else if (resolved.kind === 'moved' && resolved.capability !== capability) {
      ops.push({
        kind: 'move-requirement',
        from: capability,
        to: resolved.capability,
        name: target.name,
        ...(foldRequirementName(resolved.name) !== foldRequirementName(target.name) ? { renameTo: resolved.name } : {}),
      });
    } else if (resolved.kind === 'moved') {
      ops.push({ kind: 'move-requirement', from: capability, to: capability, name: target.name, renameTo: resolved.name });
    }
  }
  return { ops, conflicts };
}
