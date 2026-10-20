import path from 'path';
import { readProjectConfig } from '../project-config.js';
import type { TreeConfig } from './config.js';
import { readInflightChanges, type IndexedChange } from './change-index.js';
import { GitReader } from './git.js';
import { buildTreeInventory, type TreeInventory } from './inventory.js';
import { readRedirects, type TreeRedirects } from './redirects.js';

export interface TreePaths {
  projectRoot: string;
  openspecDir: string;
  specsDir: string;
  changesDir: string;
  archiveDir: string;
}

/**
 * Everything one command run needs to evaluate tree rules, loaded lazily and
 * at most once. Bulk validation shares one context across all changes.
 */
export class TreeContext {
  private inventoryPromise?: Promise<TreeInventory>;
  private redirectsPromise?: Promise<TreeRedirects>;
  private changesPromise?: Promise<IndexedChange[]>;
  private gitReader?: GitReader;

  constructor(
    readonly paths: TreePaths,
    readonly config: TreeConfig,
    /** Overrides `tree.drift.baseRef` for this run (`--base`). */
    readonly baseRefOverride?: string
  ) {}

  get baseRef(): string | undefined {
    return this.baseRefOverride ?? this.config.drift.baseRef;
  }

  inventory(): Promise<TreeInventory> {
    this.inventoryPromise ??= buildTreeInventory(this.paths.specsDir);
    return this.inventoryPromise;
  }

  redirects(): Promise<TreeRedirects> {
    this.redirectsPromise ??= readRedirects(this.paths.openspecDir);
    return this.redirectsPromise;
  }

  changes(): Promise<IndexedChange[]> {
    this.changesPromise ??= readInflightChanges(this.paths.changesDir);
    return this.changesPromise;
  }

  git(): GitReader {
    this.gitReader ??= new GitReader(this.paths.projectRoot);
    return this.gitReader;
  }
}

export function treePathsFor(root: {
  path: string;
  specsDir: string;
  changesDir: string;
  archiveDir: string;
}): TreePaths {
  return {
    projectRoot: root.path,
    openspecDir: path.dirname(root.changesDir),
    specsDir: root.specsDir,
    changesDir: root.changesDir,
    archiveDir: root.archiveDir,
  };
}

/** The project's tree config when governance is enabled, otherwise undefined. */
export function readEnabledTreeConfig(projectRoot: string): TreeConfig | undefined {
  const config = readProjectConfig(projectRoot)?.tree;
  return config?.enabled ? config : undefined;
}

/** A context for the project, or undefined when tree governance is off. */
export function loadTreeContext(paths: TreePaths, baseRefOverride?: string): TreeContext | undefined {
  const config = readEnabledTreeConfig(paths.projectRoot);
  return config ? new TreeContext(paths, config, baseRefOverride) : undefined;
}
