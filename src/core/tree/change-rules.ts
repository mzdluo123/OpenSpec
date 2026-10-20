import { readFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { foldRequirementName } from '../parsers/requirement-blocks.js';
import { findBaseEntry, findRequirementBlock, readBases, readMainSpec } from './bases.js';
import { findingLevelToValidation, resolveFindingLevel, type TreeIssue, type TreeRuleCode } from './config.js';
import { loadTreeContext, readEnabledTreeConfig, type TreeContext, type TreePaths } from './context.js';
import { readIndexedChange, type IndexedChange } from './change-index.js';
import { checkLocalDrift, checkRemoteDrift } from './drift.js';
import { countLines, siblingCapabilities, treeParentOf, type TreeInventory } from './inventory.js';
import { findOverlaps } from './overlap.js';
import { movedAwayDestinations, resolveCapability, resolveRequirement, type TreeRedirects } from './redirects.js';
import { planRestructure, type RestructurePlan } from './restructure.js';

/**
 * Change-level tree rules: placement, stale paths, overlap and drift for a
 * normal change; simulation and conservation for a restructure change.
 */
export async function runTreeChangeRules(context: TreeContext, changeName: string): Promise<TreeIssue[]> {
  const change = await readIndexedChange(context.paths.changesDir, changeName);
  if (change.restructure) {
    return (await planRestructure(context, changeName)).issues;
  }
  const [inventory, redirects] = await Promise.all([context.inventory(), context.redirects()]);
  const issues: TreeIssue[] = [];
  const push: Push = (code, node, issuePath, message, infoOnly = false) => {
    const level = resolveFindingLevel(context.config, code, node);
    if (level === null) return;
    issues.push({ level: infoOnly ? 'INFO' : findingLevelToValidation(level), code, path: issuePath, message });
  };

  const stale = staleTargets(change, inventory, redirects, push);
  checkPlacement(change, inventory, redirects, context, push);
  await checkOverlap(change, context, push);
  await checkDrift(change, context, redirects, stale, push);
  return issues;
}

type Push = (code: TreeRuleCode, node: string, issuePath: string, message: string, infoOnly?: boolean) => void;

const deltaPath = (capability: string) => `${capability}/spec.md`;

function capabilityExists(inventory: TreeInventory, capability: string): boolean {
  return inventory.nodes.get(capability)?.hasSpec === true;
}

/** Report deltas aimed at paths the tree has migrated away from. Returns the stale target keys. */
function staleTargets(
  change: IndexedChange,
  inventory: TreeInventory,
  redirects: TreeRedirects,
  push: Push
): Set<string> {
  const stale = new Set<string>();
  const fix = `Run \`openspec tree rebase ${change.name}\` to follow the recorded redirects.`;
  for (const delta of change.deltas) {
    if (!capabilityExists(inventory, delta.capability)) {
      const resolved = resolveCapability(redirects, delta.capability);
      if (resolved.moved && capabilityExists(inventory, resolved.capability)) {
        push('CHANGE_STALE_PATH', delta.capability, deltaPath(delta.capability),
          `Capability ${delta.capability} was moved to ${resolved.capability}. ${fix}`);
        for (const target of change.targets.filter((t) => t.capability === delta.capability)) {
          stale.add(`${target.capability}\u0000${foldRequirementName(target.name)}`);
        }
        continue;
      }
      if (resolved.cycle) {
        push('CHANGE_STALE_PATH', delta.capability, deltaPath(delta.capability),
          `Redirects for ${delta.capability} form a cycle and do not resolve to an existing capability; fix tree-redirects.yaml.`);
        continue;
      }
      const destinations = movedAwayDestinations(redirects, delta.capability);
      if (destinations.length > 0) {
        push('CHANGE_STALE_PATH', delta.capability, deltaPath(delta.capability),
          `Capability ${delta.capability} no longer exists; its content moved to ${destinations.join(', ')}. ` +
            `Deltas here would recreate a duplicate spec at the old path. ${fix}`);
        for (const target of change.targets.filter((t) => t.capability === delta.capability)) {
          stale.add(`${target.capability}\u0000${foldRequirementName(target.name)}`);
        }
      }
      continue;
    }
    const node = inventory.nodes.get(delta.capability)!;
    for (const target of change.targets.filter((t) => t.capability === delta.capability)) {
      const exists = node.requirements.some(
        (requirement) => foldRequirementName(requirement.name) === foldRequirementName(target.name)
      );
      if (exists) continue;
      const resolved = resolveRequirement(redirects, target.capability, target.name);
      if (resolved.kind === 'unchanged') continue;
      stale.add(`${target.capability}\u0000${foldRequirementName(target.name)}`);
      if (resolved.kind === 'merged') {
        push('CHANGE_STALE_PATH', delta.capability, deltaPath(delta.capability),
          `Requirement "${target.name}" was merged into ${resolved.capability}#${resolved.name}. ` +
            'Rewrite this change against the kept requirement; it cannot be rebased automatically.');
      } else {
        push('CHANGE_STALE_PATH', delta.capability, deltaPath(delta.capability),
          `Requirement "${target.name}" moved to ${resolved.capability}#${resolved.name}. ${fix}`);
      }
    }
  }
  return stale;
}

function checkPlacement(
  change: IndexedChange,
  inventory: TreeInventory,
  redirects: TreeRedirects,
  context: TreeContext,
  push: Push
): void {
  if (change.metadataError && change.added.length > 0) {
    push('CHANGE_PLACEMENT_MISSING', '', '.openspec.yaml',
      `Cannot read placement from .openspec.yaml: ${change.metadataError}`);
    return;
  }
  const placement = change.metadata?.placement ?? [];
  for (const added of change.added) {
    const label = `${added.capability}#${added.name}`;
    const entries = placement.filter(
      (entry) => foldRequirementName(entry.requirement) === foldRequirementName(added.name)
    );
    const entry = entries.find((candidate) => candidate.capability === added.capability);
    if (!entry) {
      const elsewhere = entries.map((candidate) => candidate.capability);
      push('CHANGE_PLACEMENT_MISSING', added.capability, deltaPath(added.capability),
        elsewhere.length > 0
          ? `Placement for ADDED "${added.name}" names ${elsewhere.join(', ')}, but the delta adds it to ${added.capability}.`
          : `ADDED "${added.name}" has no placement entry in .openspec.yaml. Run \`openspec tree context ${added.capability}\`, read the neighbouring specs, and record the decision under placement.`);
      continue;
    }
    const required = new Set<string>();
    if (capabilityExists(inventory, added.capability)) required.add(added.capability);
    const parent = treeParentOf(added.capability);
    if (parent && capabilityExists(inventory, parent)) required.add(parent);
    for (const sibling of siblingCapabilities(inventory, added.capability)) required.add(sibling);
    const reviewed = new Set(entry.reviewed.map((value) => value.replace(/^\/+|\/+$/g, '')));
    const missing = [...required].filter((capability) => !reviewed.has(capability)).sort();
    if (missing.length > 0) {
      push('CHANGE_PLACEMENT_MISSING', added.capability, deltaPath(added.capability),
        `Placement for ${label} must list every reviewed neighbour; missing: ${missing.join(', ')}.`);
    }
    if (entry.decision === 'new-capability') {
      if (capabilityExists(inventory, added.capability)) {
        push('CHANGE_PLACEMENT_MISSING', added.capability, deltaPath(added.capability),
          `Placement for ${label} says new-capability, but ${added.capability} already exists.`);
      } else {
        const parentNode = inventory.nodes.get(parent ?? '');
        const fanout = (parentNode?.children.length ?? 0) + (parentNode?.children.includes(added.capability) ? 0 : 1);
        if (fanout > context.config.maxChildren) {
          push('TREE_FANOUT', parent ?? '', deltaPath(added.capability),
            `Adding ${added.capability} gives ${parent || 'specs/'} ${fanout} children (limit ${context.config.maxChildren}); place it under an existing group or split the parent first.`);
        }
      }
    } else if (entry.decision === 'existing-capability' && !capabilityExists(inventory, added.capability)) {
      push('CHANGE_PLACEMENT_MISSING', added.capability, deltaPath(added.capability),
        `Placement for ${label} says existing-capability, but ${added.capability} does not exist.`);
    }
  }

  // A new capability may start small, but one below the floor is usually a
  // fragment of a neighbour; say so without blocking.
  const { minSpecLines, minRequirements } = context.config;
  for (const delta of change.deltas) {
    if (capabilityExists(inventory, delta.capability) || delta.plan.added.length === 0) continue;
    // A migrated path is reported as CHANGE_STALE_PATH instead.
    if (resolveCapability(redirects, delta.capability).moved || movedAwayDestinations(redirects, delta.capability).length > 0) continue;
    const lines = delta.plan.added.reduce((sum, block) => sum + countLines(block.raw) + 1, 0);
    if (lines >= minSpecLines || delta.plan.added.length >= minRequirements) continue;
    push('TREE_SPEC_TOO_GRANULAR', delta.capability, deltaPath(delta.capability),
      `New capability ${delta.capability} starts with ${delta.plan.added.length} requirement(s) and about ${lines} lines (floor ${minSpecLines} lines or ${minRequirements} requirements); consider adding them to an existing capability instead.`);
  }
}

async function checkOverlap(change: IndexedChange, context: TreeContext, push: Push): Promise<void> {
  const changes = await context.changes();
  const others = changes.some((candidate) => candidate.name === change.name)
    ? changes
    : [...changes, change];
  for (const group of findOverlaps(others)) {
    if (!group.changes.some((entry) => entry.change === change.name)) continue;
    const peers = group.changes.filter((entry) => entry.change !== change.name);
    push('CHANGE_OVERLAP', group.capability, deltaPath(group.capability),
      `${group.capability}#${group.requirement} is also changed by ${peers
        .map((peer) => `${peer.change} (${peer.ops.join('/')})`)
        .join(', ')}; whichever archives last overwrites the others.`);
  }
}

async function checkDrift(
  change: IndexedChange,
  context: TreeContext,
  redirects: TreeRedirects,
  stale: ReadonlySet<string>,
  push: Push
): Promise<void> {
  const bases = await readBases(change.dir);
  for (const target of change.targets) {
    if (stale.has(`${target.capability}\u0000${foldRequirementName(target.name)}`)) continue;
    if (findBaseEntry(bases, target.capability, target.name)) continue;
    const spec = await readMainSpec(context.paths.specsDir, target.capability);
    if (spec === undefined || findRequirementBlock(spec, target.name) === undefined) continue;
    push('CHANGE_BASE_UNPINNED', target.capability, deltaPath(target.capability),
      `${target.ops.join('/')} target ${target.capability}#${target.name} has no base snapshot. Run \`openspec tree pin ${change.name}\` right after writing the delta.`);
  }
  if (!bases || bases.entries.length === 0) return;

  const targeted = bases.entries.filter((entry) =>
    change.targets.some(
      (target) =>
        target.capability === entry.capability &&
        foldRequirementName(target.name) === foldRequirementName(entry.requirement)
    )
  );
  const local = await checkLocalDrift({ version: 1, entries: targeted }, {
    specsDir: context.paths.specsDir,
    redirects,
  });
  const accept = (entry: { capability: string; requirement: string }) =>
    `Merge the newer text into this change's delta, then run \`openspec tree pin ${change.name} --accept "${entry.capability}#${entry.requirement}"\`.`;
  for (const result of local) {
    const { entry } = result;
    const label = `${entry.capability}#${entry.requirement}`;
    if (result.status === 'drift') {
      push('CHANGE_DRIFT', entry.capability, deltaPath(entry.capability),
        `${label} changed in the main spec after this change pinned its base. ${accept(entry)}\n${result.diff}`);
    } else if (result.status === 'removed') {
      push('CHANGE_DRIFT', entry.capability, deltaPath(entry.capability),
        `${label} (pinned base) no longer exists in the main specs and no redirect records where it went (removed upstream).`);
    } else if (result.status === 'merged') {
      push('CHANGE_DRIFT', entry.capability, deltaPath(entry.capability),
        `${label} was merged into ${result.mergedInto!.capability}#${result.mergedInto!.requirement}; rewrite this change against the kept requirement.`);
    }
  }

  const baseRef = context.baseRef;
  if (!baseRef) return;
  const clean = local.filter((result) => result.status === 'clean' || result.status === 'moved').map((result) => result.entry);
  if (clean.length === 0) return;
  const remote = await checkRemoteDrift({ version: 1, entries: clean }, {
    specsDir: context.paths.specsDir,
    openspecDir: context.paths.openspecDir,
    git: context.git(),
    baseRef,
    localRedirects: redirects,
  });
  if (remote.skipped) {
    // A missing base ref never fails validation: it is information only.
    push('CHANGE_REMOTE_DRIFT', '', 'bases.yaml', `Remote drift check skipped: ${remote.skipped}.`, true);
    return;
  }
  for (const result of remote.results) {
    if (result.status === 'clean' || result.status === 'moved') continue;
    const { entry } = result;
    push('CHANGE_REMOTE_DRIFT', entry.capability, deltaPath(entry.capability),
      `${entry.capability}#${entry.requirement} already differs on ${baseRef} (${result.status}); rebase onto ${baseRef} and reconcile before archiving.${result.diff ? `\n${result.diff}` : ''}`);
  }
}

/**
 * Validator hook: tree issues for one change directory, or undefined when
 * tree governance is off for the project. `restructure` tells the caller to
 * accept a change without deltas.
 */
export async function collectTreeValidationIssues(
  changeDir: string,
  options: { projectRoot: string; mainSpecsDir: string; context?: TreeContext }
): Promise<{ issues: TreeIssue[]; restructure: boolean } | undefined> {
  const changesDir = path.dirname(changeDir);
  const context =
    options.context ??
    loadTreeContext({
      projectRoot: options.projectRoot,
      openspecDir: path.dirname(changesDir),
      specsDir: options.mainSpecsDir,
      changesDir,
      archiveDir: path.join(changesDir, 'archive'),
    });
  if (!context) return undefined;
  const name = path.basename(changeDir);
  const change = await readIndexedChange(changesDir, name);
  return { issues: await runTreeChangeRules(context, name), restructure: change.restructure };
}

/** Whether tree governance is on and the change declares `restructure: true`. */
export function isTreeRestructureChange(changeDir: string, projectRoot: string): boolean {
  if (!readEnabledTreeConfig(projectRoot)) return false;
  try {
    const raw = parseYaml(readFileSync(path.join(changeDir, '.openspec.yaml'), 'utf-8')) as unknown;
    return typeof raw === 'object' && raw !== null && (raw as { restructure?: unknown }).restructure === true;
  } catch {
    return false;
  }
}

export type TreeArchiveGate =
  | { kind: 'normal' }
  | { kind: 'blocked'; code: string; message: string; fix: string }
  | { kind: 'restructure'; context: TreeContext; plan: RestructurePlan };

/** Archive codes for the tree rules that refuse an archive. */
const ARCHIVE_BLOCKING: Record<string, string> = { CHANGE_DRIFT: 'drift', CHANGE_STALE_PATH: 'stale_path' };

/**
 * Archive hook: refuse a normal change whose base drifted or whose deltas
 * point at a migrated path (when those rules are errors), and hand restructure
 * changes to the manifest path. Undefined when tree governance is off.
 */
export async function prepareTreeArchive(
  paths: TreePaths,
  changeName: string,
  options: { skipSpecs: boolean }
): Promise<TreeArchiveGate | undefined> {
  const context = loadTreeContext(paths);
  if (!context) return undefined;
  const change = await readIndexedChange(paths.changesDir, changeName);
  if (change.restructure) {
    return { kind: 'restructure', context, plan: await planRestructure(context, changeName) };
  }
  if (options.skipSpecs) return { kind: 'normal' };
  const blocking = (await runTreeChangeRules(context, changeName)).filter(
    (issue) => issue.level === 'ERROR' && ARCHIVE_BLOCKING[issue.code] !== undefined
  );
  if (blocking.length === 0) return { kind: 'normal' };
  const drift = blocking.find((issue) => issue.code === 'CHANGE_DRIFT');
  const first = drift ?? blocking[0];
  return {
    kind: 'blocked',
    code: ARCHIVE_BLOCKING[first.code],
    message: `Cannot archive '${changeName}': ${blocking.map((issue) => `[${issue.code}] ${issue.message}`).join('\n')}`,
    fix: drift
      ? `Reconcile the drifted requirements, then run openspec tree pin ${changeName} --accept "<capability>#<requirement>" for each and rerun.`
      : `Run openspec tree rebase ${changeName}, then rerun.`,
  };
}
