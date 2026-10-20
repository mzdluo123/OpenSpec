import chalk from 'chalk';
import { promises as fs } from 'fs';
import path from 'path';
import {
  isStoreSelectedRoot,
  resolveRootForCommand,
  toRootOutput,
  type ResolvedOpenSpecRoot,
} from '../core/root-selection.js';
import { isWithinSubtree, normalizeTreePath } from '../core/tree/config.js';
import {
  loadTreeContext,
  readEnabledTreeConfig,
  treePathsFor,
  TreeContext,
} from '../core/tree/context.js';
import { readIndexedChange } from '../core/tree/change-index.js';
import {
  acceptBase,
  basesPath,
  findRequirementBlock,
  parseAcceptTarget,
  pinChange,
  readBases,
  readMainSpec,
  serializeBases,
  type PinReport,
} from '../core/tree/bases.js';
import { checkLocalDrift, checkRemoteDrift, type DriftResult } from '../core/tree/drift.js';
import { planRebaseOps, rewriteChangeTree, type ChangeRewrite } from '../core/tree/inflight-rewrite.js';
import {
  buildNodeContext,
  INSTRUCTION_OPS,
  instructionsFromFindings,
  placeInstructions,
  type InstructionOp,
} from '../core/tree/instructions.js';
import {
  appendImportedRedirects,
  findImportableRedirects,
  migrateInit,
  migratePlan,
  migrateStatus,
  structuralFindings,
} from '../core/tree/migrate.js';
import { describeOperation } from '../core/tree/manifest.js';
import { findOverlaps } from '../core/tree/overlap.js';
import { resolveRequirement } from '../core/tree/redirects.js';
import { planRestructure } from '../core/tree/restructure.js';
import { displayNode, summarizeFindings } from '../core/tree/rules.js';
import { diffTrees, readSpecsTree } from '../core/tree/simulate.js';
import { pruneEmptyDirs } from '../core/specs-apply.js';

export interface TreeCommonOptions {
  json?: boolean;
}

