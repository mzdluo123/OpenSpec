import { isWithinSubtree, type TreeConfig } from './config.js';
import type { IndexedChange } from './change-index.js';
import { siblingCapabilities, treeParentOf, type TreeInventory, type TreeNode } from './inventory.js';
import type { ManifestOpName } from './manifest.js';
import { INSTRUCTION_ALLOWED_OPS } from './restructure.js';
import { displayNode, type TreeFinding } from './rules.js';

export const INSTRUCTION_OPS = ['SPLIT', 'MERGE', 'REVIEW', 'PLACE', 'PRUNE'] as const;
export type InstructionOp = (typeof INSTRUCTION_OPS)[number];

export interface NodeSummary {
  path: string;
  kind: 'capability' | 'namespace';
  purpose?: string;
  lines: number;
  requirements: string[];
  children: number;
}

export interface TreeInstruction {
  id: string;
  op: InstructionOp;
  node: string;
  trigger: { code: string; actual?: number; limit?: number };
  inputs: Record<string, unknown>;
  allowedManifestOps: ManifestOpName[];
  constraints: string[];
  acceptance: string;
}

export function summarizeNode(node: TreeNode): NodeSummary {
  return {
    path: node.path,
    kind: node.hasSpec ? 'capability' : 'namespace',
    ...(node.purpose ? { purpose: node.purpose } : {}),
    lines: node.lines,
    requirements: node.requirements.map((requirement) => requirement.name),
    children: node.children.length,
  };
}

/** In-flight changes whose deltas touch `subtree`. */
export function changesTouching(changes: readonly IndexedChange[], subtree: string): string[] {
  return changes
    .filter((change) => change.deltas.some((delta) => isWithinSubtree(delta.capability, subtree)))
    .map((change) => change.name);
}

export interface NodeContext {
  path: string;
  exists: boolean;
  target?: NodeSummary;
  parent?: NodeSummary;
  siblings: NodeSummary[];
  children: NodeSummary[];
  openChanges: Array<{ change: string; capabilities: string[] }>;
}

/**
 * Everything an agent needs to decide where a requirement belongs: the node,
 * its parent, siblings and children with purposes and requirement titles, and
 * the in-flight changes touching any of them. Works for paths that do not
 * exist yet (a candidate new capability).
 */
export function buildNodeContext(
  inventory: TreeInventory,
  changes: readonly IndexedChange[],
  nodePath: string
): NodeContext {
  const node = inventory.nodes.get(nodePath);
  const parentPath = treeParentOf(nodePath) ?? '';
  const parent = inventory.nodes.get(parentPath);
  const siblings = (parent?.children ?? [])
    .filter((child) => child !== nodePath)
    .map((child) => summarizeNode(inventory.nodes.get(child)!));
  const children = (node?.children ?? []).map((child) => summarizeNode(inventory.nodes.get(child)!));
  const related = new Set([nodePath, parentPath, ...siblings.map((s) => s.path), ...children.map((c) => c.path)]);
  const openChanges = changes
    .map((change) => ({
      change: change.name,
      capabilities: [...new Set(change.deltas.map((delta) => delta.capability))].filter((capability) =>
        related.has(capability)
      ),
    }))
    .filter((entry) => entry.capabilities.length > 0);
  return {
    path: nodePath,
    exists: node !== undefined,
    ...(node ? { target: summarizeNode(node) } : {}),
    ...(parent && parentPath !== '' ? { parent: summarizeNode(parent) } : {}),
    siblings,
    children,
    openChanges,
  };
}

function capabilitiesBelow(inventory: TreeInventory, subtree: string): NodeSummary[] {
  return inventory.capabilities
    .filter((capability) => isWithinSubtree(capability, subtree))
    .map((capability) => summarizeNode(inventory.nodes.get(capability)!));
}

const NO_TEXT_EDITS = 'Do not edit requirement text in this operation';

