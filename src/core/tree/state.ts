import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { discoverSpecFiles } from '../../utils/spec-discovery.js';
import { isWithinSubtree } from './config.js';

/**
 * openspec/tree-state.yaml: when each subtree last had a REVIEW. Updated by
 * archiving a restructure change whose manifest names a `review:<node>`
 * instruction.
 */

export const TREE_STATE_FILENAME = 'tree-state.yaml';

const TreeStateSchema = z.object({
  version: z.literal(1),
  reviews: z
    .array(
      z.object({
        node: z.string(),
        reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        change: z.string().min(1),
      })
    )
    .default([]),
});

export type TreeState = z.infer<typeof TreeStateSchema>;

export function emptyTreeState(): TreeState {
  return { version: 1, reviews: [] };
}

export function treeStatePath(openspecDir: string): string {
  return path.join(openspecDir, TREE_STATE_FILENAME);
}

export async function readTreeState(openspecDir: string): Promise<TreeState> {
  let content: string;
  try {
    content = await fs.readFile(treeStatePath(openspecDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTreeState();
    throw error;
  }
  const parsed = TreeStateSchema.safeParse(parseYaml(content) ?? { version: 1 });
  if (!parsed.success) {
    throw new Error(`Invalid ${TREE_STATE_FILENAME}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

export function serializeTreeState(state: TreeState): string {
  return stringifyYaml(state);
}

/** Most recent review date that covers `node` (the node itself or an ancestor). */
export function lastReviewFor(state: TreeState, node: string): string | undefined {
  let latest: string | undefined;
  for (const review of state.reviews) {
    if (!isWithinSubtree(node, review.node)) continue;
    if (latest === undefined || review.reviewedAt > latest) latest = review.reviewedAt;
  }
  return latest;
}

export interface ArchivedChangeSummary {
  name: string;
  /** YYYY-MM-DD from the archive folder prefix. */
  date: string;
  capabilities: string[];
}

/** Archived changes with a date prefix and the capabilities their deltas touched. */
export async function listArchivedChanges(archiveDir: string): Promise<ArchivedChangeSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(archiveDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: ArchivedChangeSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (!match) continue;
    const specs = await discoverSpecFiles(path.join(archiveDir, entry.name, 'specs'));
    result.push({ name: entry.name, date: match[1], capabilities: specs.map((spec) => spec.id) });
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