export class TreeCommandError extends Error {
  readonly diagnostic: { severity: 'error'; code: string; message: string; fix?: string };
  constructor(code: string, message: string, fix?: string) {
    super(message);
    this.diagnostic = { severity: 'error', code, message, ...(fix ? { fix } : {}) };
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function resolveTreeRoot(options: TreeCommonOptions): Promise<ResolvedOpenSpecRoot | null> {
  const root = await resolveRootForCommand({}, { json: options.json, allowImplicitRoot: false });
  if (root && isStoreSelectedRoot(root)) {
    throw new TreeCommandError(
      'TREE_STORE_UNSUPPORTED',
      'Tree governance does not support store roots yet.',
      'Run openspec tree in the project that owns openspec/specs.'
    );
  }
  return root;
}

async function requireContext(options: TreeCommonOptions & { base?: string }): Promise<TreeContext | null> {
  const root = await resolveTreeRoot(options);
  if (!root) return null;
  const context = loadTreeContext(treePathsFor(root), options.base);
  if (!context) {
    throw new TreeCommandError(
      'TREE_NOT_ENABLED',
      'Tree governance is not enabled for this project (no `tree.enabled: true` in openspec/config.yaml).',
      'Run openspec tree migrate init'
    );
  }
  return context;
}

async function assertChangeExists(context: TreeContext, change: string): Promise<void> {
  const stat = await fs.stat(path.join(context.paths.changesDir, change)).catch(() => null);
  if (!stat?.isDirectory() || change === 'archive' || change.includes('/') || change.includes('\\')) {
    throw new TreeCommandError('TREE_CHANGE_NOT_FOUND', `Change '${change}' not found.`);
  }
}

function levelSymbol(level: string): string {
  return level === 'error' || level === 'ERROR' ? chalk.red('✗') : level === 'warning' || level === 'WARNING' ? chalk.yellow('⚠') : chalk.dim('ℹ');
}

// ---------------------------------------------------------------------------
// check / instructions / context / overlap
// ---------------------------------------------------------------------------

export async function treeCheckCommand(options: TreeCommonOptions & { scope?: string }): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const scope = options.scope !== undefined ? normalizeTreePath(options.scope) : undefined;
  const inventory = await context.inventory();
  if (scope !== undefined && scope !== '' && !inventory.nodes.has(scope)) {
    throw new TreeCommandError('TREE_SCOPE_NOT_FOUND', `No node '${scope}' under openspec/specs.`);
  }
  const findings = (await structuralFindings(context)).filter(
    (finding) => scope === undefined || isWithinSubtree(finding.node, scope)
  );
  const summary = summarizeFindings(inventory, findings);
  process.exitCode = summary.errors > 0 ? 1 : 0;
  if (options.json) {
    printJson({
      root: context.paths.projectRoot,
      config: {
        maxChildren: context.config.maxChildren,
        maxSpecLines: context.config.maxSpecLines,
        maxRequirements: context.config.maxRequirements,
        mergeBelowLines: context.config.mergeBelowLines,
        maxDepth: context.config.maxDepth,
        reviewAfterArchives: context.config.reviewAfterArchives,
        scope: context.config.scope,
      },
      ...(scope !== undefined ? { scope } : {}),
      summary,
      findings,
    });
    return;
  }
  for (const finding of findings) {
    console.log(`${levelSymbol(finding.level)} [${finding.code}] ${finding.message}`);
  }
  console.log(
    `Nodes: ${summary.nodes}, capabilities: ${summary.capabilities}; ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info`
  );
}

export async function treeInstructionsCommand(
  options: TreeCommonOptions & { scope?: string; op?: string }
): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const op = options.op?.toUpperCase() as InstructionOp | undefined;
  if (op !== undefined && !INSTRUCTION_OPS.includes(op)) {
    throw new TreeCommandError('TREE_UNKNOWN_OP', `Unknown --op '${options.op}'. Use one of ${INSTRUCTION_OPS.join(', ')}.`);
  }
  const scope = options.scope !== undefined ? normalizeTreePath(options.scope) : undefined;
  const [inventory, changes, findings] = await Promise.all([
    context.inventory(),
    context.changes(),
    structuralFindings(context),
  ]);
  const instructions = [
    ...instructionsFromFindings(findings, inventory, changes, context.config),
    ...placeInstructions(inventory, changes),
  ].filter(
    (instruction) =>
      (op === undefined || instruction.op === op) &&
      (scope === undefined || isWithinSubtree(instruction.node, scope))
  );
  if (options.json) {
    printJson({ instructions });
    return;
  }
  if (instructions.length === 0) {
    console.log('No instructions.');
    return;
  }
  for (const instruction of instructions) {
    console.log(`${instruction.id}  [${instruction.op}] ${instruction.trigger.code} ${displayNode(instruction.node)}`);
    console.log(`  allowed: ${instruction.allowedManifestOps.join(', ') || '(no manifest)'}`);
    for (const constraint of instruction.constraints) console.log(`  - ${constraint}`);
    console.log(`  accept: ${instruction.acceptance}`);
  }
  console.log('Use --json for the full inputs of each instruction.');
}

export async function treeContextCommand(nodePath: string, options: TreeCommonOptions): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const target = normalizeTreePath(nodePath);
  const result = buildNodeContext(await context.inventory(), await context.changes(), target);
  if (options.json) {
    printJson(result);
    return;
  }
  const describe = (summary: { path: string; kind: string; purpose?: string; requirements: string[]; lines: number }) => {
    console.log(`  ${summary.path} (${summary.kind}, ${summary.lines} lines, ${summary.requirements.length} requirements)`);
    if (summary.purpose) console.log(`    purpose: ${summary.purpose.split('\n')[0]}`);
    for (const requirement of summary.requirements) console.log(`    - ${requirement}`);
  };
  console.log(`Node ${target}${result.exists ? '' : ' (does not exist yet)'}`);
  if (result.target) describe(result.target);
  if (result.parent) {
    console.log('Parent:');
    describe(result.parent);
  }
  console.log(`Siblings (${result.siblings.length}):`);
  result.siblings.forEach(describe);
  if (result.children.length > 0) {
    console.log(`Children (${result.children.length}):`);
    result.children.forEach(describe);
  }
  if (result.openChanges.length > 0) {
    console.log('In-flight changes touching these nodes:');
    for (const entry of result.openChanges) console.log(`  ${entry.change}: ${entry.capabilities.join(', ')}`);
  }
}

