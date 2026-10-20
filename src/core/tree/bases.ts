import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { formatLocalDate } from '../../utils/date.js';
import {
  extractRequirementsSection,
  normalizeRequirementName,
} from '../parsers/requirement-blocks.js';
import { targetKey, type IndexedChange, type TargetOp } from './change-index.js';
import type { GitReader } from './git.js';

/**
 * changes/<change>/bases.yaml: the main-spec text each MODIFIED / REMOVED /
 * RENAMED target had when the delta was written. Maintained by the CLI; drift
 * is any difference between this snapshot and the current main spec.
 */

export const BASES_FILENAME = 'bases.yaml';

const BaseEntrySchema = z.object({
  capability: z.string().min(1),
  requirement: z.string().min(1),
  ops: z.array(z.enum(['MODIFIED', 'REMOVED', 'RENAMED'])).min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  text: z.string(),
  pinnedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(['worktree', 'merge-base', 'accepted']),
  previous: z.string().nullable().default(null),
});

export type BaseEntry = z.infer<typeof BaseEntrySchema>;

const BasesFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(BaseEntrySchema).nullish().transform((value) => value ?? []),
});

export interface ChangeBases {
  version: 1;
  entries: BaseEntry[];
}

/** Line endings unified and outer whitespace trimmed: the form that is hashed. */
export function normalizeRequirementBlock(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

export function hashRequirementBlock(raw: string): string {
  return createHash('sha256').update(normalizeRequirementBlock(raw)).digest('hex');
}

export function basesPath(changeDir: string): string {
  return path.join(changeDir, BASES_FILENAME);
}

export function parseBases(content: string, source = BASES_FILENAME): ChangeBases {
  const parsed = BasesFileSchema.safeParse(parseYaml(content) ?? { version: 1 });
  if (!parsed.success) {
    throw new Error(
      `Invalid ${source}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    );
  }
  return { version: 1, entries: parsed.data.entries };
}

/** The change's bases, or undefined when it has no bases.yaml yet. */
export async function readBases(changeDir: string): Promise<ChangeBases | undefined> {
  try {
    return parseBases(await fs.readFile(basesPath(changeDir), 'utf-8'), basesPath(changeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function serializeBases(bases: ChangeBases): string {
  return stringifyYaml(
    {
      version: 1,
      entries: bases.entries.map((entry) => ({
        capability: entry.capability,
        requirement: entry.requirement,
        ops: entry.ops,
        sha256: entry.sha256,
        text: entry.text.endsWith('\n') ? entry.text : `${entry.text}\n`,
        pinnedAt: entry.pinnedAt,
        source: entry.source,
        previous: entry.previous,
      })),
    },
    { lineWidth: 0, blockQuote: 'literal' }
  );
}

/** The requirement block a main spec holds for `name`, matched as archive matches (exact). */
export function findRequirementBlock(specContent: string, name: string): string | undefined {
  const wanted = normalizeRequirementName(name);
  return extractRequirementsSection(specContent).bodyBlocks.find(
    (block) => normalizeRequirementName(block.name) === wanted
  )?.raw;
}

export function mainSpecFile(specsDir: string, capability: string): string {
  return path.join(specsDir, ...capability.split('/'), 'spec.md');
}

export async function readMainSpec(specsDir: string, capability: string): Promise<string | undefined> {
  try {
    return await fs.readFile(mainSpecFile(specsDir, capability), 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export function findBaseEntry(
  bases: ChangeBases | undefined,
  capability: string,
  requirement: string
): BaseEntry | undefined {
  const key = targetKey(capability, requirement);
  return bases?.entries.find((entry) => targetKey(entry.capability, entry.requirement) === key);
}

export interface PinReport {
  pinned: Array<{ capability: string; requirement: string; source: BaseEntry['source'] }>;
  kept: Array<{ capability: string; requirement: string }>;
  pruned: Array<{ capability: string; requirement: string }>;
  skipped: Array<{ capability: string; requirement: string; reason: string }>;
  warnings: string[];
}

export interface PinOptions {
  specsDir: string;
  from?: 'worktree' | 'merge-base';
  git?: GitReader;
  baseRef?: string;
  today?: string;
}

/**
 * Record a base for every target the change rewrites that has none yet.
 * Existing entries are never overwritten (only their ops are refreshed);
 * entries for targets the change no longer rewrites are pruned.
 */
export async function pinChange(
  change: IndexedChange,
  existing: ChangeBases | undefined,
  options: PinOptions
): Promise<{ bases: ChangeBases; report: PinReport }> {
  const today = options.today ?? formatLocalDate();
  const report: PinReport = { pinned: [], kept: [], pruned: [], skipped: [], warnings: [] };
  const entries: BaseEntry[] = [];

  let mergeBase: string | null = null;
  if (options.from === 'merge-base') {
    if (!options.git || !options.baseRef) {
      report.warnings.push('No baseRef configured; pinned from the working tree instead of the merge-base.');
    } else {
      mergeBase = await options.git.mergeBase('HEAD', options.baseRef);
      if (!mergeBase) {
        report.warnings.push(
          `Could not compute the merge-base of HEAD and ${options.baseRef}; pinned from the working tree instead.`
        );
      }
    }
  }

  for (const target of change.targets) {
    const previous = findBaseEntry(existing, target.capability, target.name);
    if (previous) {
      entries.push({ ...previous, ops: sortOps(target.ops) });
      report.kept.push({ capability: target.capability, requirement: target.name });
      continue;
    }
    let text: string | undefined;
    let source: BaseEntry['source'] = 'worktree';
    if (mergeBase && options.git) {
      const content = await options.git.showFile(mergeBase, mainSpecFile(options.specsDir, target.capability));
      text = content === null ? undefined : findRequirementBlock(content, target.name);
      if (text !== undefined) source = 'merge-base';
    }
    if (text === undefined) {
      const content = await readMainSpec(options.specsDir, target.capability);
      text = content === undefined ? undefined : findRequirementBlock(content, target.name);
      if (text !== undefined && mergeBase) {
        report.warnings.push(
          `${target.capability}#${target.name}: not found at the merge-base; pinned from the working tree.`
        );
      }
    }
    if (text === undefined) {
      report.skipped.push({
        capability: target.capability,
        requirement: target.name,
        reason: 'requirement not found in the main specs (stale path? try `openspec tree rebase`)',
      });
      continue;
    }
    entries.push({
      capability: target.capability,
      requirement: target.name,
      ops: sortOps(target.ops),
      sha256: hashRequirementBlock(text),
      text: normalizeRequirementBlock(text),
      pinnedAt: today,
      source,
      previous: null,
    });
    report.pinned.push({ capability: target.capability, requirement: target.name, source });
  }

  for (const entry of existing?.entries ?? []) {
    const stillTargeted = change.targets.some(
      (target) => targetKey(target.capability, target.name) === targetKey(entry.capability, entry.requirement)
    );
    if (!stillTargeted) report.pruned.push({ capability: entry.capability, requirement: entry.requirement });
  }

  return { bases: { version: 1, entries }, report };
}

