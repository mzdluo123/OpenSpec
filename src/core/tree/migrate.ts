import { promises as fs } from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';
import { resolveConfigFilePath } from '../project-config.js';
import {
  DEFAULT_ENFORCEMENT,
  TREE_RULE_CODES,
  type EnforcementLevel,
  type TreeRuleCode,
} from './config.js';
import { runTreeChangeRules } from './change-rules.js';
import type { TreeContext, TreePaths } from './context.js';
import { instructionsFromFindings, type TreeInstruction } from './instructions.js';
import { findOverlaps } from './overlap.js';
import { emptyRedirects, redirectsPath, serializeRedirects, type RedirectEntry } from './redirects.js';
import { runTreeRules, type TreeFinding } from './rules.js';
import {
  emptyTreeState,
  lastReviewFor,
  listArchivedChanges,
  readTreeState,
  serializeTreeState,
  treeStatePath,
} from './state.js';

/**
 * Migration from a plain OpenSpec project to tree governance. Every structural
 * step is an ordinary restructure change; these helpers only observe, plan
 * and write the governance files.
 */

export const MIGRATION_PHASES = [
  { phase: 0, name: 'enable observation' },
  { phase: 1, name: 'converge in-flight changes' },
  { phase: 2, name: 'shape the directory tree' },
  { phase: 3, name: 'split oversized specs' },
  { phase: 4, name: 'single-ownership review' },
  { phase: 5, name: 'tighten gates' },
] as const;

/** Rules that phase 5 turns into errors. */
export const GATED_RULES: readonly TreeRuleCode[] = [
  'TREE_FANOUT',
  'TREE_SPEC_TOO_LONG',
  'TREE_DEPTH',
  'TREE_EMPTY_NODE',
  'CHANGE_PLACEMENT_MISSING',
  'CHANGE_STALE_PATH',
  'CHANGE_DRIFT',
];

/** Enforcement written by `migrate init`: every rule observes (warn), advisory rules stay info. */
export function observationEnforcement(): Record<TreeRuleCode, EnforcementLevel> {
  const result = {} as Record<TreeRuleCode, EnforcementLevel>;
  for (const code of TREE_RULE_CODES) {
    result[code] = DEFAULT_ENFORCEMENT[code] === 'info' ? 'info' : 'warn';
  }
  return result;
}

export interface InitResult {
  configPath: string;
  created: string[];
}

export async function migrateInit(
  paths: Pick<TreePaths, 'projectRoot' | 'openspecDir'>,
  options: { baseRef?: string } = {}
): Promise<InitResult> {
  const configPath = resolveConfigFilePath(paths.projectRoot) ?? path.join(paths.openspecDir, 'config.yaml');
  const existing = await fs.readFile(configPath, 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'schema: spec-driven\n';
    throw error;
  });
  const document = parseDocument(existing);
  if (document.errors.length > 0) {
    throw new Error(`Cannot update ${configPath}: ${document.errors[0].message}`);
  }
  if (document.has('tree')) {
    throw new Error(`${configPath} already has a tree section; tree governance is already initialized.`);
  }
  document.set('tree', {
    enabled: true,
    maxChildren: 20,
    maxSpecLines: 300,
    maxRequirements: 15,
    minSpecLines: 60,
    minRequirements: 3,
    mergeBelowLines: 80,
    maxRequirementTextLength: 500,
    maxDepth: 4,
    reviewAfterArchives: 10,
    scope: [],
    enforcement: observationEnforcement(),
    ...(options.baseRef ? { drift: { baseRef: options.baseRef } } : {}),
  });
  const created: string[] = [];
  await fs.writeFile(configPath, document.toString({ lineWidth: 0 }));
  const redirects = redirectsPath(paths.openspecDir);
  if (!(await exists(redirects))) {
    await fs.writeFile(redirects, serializeRedirects(emptyRedirects()));
    created.push(redirects);
  }
  const state = treeStatePath(paths.openspecDir);
  if (!(await exists(state))) {
    await fs.writeFile(state, serializeTreeState(emptyTreeState()));
    created.push(state);
  }
  return { configPath, created };
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false
  );
}

export interface ChangeIssueCounts {
  stalePaths: number;
  drift: number;
  unpinned: number;
  placementMissing: number;
  /** Change-level counts by code, including warnings. */
  byCode: Record<string, number>;
  byChange: Array<{ change: string; codes: string[] }>;
}