export async function treeOverlapCommand(options: TreeCommonOptions): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const overlaps = findOverlaps(await context.changes());
  if (options.json) {
    printJson({ count: overlaps.length, overlaps });
    return;
  }
  for (const group of overlaps) {
    console.log(`${group.capability}#${group.requirement}`);
    for (const entry of group.changes) console.log(`  ${entry.change} (${entry.ops.join('/')})`);
  }
  console.log(`${overlaps.length} requirement(s) changed by more than one in-flight change.`);
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export async function treePlanCommand(change: string, options: TreeCommonOptions): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  await assertChangeExists(context, change);
  const plan = await planRestructure(context, change);
  if (!plan.change.restructure) {
    throw new TreeCommandError(
      'TREE_NOT_RESTRUCTURE',
      `Change '${change}' is not a restructure change (no \`restructure: true\` in .openspec.yaml).`
    );
  }
  const relative = (target: string) => path.relative(context.paths.projectRoot, target).split(path.sep).join('/');
  const specsRelative = relative(context.paths.specsDir);
  const output = {
    change,
    valid: !plan.issues.some((issue) => issue.level === 'ERROR') && plan.inflight.conflicts.length === 0,
    operations: (plan.manifest?.operations ?? []).map(describeOperation),
    files: plan.specOperations.map((operation) => ({
      action: operation.action,
      path: `${specsRelative}/${operation.path}`,
    })),
    inflight: plan.inflight.rewrites.map((rewrite: ChangeRewrite) => ({
      change: rewrite.change,
      notes: rewrite.notes,
      writes: rewrite.writes.map((write) => relative(write.path)),
      deletes: rewrite.deletes.map(relative),
    })),
    conflicts: plan.inflight.conflicts,
    redirects: plan.redirectSteps,
    ...(plan.reviewNode !== undefined ? { review: plan.reviewNode } : {}),
    issues: plan.issues,
  };
  process.exitCode = output.valid ? 0 : 1;
  if (options.json) {
    printJson(output);
    return;
  }
  console.log(`Restructure plan for '${change}' (nothing is written):`);
  for (const operation of output.operations) console.log(`  op  ${operation}`);
  for (const file of output.files) console.log(`  ${file.action === 'write' ? 'write ' : 'delete'} ${file.path}`);
  for (const rewrite of output.inflight) {
    console.log(`  rewrite in-flight change ${rewrite.change}: ${rewrite.notes.join('; ')}`);
  }
  for (const conflict of output.conflicts) {
    console.log(chalk.red(`  conflict ${conflict.change}: ${conflict.reason}`));
  }
  console.log(`  redirects appended: ${output.redirects.length}`);
  for (const issue of plan.issues) {
    console.log(`${levelSymbol(issue.level)} [${issue.code}] ${issue.path}: ${issue.message}`);
  }
}

// ---------------------------------------------------------------------------
// pin / drift / rebase
// ---------------------------------------------------------------------------