export function instructionsFromFindings(
  findings: readonly TreeFinding[],
  inventory: TreeInventory,
  changes: readonly IndexedChange[],
  config: TreeConfig
): TreeInstruction[] {
  const instructions: TreeInstruction[] = [];
  for (const finding of findings) {
    const node = inventory.nodes.get(finding.node);
    const label = displayNode(finding.node);
    const trigger = {
      code: finding.code,
      ...(finding.actual !== undefined ? { actual: finding.actual } : {}),
      ...(finding.limit !== undefined ? { limit: finding.limit } : {}),
    };
    const touching = changesTouching(changes, finding.node);
    switch (finding.code) {
      case 'TREE_FANOUT':
        instructions.push({
          id: `split:${finding.node}`,
          op: 'SPLIT',
          node: finding.node,
          trigger,
          inputs: {
            children: (node?.children ?? []).map((child) => summarizeNode(inventory.nodes.get(child)!)),
            openChangesTouching: touching,
          },
          allowedManifestOps: [...INSTRUCTION_ALLOWED_OPS.split],
          constraints: [
            'Each new group must have a single, nameable responsibility',
            NO_TEXT_EDITS,
            `Resulting fanout of every touched node must be <= ${config.maxChildren}`,
          ],
          acceptance: `openspec validate <change> --strict passes and openspec tree check --scope ${label} reports no TREE_FANOUT`,
        });
        break;
      case 'TREE_SPEC_TOO_LONG': {
        // Most parts (parent included) that can each still clear the floor.
        const maxParts = Math.max(
          2,
          Math.floor((node?.lines ?? 0) / config.minSpecLines),
          Math.floor((node?.requirements.length ?? 0) / config.minRequirements)
        );
        instructions.push({
          id: `split-spec:${finding.node}`,
          op: 'SPLIT',
          node: finding.node,
          trigger,
          inputs: {
            capability: node ? summarizeNode(node) : undefined,
            requirements: (node?.requirements ?? []).map((requirement) => ({
              name: requirement.name,
              lines: requirement.lines,
            })),
            children: (node?.children ?? []).map((child) => summarizeNode(inventory.nodes.get(child)!)),
            openChangesTouching: touching,
            maxParts,
          },
          allowedManifestOps: [...INSTRUCTION_ALLOWED_OPS['split-spec']],
          constraints: [
            'Split into child capabilities below this node, each with one durable responsibility',
            'Facts shared by several new children stay in this (parent) capability',
            NO_TEXT_EDITS,
            `Every resulting spec.md must have <= ${config.maxSpecLines} lines and <= ${config.maxRequirements} requirements`,
            `Every created or shrunk spec.md, including this parent, must keep >= ${config.minSpecLines} lines or >= ${config.minRequirements} requirements; use at most ${maxParts} parts including the parent`,
          ],
          acceptance: `openspec validate <change> --strict passes and openspec tree check --scope ${label} reports no TREE_SPEC_TOO_LONG`,
        });
        break;
      }
      case 'TREE_DEPTH':
        instructions.push({
          id: `lift:${finding.node}`,
          op: 'SPLIT',
          node: finding.node,
          trigger,
          inputs: {
            node: node ? summarizeNode(node) : undefined,
            ancestors: ancestorsOf(finding.node).map((ancestor) => summarizeNode(inventory.nodes.get(ancestor)!)),
            openChangesTouching: touching,
          },
          allowedManifestOps: [...INSTRUCTION_ALLOWED_OPS.lift],
          constraints: [
            `Move the subtree up so no node is deeper than ${config.maxDepth}`,
            NO_TEXT_EDITS,
          ],
          acceptance: `openspec validate <change> --strict passes and openspec tree check reports no TREE_DEPTH for ${label}`,
        });
        break;
      case 'TREE_SPEC_TOO_SHORT':
        instructions.push({
          id: `merge:${finding.node}`,
          op: 'MERGE',
          node: finding.node,
          trigger,
          inputs: {
            capability: node ? summarizeNode(node) : undefined,
            siblings: siblingCapabilities(inventory, finding.node).map((sibling) =>
              summarizeNode(inventory.nodes.get(sibling)!)
            ),
            parent: node?.parent ? summarizeNode(inventory.nodes.get(node.parent)!) : undefined,
            openChangesTouching: touching,
          },
          allowedManifestOps: [...INSTRUCTION_ALLOWED_OPS.merge],
          constraints: [
            'Merge only when this capability and the target share one responsibility; otherwise leave it',
            NO_TEXT_EDITS,
            'Retire the capability only after every requirement has moved',
          ],
          acceptance: `openspec validate <change> --strict passes`,
        });
        break;
      case 'TREE_REVIEW_DUE':
        instructions.push({
          id: `review:${finding.node}`,
          op: 'REVIEW',
          node: finding.node,
          trigger,
          inputs: {
            capabilities: capabilitiesBelow(inventory, finding.node),
            parent: node?.parent ? summarizeNode(inventory.nodes.get(node.parent)!) : undefined,
            lastReview: finding.details?.lastReview ?? null,
            openChangesTouching: touching,
          },
          allowedManifestOps: [...INSTRUCTION_ALLOWED_OPS.review],
          constraints: [
            'One fact (same entity, constraint and value range) is defined in exactly one node',
            'Place each definition at the lowest common ancestor of every node that needs it',
            'Other nodes keep only their own behaviour and cite the definition by capability path + requirement title',
            'Rewrite a kept requirement only through a MODIFIED delta in this change; map every dropped scenario',
          ],
          acceptance: `openspec validate <change> --strict passes; archiving records the review of ${label} in tree-state.yaml`,
        });
        break;
      case 'TREE_EMPTY_NODE':
        instructions.push({
          id: `prune:${finding.node}`,
          op: 'PRUNE',
          node: finding.node,
          trigger,
          inputs: {},
          allowedManifestOps: [],
          constraints: ['Delete the empty directory; no restructure change is needed'],
          acceptance: `openspec tree check reports no TREE_EMPTY_NODE for ${label}`,
        });
        break;
      default:
        break;
    }
  }
  return instructions;
}

