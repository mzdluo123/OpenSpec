import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FileSystemUtils } from '../../utils/file-system.js';
import { matchLineEnding } from '../../utils/line-endings.js';
import {
  extractRequirementsSection,
  foldRequirementName,
  normalizeRequirementName,
  type RequirementBlock,
  type RequirementsSectionParts,
} from '../parsers/requirement-blocks.js';
import { buildSpecSkeleton, buildUpdatedSpec } from '../specs-apply.js';
import { MIN_PURPOSE_LENGTH } from '../validation/constants.js';
import { isWithinSubtree, type TreeIssue } from './config.js';
import type { ChangeDeltaFile, IndexedChange } from './change-index.js';
import { compareCodePoints } from './inventory.js';
import { describeOperation, type ManifestOperation, type RestructureManifest } from './manifest.js';
import type { RestructureStep } from './inflight-rewrite.js';

/**
 * In-memory main specs tree: every regular file under openspec/specs keyed by
 * its forward-slash path, plus every directory.
 */
export interface SpecsTree {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

export const SPEC_FILE = 'spec.md';

export function specKey(capability: string): string {
  return `${capability}/${SPEC_FILE}`;
}

export function cloneTree(tree: SpecsTree): SpecsTree {
  return { files: new Map(tree.files), dirs: new Set(tree.dirs) };
}

/** Read every non-dot file and directory under the specs root (symlinked directories are not followed). */
export async function readSpecsTree(specsDir: string): Promise<SpecsTree> {
  const tree: SpecsTree = { files: new Map(), dirs: new Set() };
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && segments.length === 0) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relative = [...segments, entry.name].join('/');
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        tree.dirs.add(relative);
        await walk(absolute, [...segments, entry.name]);
      } else if (entry.isFile() || (entry.isSymbolicLink() && segments.length > 0 && entry.name === SPEC_FILE)) {
        if (segments.length === 0) continue;
        tree.files.set(relative, await fs.readFile(absolute));
      }
    }
  };
  await walk(specsDir, []);
  return tree;
}

/** Spec contents keyed by capability path. */
export function treeSpecs(tree: SpecsTree): Map<string, string> {
  const specs = new Map<string, string>();
  for (const [file, content] of tree.files) {
    if (file.endsWith(`/${SPEC_FILE}`)) specs.set(file.slice(0, -SPEC_FILE.length - 1), content.toString('utf-8'));
  }
  return specs;
}

function readSpec(tree: SpecsTree, capability: string): string | undefined {
  return tree.files.get(specKey(capability))?.toString('utf-8');
}

function pathExists(tree: SpecsTree, target: string): boolean {
  if (tree.dirs.has(target)) return true;
  for (const file of tree.files.keys()) if (isWithinSubtree(file, target)) return true;
  return false;
}

function parentPath(target: string): string {
  const index = target.lastIndexOf('/');
  return index === -1 ? '' : target.slice(0, index);
}

function parentExists(tree: SpecsTree, target: string): boolean {
  const parent = parentPath(target);
  return parent === '' || tree.dirs.has(parent);
}

/** Compose a spec from its parsed parts, mirroring archive's recomposition. */
export function composeSpec(parts: RequirementsSectionParts, blocks: RequirementBlock[], original: string): string {
  const body = [parts.preamble && parts.preamble.trim() ? parts.preamble.trimEnd() : '']
    .filter(Boolean)
    .concat(blocks.map((block) => block.raw))
    .join('\n\n')
    .trimEnd();
  const rebuilt =
    [parts.before.trimEnd(), parts.headerLine, body, parts.after.trim()]
      .filter((slice) => slice !== '')
      .join('\n\n')
      .trimEnd() + '\n';
  return matchLineEnding(rebuilt, original);
}

export function renameRequirementHeader(raw: string, newName: string): string {
  const lines = raw.split('\n');
  lines[0] = `### Requirement: ${newName}`;
  return lines.join('\n');
}

export interface MovedRequirement {
  from: { capability: string; name: string };
  to: { capability: string; name: string };
}

export interface MergedRequirement {
  drop: { capability: string; name: string };
  keep: { capability: string; name: string };
}

export interface SimulationResult {
  before: SpecsTree;
  after: SpecsTree;
  issues: TreeIssue[];
  /** Applied steps in manifest order: redirect entries (without change) and retirements. */
  steps: RestructureStep[];
  movedCapabilities: Array<{ from: string; to: string }>;
  movedRequirements: MovedRequirement[];
  mergedRequirements: MergedRequirement[];
  retired: string[];
  /** Capability paths whose spec the change's own MODIFIED deltas rewrote. */
  modifiedByDeltas: Array<{ capability: string; name: string }>;
  /** Nodes the manifest touched, for scoping structural rules. */
  touchedNodes: Set<string>;
}

