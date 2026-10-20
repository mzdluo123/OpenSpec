import { z } from 'zod';
import type { ValidationLevel } from '../validation/types.js';

/** A validation issue produced by a tree hook; `code` names the rule. */
export interface TreeIssue {
  level: ValidationLevel;
  path: string;
  message: string;
  code: string;
}

export function findingLevelToValidation(level: FindingLevel): ValidationLevel {
  return level === 'error' ? 'ERROR' : level === 'warning' ? 'WARNING' : 'INFO';
}

/**
 * Tree governance configuration (`tree:` in openspec/config.yaml).
 *
 * Absent or `enabled: false` means every tree hook is inert and the CLI
 * behaves exactly like upstream OpenSpec.
 */

export const TREE_RULE_CODES = [
  'TREE_FANOUT',
  'TREE_SPEC_TOO_LONG',
  'TREE_SPEC_TOO_SHORT',
  'TREE_SPEC_TOO_GRANULAR',
  'TREE_DEPTH',
  'TREE_EMPTY_NODE',
  'TREE_REVIEW_DUE',
  'CHANGE_PLACEMENT_MISSING',
  'CHANGE_STALE_PATH',
  'CHANGE_OVERLAP',
  'CHANGE_DRIFT',
  'CHANGE_BASE_UNPINNED',
  'CHANGE_REMOTE_DRIFT',
] as const;

export type TreeRuleCode = (typeof TREE_RULE_CODES)[number];

export const ENFORCEMENT_LEVELS = ['off', 'info', 'warn', 'error'] as const;
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];

export const DEFAULT_ENFORCEMENT: Record<TreeRuleCode, EnforcementLevel> = {
  TREE_FANOUT: 'warn',
  TREE_SPEC_TOO_LONG: 'warn',
  TREE_SPEC_TOO_SHORT: 'info',
  TREE_SPEC_TOO_GRANULAR: 'warn',
  TREE_DEPTH: 'warn',
  TREE_EMPTY_NODE: 'error',
  TREE_REVIEW_DUE: 'info',
  CHANGE_PLACEMENT_MISSING: 'error',
  CHANGE_STALE_PATH: 'error',
  CHANGE_OVERLAP: 'warn',
  CHANGE_DRIFT: 'error',
  CHANGE_BASE_UNPINNED: 'warn',
  CHANGE_REMOTE_DRIFT: 'warn',
};

const EnforcementSchema = z.enum(ENFORCEMENT_LEVELS);

export const TreeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxChildren: z.number().int().positive().default(20),
    maxSpecLines: z.number().int().positive().default(300),
    maxRequirements: z.number().int().positive().default(15),
    /**
     * Floor for capabilities a restructure creates or shrinks: a spec must
     * have at least this many lines OR `minRequirements` requirements.
     */
    minSpecLines: z.number().int().positive().default(60),
    minRequirements: z.number().int().positive().default(3),
    mergeBelowLines: z.number().int().nonnegative().default(80),
    maxDepth: z.number().int().positive().default(4),
    reviewAfterArchives: z.number().int().positive().default(10),
    maxOpenChanges: z.number().int().nonnegative().optional(),
    /**
     * Subtrees whose findings use the configured enforcement. Outside these
     * subtrees a finding is capped at `warn`, so a migration can turn rules
     * into errors one subtree at a time. Empty means the whole tree.
     */
    scope: z.array(z.string().min(1)).default([]),
    enforcement: z.partialRecord(z.enum(TREE_RULE_CODES), EnforcementSchema).default({}),
    drift: z
      .object({
        baseRef: z.string().min(1).optional(),
      })
      .default({}),
  })
  .strict()
  // A spec just over a maximum must be splittable into two parts that both
  // clear the floor, otherwise the limits contradict each other.
  .refine((value) => value.maxSpecLines >= 2 * value.minSpecLines, {
    message: 'maxSpecLines must be at least twice minSpecLines',
    path: ['minSpecLines'],
  })
  .refine((value) => value.maxRequirements >= 2 * value.minRequirements, {
    message: 'maxRequirements must be at least twice minRequirements',
    path: ['minRequirements'],
  });

export interface TreeConfig {
  enabled: boolean;
  maxChildren: number;
  maxSpecLines: number;
  maxRequirements: number;
  minSpecLines: number;
  minRequirements: number;
  mergeBelowLines: number;
  maxDepth: number;
  reviewAfterArchives: number;
  maxOpenChanges?: number;
  scope: string[];
  enforcement: Record<TreeRuleCode, EnforcementLevel>;
  drift: { baseRef?: string };
}

/**
 * Parse a raw `tree:` value. Returns undefined (with a reason) when the value
 * does not match the schema, so a broken section disables tree governance
 * rather than the whole project config.
 */
export function parseTreeConfig(raw: unknown): { config?: TreeConfig; error?: string } {
  const result = TreeConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      error: result.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'tree'}: ${issue.message}`)
        .join('; '),
    };
  }
  const data = result.data;
  return {
    config: {
      enabled: data.enabled,
      maxChildren: data.maxChildren,
      maxSpecLines: data.maxSpecLines,
      maxRequirements: data.maxRequirements,
      minSpecLines: data.minSpecLines,
      minRequirements: data.minRequirements,
      mergeBelowLines: data.mergeBelowLines,
      maxDepth: data.maxDepth,
      reviewAfterArchives: data.reviewAfterArchives,
      ...(data.maxOpenChanges !== undefined ? { maxOpenChanges: data.maxOpenChanges } : {}),
      scope: data.scope.map(normalizeTreePath).filter((entry) => entry !== ''),
      enforcement: { ...DEFAULT_ENFORCEMENT, ...data.enforcement },
      drift: { ...(data.drift.baseRef ? { baseRef: data.drift.baseRef } : {}) },
    },
  };
}

/** Default configuration, used by `tree migrate init` and tests. */
export function defaultTreeConfig(overrides: Partial<TreeConfig> = {}): TreeConfig {
  const { config } = parseTreeConfig({ enabled: true });
  return { ...config!, ...overrides };
}

/** Forward-slash path with no leading/trailing slashes. */
export function normalizeTreePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/** True when `node` equals `subtree` or sits below it. The root ('') contains everything. */
export function isWithinSubtree(node: string, subtree: string): boolean {
  if (subtree === '') return true;
  return node === subtree || node.startsWith(`${subtree}/`);
}

export function isInScope(node: string, scope: readonly string[]): boolean {
  return scope.length === 0 || scope.some((entry) => isWithinSubtree(node, entry));
}

export type FindingLevel = 'error' | 'warning' | 'info';

/**
 * The level a finding for `code` on `node` is reported at, or null when the
 * rule is off. Out-of-scope nodes never exceed `warning`.
 */
export function resolveFindingLevel(
  config: TreeConfig,
  code: TreeRuleCode,
  node: string
): FindingLevel | null {
  const configured = config.enforcement[code];
  if (configured === 'off') return null;
  const level: FindingLevel =
    configured === 'error' ? 'error' : configured === 'warn' ? 'warning' : 'info';
  if (level === 'error' && !isInScope(node, config.scope)) return 'warning';
  return level;
}

/** Issue codes produced by tree hooks. Their warnings never fail `--strict`. */
export function isTreeIssueCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    ((TREE_RULE_CODES as readonly string[]).includes(code) ||
      code.startsWith('CONSERVATION_') ||
      code.startsWith('RESTRUCTURE_') ||
      code.startsWith('TREE_'))
  );
}
