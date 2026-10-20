import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { discoverSpecFiles } from '../../utils/spec-discovery.js';
import { ChangeMetadataSchema, type ChangeMetadata } from '../change-metadata/schema.js';
import {
  foldRequirementName,
  normalizeRequirementName,
  parseDeltaSpec,
  type DeltaPlan,
} from '../parsers/requirement-blocks.js';
import { buildRenameMap } from '../../utils/requirement-diff.js';
import { compareCodePoints } from './inventory.js';

export type TargetOp = 'MODIFIED' | 'REMOVED' | 'RENAMED';

export interface ChangeDeltaFile {
  capability: string;
  file: string;
  content: string;
  plan: DeltaPlan;
}

/** A main-spec requirement a change rewrites, named as the main spec names it. */
export interface ChangeTarget {
  capability: string;
  name: string;
  ops: TargetOp[];
}

export interface IndexedChange {
  name: string;
  dir: string;
  deltas: ChangeDeltaFile[];
  targets: ChangeTarget[];
  added: Array<{ capability: string; name: string }>;
  metadata?: ChangeMetadata;
  metadataError?: string;
  restructure: boolean;
}

export function targetKey(capability: string, name: string): string {
  return `${capability}\u0000${foldRequirementName(name)}`;
}

/** Change directories directly under changes/, excluding archive/ and dot entries. */
export async function listInflightChangeNames(changesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareCodePoints);
}

function readMetadata(changeDir: string, raw: string | undefined): Pick<IndexedChange, 'metadata' | 'metadataError'> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    return { metadataError: `Invalid YAML in ${path.join(changeDir, '.openspec.yaml')}: ${(error as Error).message}` };
  }
  const result = ChangeMetadataSchema.safeParse(parsed);
  if (!result.success) {
    return {
      metadataError: result.error.issues
        .map((issue) => `${issue.path.join('.') || 'metadata'}: ${issue.message}`)
        .join('; '),
    };
  }
  return { metadata: result.data };
}

/**
 * Requirements a delta plan rewrites in the main spec. A MODIFIED block for a
 * name this same delta RENAMED to targets the original FROM requirement, as
 * archive applies renames before modifications.
 */
export function planTargets(capability: string, plan: DeltaPlan): ChangeTarget[] {
  const renameMap = buildRenameMap(plan.renamed);
  const byKey = new Map<string, ChangeTarget>();
  const add = (name: string, op: TargetOp): void => {
    const original = normalizeRequirementName(name);
    const key = targetKey(capability, original);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.ops.includes(op)) existing.ops.push(op);
      return;
    }
    byKey.set(key, { capability, name: original, ops: [op] });
  };
  for (const pair of plan.renamed) add(pair.from, 'RENAMED');
  for (const block of plan.modified) add(renameMap.get(foldRequirementName(block.name)) ?? block.name, 'MODIFIED');
  for (const name of plan.removed) add(renameMap.get(foldRequirementName(name)) ?? name, 'REMOVED');
  return [...byKey.values()];
}

export async function readIndexedChange(changesDir: string, name: string): Promise<IndexedChange> {
  const dir = path.join(changesDir, name);
  const metadataRaw = await fs.readFile(path.join(dir, '.openspec.yaml'), 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const deltas: ChangeDeltaFile[] = [];
  for (const { id, specFile } of await discoverSpecFiles(path.join(dir, 'specs'))) {
    const content = await fs.readFile(specFile, 'utf-8');
    deltas.push({ capability: id, file: specFile, content, plan: parseDeltaSpec(content) });
  }
  const meta = readMetadata(dir, metadataRaw);
  return {
    name,
    dir,
    deltas,
    targets: deltas.flatMap((delta) => planTargets(delta.capability, delta.plan)),
    added: deltas.flatMap((delta) =>
      delta.plan.added.map((block) => ({ capability: delta.capability, name: block.name }))
    ),
    ...meta,
    restructure: meta.metadata?.restructure === true,
  };
}

export async function readInflightChanges(changesDir: string): Promise<IndexedChange[]> {
  const names = await listInflightChangeNames(changesDir);
  return Promise.all(names.map((name) => readIndexedChange(changesDir, name)));
}