function ancestorsOf(nodePath: string): string[] {
  const result: string[] = [];
  let current = treeParentOf(nodePath);
  while (current !== null && current !== '') {
    result.unshift(current);
    current = treeParentOf(current);
  }
  return result;
}

/** PLACE instructions for ADDED requirements of normal changes that lack placement. */
export function placeInstructions(
  inventory: TreeInventory,
  changes: readonly IndexedChange[]
): TreeInstruction[] {
  const instructions: TreeInstruction[] = [];
  for (const change of changes) {
    if (change.restructure) continue;
    const placement = change.metadata?.placement ?? [];
    for (const added of change.added) {
      const placed = placement.some(
        (entry) =>
          entry.capability === added.capability &&
          entry.requirement.trim().toLowerCase() === added.name.trim().toLowerCase()
      );
      if (placed) continue;
      instructions.push({
        id: `place:${change.name}:${added.capability}#${added.name}`,
        op: 'PLACE',
        node: added.capability,
        trigger: { code: 'CHANGE_PLACEMENT_MISSING' },
        inputs: {
          change: change.name,
          requirement: added.name,
          candidate: buildNodeContext(inventory, changes, added.capability),
        },
        allowedManifestOps: [],
        constraints: [
          'Read the candidate, its parent and every sibling spec before deciding',
          'If the fact is already defined elsewhere, MODIFY it there or cite it instead of restating it',
          'If several siblings need the fact, place it in the parent capability',
          'Record the decision under placement in the change .openspec.yaml',
        ],
        acceptance: `openspec validate ${change.name} --strict reports no CHANGE_PLACEMENT_MISSING`,
      });
    }
  }
  return instructions;
}