export async function collectChangeIssues(context: TreeContext): Promise<ChangeIssueCounts> {
  const changes = await context.changes();
  const byCode: Record<string, number> = {};
  const byChange: Array<{ change: string; codes: string[] }> = [];
  for (const change of changes) {
    const issues = await runTreeChangeRules(context, change.name);
    const codes = [...new Set(issues.filter((issue) => issue.level !== 'INFO').map((issue) => issue.code))];
    for (const issue of issues) {
      if (issue.level === 'INFO') continue;
      byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
    }
    if (codes.length > 0) byChange.push({ change: change.name, codes });
  }
  return {
    stalePaths: byCode.CHANGE_STALE_PATH ?? 0,
    drift: byCode.CHANGE_DRIFT ?? 0,
    unpinned: byCode.CHANGE_BASE_UNPINNED ?? 0,
    placementMissing: byCode.CHANGE_PLACEMENT_MISSING ?? 0,
    byCode,
    byChange,
  };
}

export async function structuralFindings(context: TreeContext): Promise<TreeFinding[]> {
  const [inventory, archives, state] = await Promise.all([
    context.inventory(),
    listArchivedChanges(context.paths.archiveDir),
    readTreeState(context.paths.openspecDir),
  ]);
  return runTreeRules({ inventory, config: context.config, archives, state });
}

export interface MigrationStatus {
  phase: number;
  phaseName: string;
  complete: boolean;
  rules: Record<string, number>;
  inflightChanges: number;
  maxOpenChanges?: number;
  overlaps: number;
  lastReview: string | null;
  unreviewed: string[];
  changeIssues: ChangeIssueCounts;
  ungatedRules: TreeRuleCode[];
}

export async function migrateStatus(context: TreeContext): Promise<MigrationStatus> {
  const [findings, changes, inventory, state, changeIssues] = await Promise.all([
    structuralFindings(context),
    context.changes(),
    context.inventory(),
    readTreeState(context.paths.openspecDir),
    collectChangeIssues(context),
  ]);
  const rules: Record<string, number> = {};
  for (const finding of findings) rules[finding.code] = (rules[finding.code] ?? 0) + 1;
  const domains = inventory.nodes.get('')?.children ?? [];
  const unreviewed = domains.filter((domain) => lastReviewFor(state, domain) === undefined);
  const lastReview = state.reviews.reduce<string | null>(
    (latest, review) => (latest === null || review.reviewedAt > latest ? review.reviewedAt : latest),
    null
  );
  const ungatedRules = GATED_RULES.filter((code) => context.config.enforcement[code] !== 'error');
  const tooManyChanges =
    context.config.maxOpenChanges !== undefined && changes.length > context.config.maxOpenChanges;

  let phase = 5;
  if (tooManyChanges || changeIssues.stalePaths + changeIssues.drift + changeIssues.unpinned > 0) phase = 1;
  else if ((rules.TREE_FANOUT ?? 0) + (rules.TREE_DEPTH ?? 0) > 0) phase = 2;
  else if ((rules.TREE_SPEC_TOO_LONG ?? 0) > 0) phase = 3;
  else if (unreviewed.length > 0) phase = 4;

  return {
    phase,
    phaseName: MIGRATION_PHASES[phase].name,
    complete: phase === 5 && ungatedRules.length === 0,
    rules,
    inflightChanges: changes.length,
    ...(context.config.maxOpenChanges !== undefined ? { maxOpenChanges: context.config.maxOpenChanges } : {}),
    overlaps: findOverlaps(changes).length,
    lastReview,
    unreviewed,
    changeIssues,
    ungatedRules,
  };
}

export interface PhaseTask {
  change?: string;
  code: string;
  action: string;
}

export interface MigrationPlan {
  phase: number;
  phaseName: string;
  instructions: TreeInstruction[];
  tasks: PhaseTask[];
}

const CHANGE_ACTIONS: Record<string, (change: string) => string> = {
  CHANGE_STALE_PATH: (change) => `openspec tree rebase ${change}`,
  CHANGE_BASE_UNPINNED: () => 'openspec tree pin --all --from merge-base',
  CHANGE_DRIFT: (change) =>
    `merge the newer main-spec text into ${change}, then openspec tree pin ${change} --accept "<capability>#<requirement>"`,
  CHANGE_OVERLAP: (change) => `coordinate overlapping requirements of ${change} (archive one, then rebase the other)`,
  CHANGE_PLACEMENT_MISSING: (change) => `record placement for ADDED requirements in ${change}/.openspec.yaml`,
};

