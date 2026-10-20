import { promises as fs } from 'fs';
import path from 'path';
import { formatLocalDate } from '../../utils/date.js';
import { pruneEmptyDirs } from '../specs-apply.js';
import { findingLevelToValidation, type TreeIssue } from './config.js';
import { readIndexedChange, type IndexedChange } from './change-index.js';
import { checkConservation } from './conservation.js';
import type { TreeContext } from './context.js';
import { stepToRewriteOps, planInflightRewrites, type InflightRewritePlan } from './inflight-rewrite.js';
import { buildInventoryFromContents } from './inventory.js';
import { readManifest, type ManifestOpName, type RestructureManifest } from './manifest.js';
import { redirectsPath, serializeRedirects, type RedirectEntry } from './redirects.js';
import { runTreeRules } from './rules.js';
import {
  diffTrees,
  readSpecsTree,
  simulateRestructure,
  treeSpecs,
  type FileOperation,
  type SimulationResult,
} from './simulate.js';
import { readTreeState, serializeTreeState, treeStatePath } from './state.js';

/** Manifest operations each instruction kind permits (section 6 of the design). */
export const INSTRUCTION_ALLOWED_OPS: Record<string, readonly ManifestOpName[]> = {
  split: ['create-namespace', 'move-capability'],
  'split-spec': ['create-capability', 'move-requirement'],
  lift: ['move-capability'],
  merge: ['move-requirement', 'retire-capability'],
  review: ['move-requirement', 'merge-requirement', 'create-capability', 'retire-capability'],
};

export interface RestructurePlan {
  change: IndexedChange;
  manifest?: RestructureManifest;
  simulation?: SimulationResult;
  issues: TreeIssue[];
  /** Main-spec file operations, relative to the specs root. */
  specOperations: FileOperation[];
  inflight: InflightRewritePlan;
  /** Entries appended to tree-redirects.yaml (change name filled in at archive). */
  redirectSteps: Array<Omit<RedirectEntry, 'change'>>;
  /** Subtree recorded as reviewed in tree-state.yaml, from a `review:<node>` instruction. */
  reviewNode?: string;
}

function instructionKind(instruction: string | undefined): { kind?: string; node?: string } {
  if (!instruction) return {};
  const index = instruction.indexOf(':');
  if (index === -1) return { kind: instruction };
  return { kind: instruction.slice(0, index), node: instruction.slice(index + 1) };
}

/**
 * Simulate a restructure change against the current tree and plan every file
 * it would touch. Validate, `tree plan` and archive all start here.
 */
