import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { foldRequirementName, normalizeRequirementName } from '../parsers/requirement-blocks.js';

/**
 * openspec/tree-redirects.yaml: every archived path or requirement migration,
 * in archive order, so changes written against an older tree can be resolved.
 */

export const TREE_REDIRECTS_FILENAME = 'tree-redirects.yaml';

const RequirementRefSchema = z.object({
  capability: z.string().min(1),
  name: z.string().min(1),
});

export type RequirementRef = z.infer<typeof RequirementRefSchema>;

const RedirectEntrySchema = z
  .object({
    change: z.string().min(1),
    capability: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(),
    requirement: z.object({ from: RequirementRefSchema, to: RequirementRefSchema }).optional(),
    merged: z.object({ from: RequirementRefSchema, into: RequirementRefSchema }).optional(),
  })
  .refine(
    (entry) =>
      [entry.capability, entry.requirement, entry.merged].filter((value) => value !== undefined)
        .length === 1,
    { message: 'each entry must have exactly one of capability, requirement, merged' }
  );

export type RedirectEntry = z.infer<typeof RedirectEntrySchema>;

const RedirectsFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(RedirectEntrySchema).nullish().transform((value) => value ?? []),
});

export interface TreeRedirects {
  version: 1;
  entries: RedirectEntry[];
}

export function emptyRedirects(): TreeRedirects {
  return { version: 1, entries: [] };
}

export function redirectsPath(openspecDir: string): string {
  return path.join(openspecDir, TREE_REDIRECTS_FILENAME);
}

export function parseRedirects(content: string, source = TREE_REDIRECTS_FILENAME): TreeRedirects {
  const raw = parseYaml(content) ?? { version: 1, entries: [] };
  const parsed = RedirectsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${source}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    );
  }
  return { version: 1, entries: parsed.data.entries };
}

export async function readRedirects(openspecDir: string): Promise<TreeRedirects> {
  try {
    return parseRedirects(await fs.readFile(redirectsPath(openspecDir), 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRedirects();
    throw error;
  }
}

export function serializeRedirects(redirects: TreeRedirects): string {
  return stringifyYaml({ version: 1, entries: redirects.entries });
}

export interface ResolvedCapability {
  capability: string;
  moved: boolean;
  /** The chain revisited a path it had already passed through. */
  cycle: boolean;
}

function rewritePrefix(value: string, from: string, to: string): string | undefined {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return undefined;
}

/**
 * Where a capability path lives now. Entries apply in archive order, so a
 * chain A→B→C folds to C and a later move back (A→B, B→A) ends at A.
 */
export function resolveCapability(redirects: TreeRedirects, capability: string): ResolvedCapability {
  let current = capability;
  const visited = new Set<string>([current]);
  let cycle = false;
  for (const entry of redirects.entries) {
    if (!entry.capability) continue;
    const next = rewritePrefix(current, entry.capability.from, entry.capability.to);
    if (next === undefined) continue;
    current = next;
    if (visited.has(current)) cycle = true;
    visited.add(current);
  }
  return { capability: current, moved: current !== capability, cycle };
}

export type ResolvedRequirement =
  | { kind: 'unchanged'; capability: string; name: string; cycle: false }
  | { kind: 'moved'; capability: string; name: string; cycle: boolean }
  | { kind: 'merged'; capability: string; name: string; mergedFrom: RequirementRef; cycle: boolean };

/** Where a requirement lives now, folding capability moves, requirement moves and merges. */
export function resolveRequirement(
  redirects: TreeRedirects,
  capability: string,
  name: string
): ResolvedRequirement {
  let current = { capability, name: normalizeRequirementName(name) };
  const key = (ref: RequirementRef) => `${ref.capability}\u0000${foldRequirementName(ref.name)}`;
  const visited = new Set<string>([key(current)]);
  let cycle = false;
  let mergedFrom: RequirementRef | undefined;
  for (const entry of redirects.entries) {
    let next: RequirementRef | undefined;
    if (entry.capability) {
      const moved = rewritePrefix(current.capability, entry.capability.from, entry.capability.to);
      if (moved !== undefined) next = { capability: moved, name: current.name };
    } else if (entry.requirement) {
      if (key(entry.requirement.from) === key(current)) next = entry.requirement.to;
    } else if (entry.merged) {
      if (key(entry.merged.from) === key(current)) {
        mergedFrom = mergedFrom ?? { ...current };
        next = entry.merged.into;
      }
    }
    if (!next) continue;
    current = { capability: next.capability, name: normalizeRequirementName(next.name) };
    if (visited.has(key(current))) cycle = true;
    visited.add(key(current));
  }
  if (mergedFrom) return { kind: 'merged', ...current, mergedFrom, cycle };
  if (current.capability === capability && foldRequirementName(current.name) === foldRequirementName(name)) {
    return { kind: 'unchanged', capability, name: normalizeRequirementName(name), cycle: false };
  }
  return { kind: 'moved', ...current, cycle };
}

/**
 * Destinations recorded for content that used to live at `capability`. Used to
 * reject ADDED deltas that target a path the tree has migrated away from.
 */
export function movedAwayDestinations(redirects: TreeRedirects, capability: string): string[] {
  const destinations = new Set<string>();
  for (const entry of redirects.entries) {
    if (entry.capability) {
      const moved = rewritePrefix(capability, entry.capability.from, entry.capability.to);
      if (moved !== undefined) destinations.add(resolveCapability(redirects, capability).capability);
    } else if (entry.requirement && entry.requirement.from.capability === capability) {
      destinations.add(entry.requirement.to.capability);
    } else if (entry.merged && entry.merged.from.capability === capability) {
      destinations.add(entry.merged.into.capability);
    }
  }
  destinations.delete(capability);
  return [...destinations].sort();
}