function sortOps(ops: readonly TargetOp[]): TargetOp[] {
  const order: TargetOp[] = ['MODIFIED', 'REMOVED', 'RENAMED'];
  return order.filter((op) => ops.includes(op));
}

/** Parse `<capability>#<requirement>`. */
export function parseAcceptTarget(value: string): { capability: string; requirement: string } {
  const index = value.indexOf('#');
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`--accept expects "<capability>#<requirement>", got "${value}".`);
  }
  return {
    capability: value.slice(0, index).trim().replace(/^\/+|\/+$/g, ''),
    requirement: value.slice(index + 1).trim(),
  };
}

/**
 * Replace one entry's snapshot with the current main-spec block, keeping the
 * replaced hash in `previous` so review can see what was accepted.
 */
export async function acceptBase(
  bases: ChangeBases | undefined,
  target: { capability: string; requirement: string },
  current: { capability: string; requirement: string; text: string },
  today = formatLocalDate()
): Promise<ChangeBases> {
  const entry = findBaseEntry(bases, target.capability, target.requirement);
  if (!bases || !entry) {
    throw new Error(
      `No base entry for ${target.capability}#${target.requirement}. Run \`openspec tree pin <change>\` first.`
    );
  }
  const updated: BaseEntry = {
    ...entry,
    capability: current.capability,
    requirement: current.requirement,
    sha256: hashRequirementBlock(current.text),
    text: normalizeRequirementBlock(current.text),
    pinnedAt: today,
    source: 'accepted',
    previous: entry.sha256,
  };
  return {
    version: 1,
    entries: bases.entries.map((candidate) => (candidate === entry ? updated : candidate)),
  };
}
