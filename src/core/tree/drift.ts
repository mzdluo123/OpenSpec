import { foldRequirementName } from '../parsers/requirement-blocks.js';
import { diffRequirementBlock } from '../../utils/requirement-diff.js';
import {
  findRequirementBlock,
  hashRequirementBlock,
  mainSpecFile,
  readMainSpec,
  type BaseEntry,
  type ChangeBases,
} from './bases.js';
import type { GitReader } from './git.js';
import {
  emptyRedirects,
  parseRedirects,
  redirectsPath,
  resolveRequirement,
  type TreeRedirects,
} from './redirects.js';

export type DriftStatus = 'clean' | 'drift' | 'removed' | 'moved' | 'merged';

export interface DriftResult {
  entry: BaseEntry;
  status: DriftStatus;
  /** Where the requirement lives now, when it was found. */
  current?: { capability: string; requirement: string; text: string };
  /** For `merged`: the requirement it was merged into. */
  mergedInto?: { capability: string; requirement: string };
  /** Unified diff from the snapshot to the current text, for `drift`. */
  diff?: string;
}

type SpecLookup = (capability: string) => Promise<string | undefined>;

async function classifyEntry(
  entry: BaseEntry,
  lookup: SpecLookup,
  redirects: TreeRedirects
): Promise<DriftResult> {
  const compare = (capability: string, requirement: string, text: string, moved: boolean): DriftResult => {
    const current = { capability, requirement, text };
    if (hashRequirementBlock(text) === entry.sha256) {
      return { entry, status: moved ? 'moved' : 'clean', current };
    }
    return {
      entry,
      status: 'drift',
      current,
      diff: diffRequirementBlock(entry.text, text, `${capability}#${requirement}`),
    };
  };

  const original = await lookup(entry.capability);
  const originalBlock = original === undefined ? undefined : findRequirementBlock(original, entry.requirement);
  if (originalBlock !== undefined) {
    return compare(entry.capability, entry.requirement, originalBlock, false);
  }

  const resolved = resolveRequirement(redirects, entry.capability, entry.requirement);
  if (resolved.kind === 'merged') {
    return { entry, status: 'merged', mergedInto: { capability: resolved.capability, requirement: resolved.name } };
  }
  if (resolved.kind === 'moved') {
    const content = await lookup(resolved.capability);
    const block = content === undefined ? undefined : findRequirementBlock(content, resolved.name);
    if (block !== undefined) return compare(resolved.capability, resolved.name, block, true);
  }
  return { entry, status: 'removed' };
}

/** Compare each base snapshot with the working-tree main specs. */
export async function checkLocalDrift(
  bases: ChangeBases,
  options: { specsDir: string; redirects: TreeRedirects }
): Promise<DriftResult[]> {
  const cache = new Map<string, Promise<string | undefined>>();
  const lookup: SpecLookup = (capability) => {
    let pending = cache.get(capability);
    if (!pending) {
      pending = readMainSpec(options.specsDir, capability);
      cache.set(capability, pending);
    }
    return pending;
  };
  return Promise.all(bases.entries.map((entry) => classifyEntry(entry, lookup, options.redirects)));
}

export interface RemoteDriftReport {
  /** Why the remote check did not run; the local check is unaffected. */
  skipped?: string;
  baseRef: string;
  results: DriftResult[];
}

/**
 * Compare each base snapshot with the main specs at `baseRef`, folding paths
 * through the redirects recorded on `baseRef` itself. Moves recorded locally
 * but not yet on `baseRef` are undone first, so a local restructure that has
 * not been merged does not read as content missing upstream.
 */
export async function checkRemoteDrift(
  bases: ChangeBases,
  options: { specsDir: string; openspecDir: string; git: GitReader; baseRef: string; localRedirects?: TreeRedirects }
): Promise<RemoteDriftReport> {
  const { git, baseRef } = options;
  const commit = await git.verifyRef(baseRef);
  if (!commit) {
    return { baseRef, skipped: `base ref '${baseRef}' is not available (not a git repository, or the ref does not exist)`, results: [] };
  }
  const redirectsContent = await git.showFile(commit, redirectsPath(options.openspecDir));
  let redirects = emptyRedirects();
  if (redirectsContent !== null) {
    try {
      redirects = parseRedirects(redirectsContent, `${baseRef}:tree-redirects.yaml`);
    } catch (error) {
      return { baseRef, skipped: (error as Error).message, results: [] };
    }
  }
  const remoteKeys = new Set(redirects.entries.map((entry) => JSON.stringify(entry)));
  const localOnly = (options.localRedirects?.entries ?? []).filter((entry) => !remoteKeys.has(JSON.stringify(entry)));
  const lookup: SpecLookup = async (capability) =>
    (await git.showFile(commit, mainSpecFile(options.specsDir, capability))) ?? undefined;
  return {
    baseRef,
    results: await Promise.all(
      bases.entries.map(async (entry) => {
        // The current location first; then each step back through moves
        // recorded only locally, newest first, until the requirement is found.
        let result = await classifyEntry(entry, lookup, redirects);
        for (const candidate of locationsBefore(entry, localOnly)) {
          if (result.status !== 'removed') break;
          result = { ...(await classifyEntry(candidate, lookup, redirects)), entry };
        }
        return result;
      })
    ),
  };
}

/**
 * Where a base entry lived before each redirect, newest redirect first. Merges
 * cannot be undone and are skipped.
 */
function locationsBefore(entry: BaseEntry, entries: TreeRedirects['entries']): BaseEntry[] {
  const result: BaseEntry[] = [];
  let capability = entry.capability;
  let requirement = entry.requirement;
  for (const redirect of [...entries].reverse()) {
    let moved = false;
    if (redirect.capability) {
      const { from, to } = redirect.capability;
      if (capability === to || capability.startsWith(`${to}/`)) {
        capability = `${from}${capability.slice(to.length)}`;
        moved = true;
      }
    } else if (redirect.requirement) {
      const { from, to } = redirect.requirement;
      if (capability === to.capability && foldRequirementName(requirement) === foldRequirementName(to.name)) {
        capability = from.capability;
        requirement = from.name;
        moved = true;
      }
    }
    if (moved) result.push({ ...entry, capability, requirement });
  }
  return result;
}