class PreconditionError extends Error {}

function fail(index: number, operation: ManifestOperation, reason: string): never {
  throw new PreconditionError(`Operation ${index + 1} (${describeOperation(operation)}): ${reason}`);
}

function findBlocks(blocks: RequirementBlock[], name: string): RequirementBlock[] {
  const wanted = normalizeRequirementName(name);
  return blocks.filter((block) => normalizeRequirementName(block.name) === wanted);
}

function applyOperation(
  tree: SpecsTree,
  operation: ManifestOperation,
  index: number,
  changeName: string,
  result: SimulationResult
): void {
  const touch = (node: string): void => {
    result.touchedNodes.add(node);
    result.touchedNodes.add(parentPath(node));
  };
  switch (operation.op) {
    case 'create-namespace': {
      if (pathExists(tree, operation.path)) fail(index, operation, 'path already exists');
      if (!parentExists(tree, operation.path)) fail(index, operation, `parent ${parentPath(operation.path)} does not exist`);
      tree.dirs.add(operation.path);
      touch(operation.path);
      return;
    }
    case 'create-capability': {
      if (pathExists(tree, operation.path)) fail(index, operation, 'path already exists');
      if (!parentExists(tree, operation.path)) fail(index, operation, `parent ${parentPath(operation.path)} does not exist`);
      if (operation.purpose.trim().length < MIN_PURPOSE_LENGTH) {
        fail(index, operation, `purpose must be at least ${MIN_PURPOSE_LENGTH} characters`);
      }
      // Same title archive gives a new capability: the full capability id.
      tree.dirs.add(operation.path);
      tree.files.set(specKey(operation.path), Buffer.from(buildSpecSkeleton(operation.path, changeName, operation.purpose.trim())));
      touch(operation.path);
      return;
    }
    case 'move-capability': {
      const { from, to } = operation;
      if (!tree.dirs.has(from)) fail(index, operation, `${from} does not exist`);
      if (pathExists(tree, to)) fail(index, operation, `${to} already exists`);
      if (isWithinSubtree(to, from)) fail(index, operation, 'cannot move a node into its own subtree');
      if (!parentExists(tree, to)) fail(index, operation, `parent ${parentPath(to)} does not exist`);
      const rewrite = (value: string): string => `${to}${value.slice(from.length)}`;
      for (const dir of [...tree.dirs]) {
        if (isWithinSubtree(dir, from)) {
          tree.dirs.delete(dir);
          tree.dirs.add(rewrite(dir));
        }
      }
      for (const [file, content] of [...tree.files]) {
        if (isWithinSubtree(file, from)) {
          tree.files.delete(file);
          tree.files.set(rewrite(file), content);
        }
      }
      result.movedCapabilities.push({ from, to });
      result.steps.push({ capability: { from, to } });
      touch(from);
      touch(to);
      return;
    }
    case 'move-requirement': {
      const { from, to } = operation;
      const source = readSpec(tree, from);
      if (source === undefined) fail(index, operation, `${from} is not a capability`);
      const target = readSpec(tree, to);
      if (target === undefined) fail(index, operation, `${to} is not a capability`);
      if (from === to && !operation.renameTo) fail(index, operation, 'source and target are the same capability');
      const sourceParts = extractRequirementsSection(source);
      const matches = findBlocks(sourceParts.bodyBlocks, operation.requirement);
      if (matches.length !== 1) {
        fail(index, operation, `${from} has ${matches.length} requirements named "${operation.requirement}" (exactly 1 required)`);
      }
      const moved = matches[0];
      const newName = normalizeRequirementName(operation.renameTo ?? moved.name);
      const remaining = sourceParts.bodyBlocks.filter((block) => block !== moved);
      const movedBlock: RequirementBlock = operation.renameTo
        ? { headerLine: `### Requirement: ${newName}`, name: newName, raw: renameRequirementHeader(moved.raw, newName) }
        : moved;
      if (from === to) {
        const replaced = sourceParts.bodyBlocks.map((block) => (block === moved ? movedBlock : block));
        if (remaining.some((block) => foldRequirementName(block.name) === foldRequirementName(newName))) {
          fail(index, operation, `${to} already has a requirement named "${newName}"`);
        }
        tree.files.set(specKey(from), Buffer.from(composeSpec(sourceParts, replaced, source)));
      } else {
        const targetParts = extractRequirementsSection(target);
        if (targetParts.bodyBlocks.some((block) => foldRequirementName(block.name) === foldRequirementName(newName))) {
          fail(index, operation, `${to} already has a requirement named "${newName}"`);
        }
        tree.files.set(specKey(from), Buffer.from(composeSpec(sourceParts, remaining, source)));
        tree.files.set(specKey(to), Buffer.from(composeSpec(targetParts, [...targetParts.bodyBlocks, movedBlock], target)));
      }
      const record = { from: { capability: from, name: moved.name }, to: { capability: to, name: newName } };
      result.movedRequirements.push(record);
      result.steps.push({
        requirement: {
          from: { capability: from, name: moved.name },
          to: { capability: to, name: newName },
        },
      });
      touch(from);
      touch(to);
      return;
    }
    case 'merge-requirement': {
      const { keep, drop } = operation;
      const keepSpec = readSpec(tree, keep.capability);
      if (keepSpec === undefined) fail(index, operation, `${keep.capability} is not a capability`);
      const dropSpec = readSpec(tree, drop.capability);
      if (dropSpec === undefined) fail(index, operation, `${drop.capability} is not a capability`);
      const keepMatches = findBlocks(extractRequirementsSection(keepSpec).bodyBlocks, keep.requirement);
      if (keepMatches.length !== 1) {
        fail(index, operation, `${keep.capability} has ${keepMatches.length} requirements named "${keep.requirement}" (exactly 1 required)`);
      }
      const dropParts = extractRequirementsSection(dropSpec);
      const dropMatches = findBlocks(dropParts.bodyBlocks, drop.requirement);
      if (dropMatches.length !== 1) {
        fail(index, operation, `${drop.capability} has ${dropMatches.length} requirements named "${drop.requirement}" (exactly 1 required)`);
      }
      if (keep.capability === drop.capability && keepMatches[0] === dropMatches[0]) {
        fail(index, operation, 'keep and drop are the same requirement');
      }
      tree.files.set(
        specKey(drop.capability),
        Buffer.from(composeSpec(dropParts, dropParts.bodyBlocks.filter((block) => block !== dropMatches[0]), dropSpec))
      );
      const record = {
        drop: { capability: drop.capability, name: dropMatches[0].name },
        keep: { capability: keep.capability, name: keepMatches[0].name },
      };
      result.mergedRequirements.push(record);
      result.steps.push({
        merged: {
          from: { capability: drop.capability, name: dropMatches[0].name },
          into: { capability: keep.capability, name: keepMatches[0].name },
        },
      });
      touch(drop.capability);
      touch(keep.capability);
      return;
    }
    case 'retire-capability': {
      const spec = readSpec(tree, operation.path);
      if (spec === undefined) fail(index, operation, `${operation.path} is not a capability`);
      const left = extractRequirementsSection(spec).bodyBlocks.length;
      if (left > 0) fail(index, operation, `${operation.path} still has ${left} requirement(s)`);
      tree.files.delete(specKey(operation.path));
      result.retired.push(operation.path);
      result.steps.push({ retired: operation.path });
      touch(operation.path);
      return;
    }
  }
}