export async function migratePlan(context: TreeContext, phase?: number): Promise<MigrationPlan> {
  const status = await migrateStatus(context);
  const target = phase ?? status.phase;
  if (!Number.isInteger(target) || target < 0 || target > 5) {
    throw new Error(`--phase must be 0-5, got ${phase}`);
  }
  const plan: MigrationPlan = {
    phase: target,
    phaseName: MIGRATION_PHASES[target].name,
    instructions: [],
    tasks: [],
  };
  const [inventory, changes] = await Promise.all([context.inventory(), context.changes()]);
  const findings = await structuralFindings(context);
  const select = (codes: string[]) => findings.filter((finding) => codes.includes(finding.code));

  switch (target) {
    case 0:
      plan.tasks.push(
        { code: 'INIT', action: 'openspec tree migrate init (already done when this command runs)' },
        { code: 'CI', action: 'run openspec tree check --json and openspec validate --all --json in CI, report only' },
        { code: 'BASELINE', action: 'commit the tree check report as the migration baseline' }
      );
      break;
    case 1:
      if (status.maxOpenChanges !== undefined && status.inflightChanges > status.maxOpenChanges) {
        plan.tasks.push({
          code: 'INFLIGHT',
          action: `archive finished changes until at most ${status.maxOpenChanges} remain (now ${status.inflightChanges})`,
        });
      }
      for (const entry of status.changeIssues.byChange) {
        for (const code of entry.codes) {
          const action = CHANGE_ACTIONS[code];
          if (action) plan.tasks.push({ change: entry.change, code, action: action(entry.change) });
        }
      }
      break;
    case 2:
      plan.instructions = instructionsFromFindings(select(['TREE_FANOUT', 'TREE_DEPTH']), inventory, changes, context.config);
      break;
    case 3:
      plan.instructions = instructionsFromFindings(select(['TREE_SPEC_TOO_LONG']), inventory, changes, context.config);
      break;
    case 4: {
      const synthetic: TreeFinding[] = status.unreviewed.map((node) => ({
        code: 'TREE_REVIEW_DUE',
        level: 'info',
        node,
        message: `${node} has never been reviewed`,
        details: { lastReview: null },
      }));
      plan.instructions = instructionsFromFindings(synthetic, inventory, changes, context.config);
      break;
    }
    case 5:
      for (const code of status.ungatedRules) {
        plan.tasks.push({ code, action: `set tree.enforcement.${code}: error (optionally limited by tree.scope)` });
      }
      break;
  }
  return plan;
}

export interface ImportedRedirect {
  commit: string;
  date: string;
  from: string;
  to: string;
}

/**
 * Capability redirects recovered from git renames of spec.md files in
 * `range`. Renames already recorded are skipped; delete-then-create moves are
 * invisible to git rename detection and must be added by hand.
 */
export async function findImportableRedirects(context: TreeContext, range: string): Promise<ImportedRedirect[]> {
  const renames = await context.git().specRenames(range, context.paths.specsDir);
  if (renames === null) {
    throw new Error(`git log failed for range '${range}' (not a git repository, or an unknown revision).`);
  }
  const redirects = await context.redirects();
  const known = new Set(
    redirects.entries
      .filter((entry) => entry.capability)
      .map((entry) => `${entry.capability!.from}\u0000${entry.capability!.to}`)
  );
  const seen = new Set<string>();
  return renames.filter((rename) => {
    const key = `${rename.from}\u0000${rename.to}`;
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function appendImportedRedirects(context: TreeContext, imported: ImportedRedirect[]): Promise<number> {
  const redirects = await context.redirects();
  const entries: RedirectEntry[] = imported.map((rename) => ({
    change: `git:${rename.commit.slice(0, 12)}`,
    capability: { from: rename.from, to: rename.to },
  }));
  await fs.writeFile(
    redirectsPath(context.paths.openspecDir),
    serializeRedirects({ version: 1, entries: [...redirects.entries, ...entries] })
  );
  return entries.length;
}