export async function planRestructure(context: TreeContext, changeName: string): Promise<RestructurePlan> {
  const change = await readIndexedChange(context.paths.changesDir, changeName);
  const plan: RestructurePlan = {
    change,
    issues: [],
    specOperations: [],
    inflight: { rewrites: [], conflicts: [] },
    redirectSteps: [],
  };

  try {
    plan.manifest = await readManifest(change.dir);
  } catch (error) {
    plan.issues.push({
      level: 'ERROR',
      code: 'RESTRUCTURE_MANIFEST_INVALID',
      path: 'restructure.yaml',
      message: (error as Error).message,
    });
    return plan;
  }

  const { kind, node } = instructionKind(plan.manifest.instruction);
  const allowed = kind ? INSTRUCTION_ALLOWED_OPS[kind] : undefined;
  if (kind && !allowed) {
    plan.issues.push({
      level: 'WARNING',
      code: 'RESTRUCTURE_UNKNOWN_INSTRUCTION',
      path: 'restructure.yaml',
      message: `Unknown instruction kind "${kind}"; expected one of ${Object.keys(INSTRUCTION_ALLOWED_OPS).join(', ')}.`,
    });
  }
  if (allowed) {
    for (const [index, operation] of plan.manifest.operations.entries()) {
      if (!allowed.includes(operation.op)) {
        plan.issues.push({
          level: 'ERROR',
          code: 'RESTRUCTURE_OP_NOT_ALLOWED',
          path: 'restructure.yaml',
          message: `Operation ${index + 1} (${operation.op}) is not allowed for a ${kind} instruction; allowed: ${allowed.join(', ')}.`,
        });
      }
    }
  }
  if (kind === 'review' && node) plan.reviewNode = node;

  const before = await readSpecsTree(context.paths.specsDir);
  const simulation = await simulateRestructure(before, plan.manifest, change);
  plan.simulation = simulation;
  plan.issues.push(...simulation.issues);
  if (simulation.issues.some((issue) => issue.level === 'ERROR')) return plan;

  plan.issues.push(
    ...checkConservation(before, simulation.after, plan.manifest, simulation.modifiedByDeltas)
  );

  const afterInventory = buildInventoryFromContents(
    context.paths.specsDir,
    treeSpecs(simulation.after),
    simulation.after.dirs
  );
  for (const finding of runTreeRules(
    { inventory: afterInventory, config: context.config },
    { nodes: simulation.touchedNodes }
  )) {
    plan.issues.push({
      level: findingLevelToValidation(finding.level),
      code: finding.code,
      path: finding.node === '' ? 'specs' : finding.node,
      message: `After this restructure: ${finding.message}`,
    });
  }

  // Over-splitting guard: every capability this restructure creates, and every
  // one it moves requirements out of, must clear the configured floor.
  const { minSpecLines, minRequirements } = context.config;
  const shrunk = new Set([
    ...plan.manifest.operations.flatMap((operation) => (operation.op === 'create-capability' ? [operation.path] : [])),
    ...simulation.movedRequirements.map((move) => move.from.capability),
    ...simulation.mergedRequirements.map((merge) => merge.drop.capability),
  ]);
  for (const capability of [...shrunk].sort()) {
    const node = afterInventory.nodes.get(capability);
    if (!node?.hasSpec) continue;
    if (node.lines >= minSpecLines || node.requirements.length >= minRequirements) continue;
    plan.issues.push({
      level: 'ERROR',
      code: 'RESTRUCTURE_TOO_GRANULAR',
      path: capability,
      message: `After this restructure ${capability}/spec.md has ${node.lines} lines and ${node.requirements.length} requirement(s); a capability a restructure creates or shrinks needs at least ${minSpecLines} lines or ${minRequirements} requirements. Split into fewer parts or keep these requirements in the parent.`,
    });
  }

  plan.specOperations = diffTrees(before, simulation.after);
  plan.redirectSteps = simulation.steps.filter(
    (step): step is Omit<RedirectEntry, 'change'> => !('retired' in step)
  );
  plan.inflight = await planInflightRewrites(
    await context.changes(),
    simulation.steps.flatMap(stepToRewriteOps),
    { excludeChange: change.name }
  );
  for (const conflict of plan.inflight.conflicts) {
    plan.issues.push({
      level: 'WARNING',
      code: 'RESTRUCTURE_INFLIGHT_CONFLICT',
      path: `changes/${conflict.change}`,
      message: `In-flight change ${conflict.change} cannot be rewritten automatically: ${conflict.reason}. Archive will refuse until it is resolved.`,
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export interface FileTransactionEntry {
  target: string;
  outcome: 'write' | 'retire';
  content?: Buffer;
}

/** Hooks the archive command supplies so rollback reuses its snapshot machinery. */
export interface RestructureArchiveDeps<Snapshot> {
  captureSnapshots(entries: FileTransactionEntry[], boundaryDir: string): Promise<Snapshot[]>;
  restoreSnapshots(snapshots: Snapshot[], boundaryDir: string): Promise<void>;
  moveDirectory(from: string, to: string): Promise<void>;
  /** ERROR count of a change's validation; used to refuse rewrites that break a change. */
  countChangeErrors(changeDir: string): Promise<number>;
}

export interface RestructureArchiveResult {
  operations: number;
  fileOperations: number;
  rewrittenChanges: string[];
  redirectsAppended: number;
  reviewRecorded?: string;
}

export class RestructureBlockedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string
  ) {
    super(message);
  }
}

/**
 * Apply a planned restructure atomically: snapshot every file it touches,
 * write the new tree, rewrite in-flight deltas and bases, append redirects,
 * update tree-state, then move the change to the archive. Any failure restores
 * every snapshot and moves the change back.
 */
export async function archiveRestructure<Snapshot>(
  context: TreeContext,
  plan: RestructurePlan,
  archiveName: string,
  archivePath: string,
  deps: RestructureArchiveDeps<Snapshot>
): Promise<RestructureArchiveResult> {
  const errors = plan.issues.filter((issue) => issue.level === 'ERROR');
  if (errors.length > 0 || !plan.manifest || !plan.simulation) {
    throw new RestructureBlockedError(
      errors[0]?.code ?? 'RESTRUCTURE_INVALID',
      `Restructure change '${plan.change.name}' is not valid: ${errors.map((issue) => issue.message).join(' ')}`,
      `Run openspec validate ${plan.change.name} --strict and fix restructure.yaml.`
    );
  }
  if (plan.inflight.conflicts.length > 0) {
    throw new RestructureBlockedError(
      'RESTRUCTURE_INFLIGHT_CONFLICT',
      `Cannot archive '${plan.change.name}': ${plan.inflight.conflicts
        .map((conflict) => `${conflict.change}: ${conflict.reason}`)
        .join('; ')}`,
      'Rewrite the listed changes against the restructured requirements (or archive them first), then rerun.'
    );
  }

  const { specsDir, openspecDir } = context.paths;
  const rewrittenDirs = plan.inflight.rewrites.map((rewrite) => path.join(context.paths.changesDir, rewrite.change));
  const errorsBefore = new Map<string, number>();
  for (const dir of rewrittenDirs) errorsBefore.set(dir, await deps.countChangeErrors(dir));

  const writes: Array<{ target: string; content: Buffer }> = [];
  const deletes: Array<{ target: string; boundary: string }> = [];
  for (const operation of plan.specOperations) {
    const target = path.join(specsDir, ...operation.path.split('/'));
    if (operation.action === 'write') writes.push({ target, content: operation.content! });
    else deletes.push({ target, boundary: specsDir });
  }
  for (const rewrite of plan.inflight.rewrites) {
    for (const write of rewrite.writes) writes.push({ target: write.path, content: write.content });
    const boundary = path.join(context.paths.changesDir, rewrite.change);
    for (const target of rewrite.deletes) deletes.push({ target, boundary });
  }
  const redirects = await context.redirects();
  const appended: RedirectEntry[] = plan.redirectSteps.map((step) => ({ change: archiveName, ...step }));
  if (appended.length > 0) {
    writes.push({
      target: redirectsPath(openspecDir),
      content: Buffer.from(serializeRedirects({ version: 1, entries: [...redirects.entries, ...appended] })),
    });
  }
  if (plan.reviewNode !== undefined) {
    const state = await readTreeState(openspecDir);
    state.reviews.push({ node: plan.reviewNode, reviewedAt: formatLocalDate(), change: archiveName });
    writes.push({ target: treeStatePath(openspecDir), content: Buffer.from(serializeTreeState(state)) });
  }

  const snapshots = await deps.captureSnapshots(
    [
      ...writes.map((write) => ({ target: write.target, outcome: 'write' as const, content: write.content })),
      ...deletes.map((entry) => ({ target: entry.target, outcome: 'retire' as const })),
    ],
    openspecDir
  );
  let moved = false;
  try {
    for (const write of writes) {
      await fs.mkdir(path.dirname(write.target), { recursive: true });
      await fs.writeFile(write.target, write.content);
    }
    for (const entry of deletes) {
      await fs.rm(entry.target, { force: true });
      await pruneEmptyDirs(path.dirname(entry.target), entry.boundary);
    }
    for (const dir of rewrittenDirs) {
      const after = await deps.countChangeErrors(dir);
      if (after > (errorsBefore.get(dir) ?? 0)) {
        throw new RestructureBlockedError(
          'RESTRUCTURE_INFLIGHT_CONFLICT',
          `Rewriting in-flight change '${path.basename(dir)}' made it fail validation; the restructure was rolled back.`,
          `Run openspec tree plan ${plan.change.name} to inspect the rewrite.`
        );
      }
    }
    await deps.moveDirectory(plan.change.dir, archivePath);
    moved = true;
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (moved) {
      await deps.moveDirectory(archivePath, plan.change.dir).catch((rollbackError) => {
        rollbackErrors.push((rollbackError as Error).message);
      });
    }
    await deps.restoreSnapshots(snapshots, openspecDir).catch((rollbackError) => {
      rollbackErrors.push((rollbackError as Error).message);
    });
    if (rollbackErrors.length > 0) {
      throw new Error(`${(error as Error).message} Rollback also failed: ${rollbackErrors.join(' ')}`);
    }
    throw error;
  }

  return {
    operations: plan.manifest.operations.length,
    fileOperations: writes.length + deletes.length,
    rewrittenChanges: plan.inflight.rewrites.map((rewrite) => rewrite.change),
    redirectsAppended: appended.length,
    ...(plan.reviewNode !== undefined ? { reviewRecorded: plan.reviewNode } : {}),
  };
}