/** Drop directories left with no file below them, except ones the manifest created and left empty. */
function pruneEmptyDirectories(tree: SpecsTree, keep: ReadonlySet<string>): void {
  const occupied = new Set<string>();
  for (const file of tree.files.keys()) {
    let dir = parentPath(file);
    while (dir !== '' && !occupied.has(dir)) {
      occupied.add(dir);
      dir = parentPath(dir);
    }
  }
  for (const dir of [...tree.dirs]) {
    if (!occupied.has(dir) && !keep.has(dir)) tree.dirs.delete(dir);
  }
}

/**
 * Apply the change's own delta files to the simulated tree with archive's
 * merge (buildUpdatedSpec), so MODIFIED text lands exactly as archive would
 * write it. Only MODIFIED is permitted in a restructure change.
 */
async function applyChangeDeltas(
  tree: SpecsTree,
  change: IndexedChange,
  issues: TreeIssue[],
  modified: Array<{ capability: string; name: string }>
): Promise<void> {
  const forbidden = (delta: ChangeDeltaFile): string[] => [
    ...(delta.plan.added.length > 0 ? ['ADDED'] : []),
    ...(delta.plan.removed.length > 0 ? ['REMOVED'] : []),
    ...(delta.plan.renamed.length > 0 ? ['RENAMED'] : []),
  ];
  const applicable: ChangeDeltaFile[] = [];
  for (const delta of change.deltas) {
    const sections = forbidden(delta);
    if (sections.length > 0) {
      issues.push({
        level: 'ERROR',
        code: 'RESTRUCTURE_FORBIDDEN_DELTA',
        path: `${delta.capability}/${SPEC_FILE}`,
        message: `A restructure change may only carry MODIFIED deltas (for requirements kept by merge-requirement); found ${sections.join(', ')}. Use manifest operations to move, merge or retire requirements.`,
      });
      continue;
    }
    if (delta.plan.modified.length > 0) applicable.push(delta);
  }
  if (applicable.length === 0) return;

  const tempRoot = FileSystemUtils.canonicalizeExistingPath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-tree-sim-'))
  );
  try {
    const sourceRoot = FileSystemUtils.canonicalizeExistingPath(path.join(change.dir, 'specs'));
    for (const delta of applicable) {
      const current = readSpec(tree, delta.capability);
      if (current === undefined) {
        issues.push({
          level: 'ERROR',
          code: 'RESTRUCTURE_DELTA_FAILED',
          path: `${delta.capability}/${SPEC_FILE}`,
          message: `MODIFIED targets ${delta.capability}, which is not a capability in the restructured tree.`,
        });
        continue;
      }
      const target = path.join(tempRoot, ...delta.capability.split('/'), SPEC_FILE);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, current);
      try {
        const built = await buildUpdatedSpec(
          {
            id: delta.capability,
            sourceRoot,
            source: path.join(sourceRoot, ...delta.capability.split('/'), SPEC_FILE),
            targetRoot: tempRoot,
            target,
            exists: true,
          },
          change.name,
          { silent: true }
        );
        tree.files.set(specKey(delta.capability), Buffer.from(matchLineEnding(built.rebuilt, current)));
        for (const block of delta.plan.modified) modified.push({ capability: delta.capability, name: block.name });
      } catch (error) {
        issues.push({
          level: 'ERROR',
          code: 'RESTRUCTURE_DELTA_FAILED',
          path: `${delta.capability}/${SPEC_FILE}`,
          message: (error as Error).message,
        });
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Apply a restructure manifest, then the change's MODIFIED deltas, to a copy
 * of the main specs tree. Stops at the first operation whose precondition
 * fails. Validate, plan and archive all go through here.
 */
export async function simulateRestructure(
  before: SpecsTree,
  manifest: RestructureManifest,
  change: IndexedChange
): Promise<SimulationResult> {
  const after = cloneTree(before);
  const result: SimulationResult = {
    before,
    after,
    issues: [],
    steps: [],
    movedCapabilities: [],
    movedRequirements: [],
    mergedRequirements: [],
    retired: [],
    modifiedByDeltas: [],
    touchedNodes: new Set(),
  };
  if (manifest.operations.length === 0) {
    result.issues.push({
      level: 'ERROR',
      code: 'RESTRUCTURE_EMPTY_MANIFEST',
      path: 'restructure.yaml',
      message: 'restructure.yaml has no operations.',
    });
  }
  const created = new Set<string>();
  for (const [index, operation] of manifest.operations.entries()) {
    try {
      applyOperation(after, operation, index, change.name, result);
      if (operation.op === 'create-namespace') created.add(operation.path);
    } catch (error) {
      if (!(error instanceof PreconditionError)) throw error;
      result.issues.push({
        level: 'ERROR',
        code: 'RESTRUCTURE_PRECONDITION',
        path: 'restructure.yaml',
        message: error.message,
      });
      return result;
    }
  }
  pruneEmptyDirectories(after, created);
  await applyChangeDeltas(after, change, result.issues, result.modifiedByDeltas);
  result.touchedNodes.delete('');
  return result;
}

export interface FileOperation {
  /** Forward-slash path relative to the specs root. */
  path: string;
  action: 'write' | 'delete';
  content?: Buffer;
}

/** File writes and deletions that turn `before` into `after`, writes first. */
export function diffTrees(before: SpecsTree, after: SpecsTree): FileOperation[] {
  const writes: FileOperation[] = [];
  const deletes: FileOperation[] = [];
  for (const [file, content] of after.files) {
    const previous = before.files.get(file);
    if (!previous || !previous.equals(content)) writes.push({ path: file, action: 'write', content });
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) deletes.push({ path: file, action: 'delete' });
  }
  const byPath = (a: FileOperation, b: FileOperation) => compareCodePoints(a.path, b.path);
  return [...writes.sort(byPath), ...deletes.sort(byPath)];
}