export async function treePinCommand(
  change: string | undefined,
  options: TreeCommonOptions & { all?: boolean; from?: string; accept?: string; base?: string }
): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const from = options.from ?? 'worktree';
  if (from !== 'worktree' && from !== 'merge-base') {
    throw new TreeCommandError('TREE_PIN_FROM_INVALID', `--from must be worktree or merge-base, got '${from}'.`);
  }
  if (options.all && change) {
    throw new TreeCommandError('TREE_PIN_ARGS', 'Pass either a change name or --all, not both.');
  }
  if (!options.all && !change) {
    throw new TreeCommandError('TREE_PIN_ARGS', 'A change name (or --all) is required.');
  }
  if (options.accept && options.all) {
    throw new TreeCommandError('TREE_PIN_ARGS', '--accept works on one change and one requirement at a time.');
  }

  if (options.accept) {
    await assertChangeExists(context, change!);
    const target = parseAcceptTarget(options.accept);
    const changeDir = path.join(context.paths.changesDir, change!);
    const bases = await readBases(changeDir);
    const resolved = resolveRequirement(await context.redirects(), target.capability, target.requirement);
    const spec = await readMainSpec(context.paths.specsDir, resolved.capability);
    const text = spec === undefined ? undefined : findRequirementBlock(spec, resolved.name);
    if (text === undefined || resolved.kind === 'merged') {
      throw new TreeCommandError(
        'TREE_ACCEPT_TARGET_MISSING',
        `${target.capability}#${target.requirement} is not in the main specs${resolved.kind === 'merged' ? ` (merged into ${resolved.capability}#${resolved.name})` : ''}; nothing to accept.`
      );
    }
    const updated = await acceptBase(bases, target, {
      capability: resolved.capability,
      requirement: resolved.name,
      text,
    });
    await fs.writeFile(basesPath(changeDir), serializeBases(updated));
    const entry = updated.entries.find((candidate) => candidate.source === 'accepted' && candidate.requirement === resolved.name);
    if (options.json) {
      printJson({ change, accepted: { capability: resolved.capability, requirement: resolved.name, previous: entry?.previous ?? null } });
    } else {
      console.log(`Accepted the current text of ${resolved.capability}#${resolved.name} as the base for '${change}' (previous ${entry?.previous?.slice(0, 12) ?? '-'}).`);
    }
    return;
  }

  const names = options.all ? (await context.changes()).filter((c) => !c.restructure).map((c) => c.name) : [change!];
  if (!options.all) await assertChangeExists(context, change!);
  const reports: Array<{ change: string; report: PinReport }> = [];
  for (const name of names) {
    const indexed = await readIndexedChange(context.paths.changesDir, name);
    if (indexed.restructure) {
      throw new TreeCommandError('TREE_PIN_RESTRUCTURE', `Change '${name}' is a restructure change; restructure changes do not use base snapshots.`);
    }
    const existing = await readBases(indexed.dir);
    const { bases, report } = await pinChange(indexed, existing, {
      specsDir: context.paths.specsDir,
      from,
      git: context.git(),
      baseRef: context.baseRef,
    });
    if (bases.entries.length > 0 || existing) {
      await fs.writeFile(basesPath(indexed.dir), serializeBases(bases));
    }
    reports.push({ change: name, report });
  }
  if (options.json) {
    printJson({ changes: reports.map(({ change: name, report }) => ({ change: name, ...report })) });
    return;
  }
  for (const { change: name, report } of reports) {
    if (report.pinned.length + report.skipped.length + report.pruned.length + report.warnings.length === 0) continue;
    console.log(`${name}: pinned ${report.pinned.length}, kept ${report.kept.length}, pruned ${report.pruned.length}`);
    for (const skipped of report.skipped) console.log(chalk.yellow(`  ⚠ ${skipped.capability}#${skipped.requirement}: ${skipped.reason}`));
    for (const warning of report.warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));
  }
  const pinned = reports.reduce((sum, { report }) => sum + report.pinned.length, 0);
  console.log(`Pinned ${pinned} base(s) across ${reports.length} change(s).`);
}

export async function treeDriftCommand(
  change: string | undefined,
  options: TreeCommonOptions & { base?: string }
): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  if (change) await assertChangeExists(context, change);
  const names = change ? [change] : (await context.changes()).map((c) => c.name);
  const redirects = await context.redirects();
  const results: Array<{ change: string; local: DriftResult[]; remote?: { baseRef: string; skipped?: string; results: DriftResult[] } }> = [];
  for (const name of names) {
    const bases = await readBases(path.join(context.paths.changesDir, name));
    if (!bases) continue;
    const local = await checkLocalDrift(bases, { specsDir: context.paths.specsDir, redirects });
    const remote = context.baseRef
      ? await checkRemoteDrift(bases, {
          specsDir: context.paths.specsDir,
          openspecDir: context.paths.openspecDir,
          git: context.git(),
          baseRef: context.baseRef,
          localRedirects: redirects,
        })
      : undefined;
    results.push({ change: name, local, ...(remote ? { remote } : {}) });
  }
  const drifted = results.some((entry) => entry.local.some((result) => ['drift', 'removed', 'merged'].includes(result.status)));
  process.exitCode = drifted ? 1 : 0;
  if (options.json) {
    const shape = (result: DriftResult) => ({
      capability: result.entry.capability,
      requirement: result.entry.requirement,
      status: result.status,
      ...(result.current ? { current: { capability: result.current.capability, requirement: result.current.requirement } } : {}),
      ...(result.mergedInto ? { mergedInto: result.mergedInto } : {}),
      ...(result.diff ? { diff: result.diff } : {}),
    });
    printJson({
      changes: results.map((entry) => ({
        change: entry.change,
        local: entry.local.map(shape),
        ...(entry.remote
          ? { remote: { baseRef: entry.remote.baseRef, ...(entry.remote.skipped ? { skipped: entry.remote.skipped } : {}), results: entry.remote.results.map(shape) } }
          : {}),
      })),
    });
    return;
  }
  for (const entry of results) {
    const notable = entry.local.filter((result) => result.status !== 'clean');
    const remoteNotable = entry.remote?.results.filter((result) => result.status !== 'clean' && result.status !== 'moved') ?? [];
    if (notable.length === 0 && remoteNotable.length === 0 && !entry.remote?.skipped) continue;
    console.log(entry.change);
    for (const result of notable) {
      console.log(`  ${result.status.padEnd(7)} ${result.entry.capability}#${result.entry.requirement}`);
      if (result.diff) console.log(result.diff.split('\n').map((line) => `    ${line}`).join('\n'));
    }
    if (entry.remote?.skipped) console.log(chalk.dim(`  remote check skipped: ${entry.remote.skipped}`));
    for (const result of remoteNotable) {
      console.log(`  remote ${result.status} on ${entry.remote!.baseRef}: ${result.entry.capability}#${result.entry.requirement}`);
    }
  }
  if (!drifted) console.log('No local drift.');
}

