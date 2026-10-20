import {
  isWithinSubtree,
  resolveFindingLevel,
  type FindingLevel,
  type TreeConfig,
  type TreeRuleCode,
} from './config.js';
import { siblingCapabilities, type TreeInventory, type TreeNode } from './inventory.js';
import { lastReviewFor, type ArchivedChangeSummary, type TreeState } from './state.js';

export interface TreeFinding {
  code: TreeRuleCode;
  level: FindingLevel;
  node: string;
  actual?: number;
  limit?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface TreeRuleInputs {
  inventory: TreeInventory;
  config: TreeConfig;
  /** Needed for TREE_REVIEW_DUE; omitted means the rule is skipped. */
  archives?: ArchivedChangeSummary[];
  state?: TreeState;
}

export interface TreeRuleOptions {
  /** Only report nodes inside this subtree. */
  scope?: string;
  /** Only report these nodes. */
  nodes?: ReadonlySet<string>;
}

export function displayNode(node: string): string {
  return node === '' ? 'specs/' : node;
}

/** Whether a directory holds a capability anywhere at or below it. */
function hasCapabilityBelow(inventory: TreeInventory, node: TreeNode): boolean {
  if (node.hasSpec) return true;
  return node.children.some((child) => {
    const childNode = inventory.nodes.get(child);
    return childNode !== undefined && hasCapabilityBelow(inventory, childNode);
  });
}

export function runTreeRules(inputs: TreeRuleInputs, options: TreeRuleOptions = {}): TreeFinding[] {
  const { inventory, config } = inputs;
  const findings: TreeFinding[] = [];
  const push = (finding: Omit<TreeFinding, 'level'>): void => {
    const level = resolveFindingLevel(config, finding.code, finding.node);
    if (level === null) return;
    findings.push({ ...finding, level });
  };
  const wanted = (node: string): boolean =>
    (options.scope === undefined || isWithinSubtree(node, options.scope)) &&
    (options.nodes === undefined || options.nodes.has(node));

  for (const node of inventory.nodes.values()) {
    if (!wanted(node.path)) continue;
    const label = displayNode(node.path);

    if (node.children.length > config.maxChildren) {
      push({
        code: 'TREE_FANOUT',
        node: node.path,
        actual: node.children.length,
        limit: config.maxChildren,
        message: `${label} has ${node.children.length} children (limit ${config.maxChildren})`,
      });
    }

    if (node.hasSpec) {
      const tooManyLines = node.lines > config.maxSpecLines;
      const tooManyRequirements = node.requirements.length > config.maxRequirements;
      if (tooManyLines || tooManyRequirements) {
        const reasons = [
          ...(tooManyLines ? [`${node.lines} lines (limit ${config.maxSpecLines})`] : []),
          ...(tooManyRequirements
            ? [`${node.requirements.length} requirements (limit ${config.maxRequirements})`]
            : []),
        ];
        push({
          code: 'TREE_SPEC_TOO_LONG',
          node: node.path,
          actual: tooManyLines ? node.lines : node.requirements.length,
          limit: tooManyLines ? config.maxSpecLines : config.maxRequirements,
          message: `${label}/spec.md has ${reasons.join(' and ')}`,
          details: {
            lines: node.lines,
            requirements: node.requirements.length,
            maxSpecLines: config.maxSpecLines,
            maxRequirements: config.maxRequirements,
          },
        });
      }

      const siblings = siblingCapabilities(inventory, node.path);
      if (node.lines < config.mergeBelowLines && siblings.length > 0) {
        push({
          code: 'TREE_SPEC_TOO_SHORT',
          node: node.path,
          actual: node.lines,
          limit: config.mergeBelowLines,
          message: `${label}/spec.md has ${node.lines} lines (below ${config.mergeBelowLines}) and has sibling capabilities`,
          details: { siblings },
        });
      }
    }

    if (node.depth > config.maxDepth) {
      push({
        code: 'TREE_DEPTH',
        node: node.path,
        actual: node.depth,
        limit: config.maxDepth,
        message: `${label} is at depth ${node.depth} (limit ${config.maxDepth})`,
      });
    }

    if (node.path !== '' && !hasCapabilityBelow(inventory, node)) {
      push({
        code: 'TREE_EMPTY_NODE',
        node: node.path,
        message: `${label} has neither a spec.md nor any capability below it`,
      });
    }
  }

  if (inputs.archives && inputs.state) {
    findings.push(
      ...findReviewDue(inputs.inventory, config, inputs.archives, inputs.state).filter((finding) =>
        wanted(finding.node)
      )
    );
  }

  return findings.sort(compareFindings);
}

function compareFindings(a: TreeFinding, b: TreeFinding): number {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/**
 * Subtrees modified by at least `reviewAfterArchives` archived changes since
 * their last REVIEW. Only nodes with children are review units, and only the
 * deepest unit over the threshold is reported so one hot leaf group does not
 * also flag every ancestor.
 */
function findReviewDue(
  inventory: TreeInventory,
  config: TreeConfig,
  archives: ArchivedChangeSummary[],
  state: TreeState
): Array<Omit<TreeFinding, 'level'> & { level: FindingLevel }> {
  const counts = new Map<string, { count: number; since?: string }>();
  for (const node of inventory.nodes.values()) {
    if (node.path === '' || node.children.length === 0) continue;
    const since = lastReviewFor(state, node.path);
    const count = archives.filter(
      (archive) =>
        (since === undefined || archive.date > since) &&
        archive.capabilities.some((capability) => isWithinSubtree(capability, node.path))
    ).length;
    counts.set(node.path, { count, since });
  }
  const due = [...counts.entries()].filter(([, value]) => value.count >= config.reviewAfterArchives);
  const result: Array<TreeFinding> = [];
  for (const [nodePath, value] of due) {
    const deeperDue = due.some(
      ([other]) => other !== nodePath && isWithinSubtree(other, nodePath)
    );
    if (deeperDue) continue;
    const level = resolveFindingLevel(config, 'TREE_REVIEW_DUE', nodePath);
    if (level === null) continue;
    result.push({
      code: 'TREE_REVIEW_DUE',
      level,
      node: nodePath,
      actual: value.count,
      limit: config.reviewAfterArchives,
      message: `${nodePath} was modified by ${value.count} archived changes since ${value.since ? `its last review on ${value.since}` : 'tree governance started (never reviewed)'} (threshold ${config.reviewAfterArchives})`,
      details: { lastReview: value.since ?? null },
    });
  }
  return result;
}

export interface FindingSummary {
  nodes: number;
  capabilities: number;
  errors: number;
  warnings: number;
  info: number;
}

export function summarizeFindings(inventory: TreeInventory, findings: TreeFinding[]): FindingSummary {
  return {
    nodes: inventory.nodes.size - 1,
    capabilities: inventory.capabilities.length,
    errors: findings.filter((finding) => finding.level === 'error').length,
    warnings: findings.filter((finding) => finding.level === 'warning').length,
    info: findings.filter((finding) => finding.level === 'info').length,
  };
}