export async function treeRebaseCommand(change: string, options: TreeCommonOptions & { dryRun?: boolean }): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  await assertChangeExists(context, change);
  const indexed = await readIndexedChange(context.paths.changesDir, change);
  const { ops, conflicts } = planRebaseOps(indexed, await context.inventory(), await context.redirects());
  const specsDir = path.join(indexed.dir, 'specs');
  const tree = await readSpecsTree(specsDir);
  const bases = await readBases(indexed.dir);
  const rewritten = rewriteChangeTree(change, tree, bases, ops);
  const allConflicts = [...conflicts, ...rewritten.conflicts];
  const fileOps = diffTrees(tree, rewritten.tree);
  const basesChanged = bases !== undefined && rewritten.bases !== undefined && serializeBases(bases) !== serializeBases(rewritten.bases);

  if (allConflicts.length > 0) {
    if (options.json) {
      printJson({ change, rebased: false, conflicts: allConflicts, status: [{ severity: 'error', code: 'RESTRUCTURE_INFLIGHT_CONFLICT', message: allConflicts.map((c) => c.reason).join('; ') }] });
      process.exitCode = 1;
      return;
    }
    throw new TreeCommandError(
      'RESTRUCTURE_INFLIGHT_CONFLICT',
      `Cannot rebase '${change}' automatically: ${allConflicts.map((c) => c.reason).join('; ')}`
    );
  }
  if (!options.dryRun) {
    for (const operation of fileOps.filter((op) => op.action === 'write')) {
      const target = path.join(specsDir, ...operation.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, operation.content!);
    }
    for (const operation of fileOps.filter((op) => op.action === 'delete')) {
      const target = path.join(specsDir, ...operation.path.split('/'));
      await fs.rm(target, { force: true });
      await pruneEmptyDirs(path.dirname(target), specsDir);
    }
    if (basesChanged) await fs.writeFile(basesPath(indexed.dir), serializeBases(rewritten.bases!));
  }
  const files = fileOps.map((op) => ({ action: op.action, path: `specs/${op.path}` }));
  if (options.json) {
    printJson({ change, rebased: !options.dryRun && (files.length > 0 || basesChanged), dryRun: !!options.dryRun, moves: rewritten.notes, files, basesUpdated: basesChanged });
    return;
  }
  if (rewritten.notes.length === 0) {
    console.log(`Change '${change}' already follows the current tree; nothing to rebase.`);
    return;
  }
  console.log(`${options.dryRun ? 'Would rebase' : 'Rebased'} '${change}':`);
  for (const note of rewritten.notes) console.log(`  ${note}`);
  if (basesChanged) console.log('  bases.yaml paths updated');
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export async function treeMigrateInitCommand(options: TreeCommonOptions & { base?: string }): Promise<void> {
  const root = await resolveTreeRoot(options);
  if (!root) return;
  const paths = treePathsFor(root);
  const result = await migrateInit(paths, { baseRef: options.base });
  if (options.json) {
    printJson({ initialized: true, config: result.configPath, created: result.created, root: toRootOutput(root) });
    return;
  }
  console.log(`Tree governance enabled in ${path.relative(process.cwd(), result.configPath) || result.configPath} (all rules warn, scope: whole tree).`);
  for (const created of result.created) console.log(`Created ${path.relative(process.cwd(), created) || created}`);
  console.log('Next: openspec tree migrate status');
}

export async function treeMigrateStatusCommand(options: TreeCommonOptions): Promise<void> {
  const root = await resolveTreeRoot(options);
  if (!root) return;
  const paths = treePathsFor(root);
  if (!readEnabledTreeConfig(paths.projectRoot)) {
    if (options.json) {
      printJson({ phase: 0, phaseName: 'enable observation', enabled: false, complete: false });
    } else {
      console.log('Phase 0 (enable observation): tree governance is not enabled. Run openspec tree migrate init.');
    }
    return;
  }
  const context = loadTreeContext(paths)!;
  const status = await migrateStatus(context);
  if (options.json) {
    printJson({ enabled: true, ...status });
    return;
  }
  console.log(`Phase ${status.phase} (${status.phaseName})${status.complete ? ' - migration complete' : ''}`);
  console.log(`In-flight changes: ${status.inflightChanges}${status.maxOpenChanges !== undefined ? ` (limit ${status.maxOpenChanges})` : ''}; overlapping requirements: ${status.overlaps}`);
  console.log(`Last review: ${status.lastReview ?? 'never'}; unreviewed domains: ${status.unreviewed.length > 0 ? status.unreviewed.join(', ') : 'none'}`);
  console.log('Structural findings:');
  for (const [code, count] of Object.entries(status.rules).sort()) console.log(`  ${code}: ${count}`);
  console.log('Change findings:');
  for (const [code, count] of Object.entries(status.changeIssues.byCode).sort()) console.log(`  ${code}: ${count}`);
  if (status.ungatedRules.length > 0) console.log(`Not yet gated (error): ${status.ungatedRules.join(', ')}`);
}

export async function treeMigratePlanCommand(options: TreeCommonOptions & { phase?: string }): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  const phase = options.phase !== undefined ? Number(options.phase) : undefined;
  const plan = await migratePlan(context, phase);
  if (options.json) {
    printJson(plan);
    return;
  }
  console.log(`Phase ${plan.phase} (${plan.phaseName}):`);
  for (const task of plan.tasks) console.log(`  [${task.code}]${task.change ? ` ${task.change}:` : ''} ${task.action}`);
  for (const instruction of plan.instructions) {
    console.log(`  ${instruction.id} [${instruction.op}] allowed: ${instruction.allowedManifestOps.join(', ') || '-'}`);
  }
  if (plan.tasks.length + plan.instructions.length === 0) console.log('  Nothing to do in this phase.');
}

export async function treeMigrateImportRedirectsCommand(
  options: TreeCommonOptions & { fromGit?: string; yes?: boolean }
): Promise<void> {
  const context = await requireContext(options);
  if (!context) return;
  if (!options.fromGit) {
    throw new TreeCommandError('TREE_IMPORT_RANGE_REQUIRED', '--from-git <commit-range> is required.');
  }
  const imported = await findImportableRedirects(context, options.fromGit);
  let written = 0;
  if (imported.length > 0 && options.yes) {
    written = await appendImportedRedirects(context, imported);
  } else if (imported.length > 0 && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
    for (const entry of imported) console.log(`  ${entry.date} ${entry.commit.slice(0, 12)} ${entry.from} -> ${entry.to}`);
    // Lazy like every other prompt in the CLI: @inquirer is a startup cost only interactive runs pay.
    const { confirm } = await import('@inquirer/prompts');
    if (await confirm({ message: `Append ${imported.length} capability redirect(s) to tree-redirects.yaml?`, default: false })) {
      written = await appendImportedRedirects(context, imported);
    }
  }
  if (options.json) {
    printJson({ range: options.fromGit, found: imported, written });
    return;
  }
  if (imported.length === 0) {
    console.log('No new spec.md renames found in that range.');
    return;
  }
  if (written === 0) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      for (const entry of imported) console.log(`  ${entry.date} ${entry.commit.slice(0, 12)} ${entry.from} -> ${entry.to}`);
    }
    console.log(`Found ${imported.length} rename(s); nothing written. Rerun with --yes after review to append them.`);
    return;
  }
  console.log(`Appended ${written} redirect(s). Moves done as delete + create are not detected; add those by hand.`);
}
