import { promises as fs } from 'fs';
import path from 'path';
import { discoverSpecFiles } from '../../utils/spec-discovery.js';
import { extractRequirementsSection } from '../parsers/requirement-blocks.js';
import { buildCodeFenceMask } from '../parsers/requirement-text.js';

export interface TreeRequirement {
  name: string;
  raw: string;
  lines: number;
}

export interface TreeNode {
  /** Forward-slash path relative to the specs root; '' is the root. */
  path: string;
  name: string;
  /** Number of path segments; the root is 0. */
  depth: number;
  parent: string | null;
  /** Direct child node paths, sorted. */
  children: string[];
  hasSpec: boolean;
  specFile?: string;
  lines: number;
  purpose?: string;
  requirements: TreeRequirement[];
}

export interface TreeInventory {
  specsDir: string;
  nodes: Map<string, TreeNode>;
  /** Paths of nodes that have a spec.md, sorted. */
  capabilities: string[];
}

export interface ParsedSpec {
  lines: number;
  purpose?: string;
  requirements: TreeRequirement[];
}

/** Line count as `wc -l` reports it, plus one for an unterminated last line. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlines = content.match(/\n/g)?.length ?? 0;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/** Body of the `## Purpose` section, ignoring fenced code. */
export function extractPurpose(content: string): string | undefined {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const mask = buildCodeFenceMask(lines);
  const start = lines.findIndex((line, index) => !mask[index] && /^##\s+Purpose\s*$/i.test(line));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (!mask[index] && /^##\s+/.test(lines[index])) break;
    body.push(lines[index]);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Requirement blocks come from the same reader archive uses
 * (extractRequirementsSection), so the inventory can never disagree with the
 * merge about what a requirement is.
 */
export function parseSpecContent(content: string): ParsedSpec {
  const parts = extractRequirementsSection(content);
  return {
    lines: countLines(content),
    purpose: extractPurpose(content),
    requirements: parts.bodyBlocks.map((block) => ({
      name: block.name,
      raw: block.raw,
      lines: countLines(block.raw),
    })),
  };
}

function parentOf(nodePath: string): string | null {
  if (nodePath === '') return null;
  const index = nodePath.lastIndexOf('/');
  return index === -1 ? '' : nodePath.slice(0, index);
}

function ensureNode(nodes: Map<string, TreeNode>, nodePath: string): TreeNode {
  let node = nodes.get(nodePath);
  if (node) return node;
  const parent = parentOf(nodePath);
  node = {
    path: nodePath,
    name: nodePath === '' ? '' : nodePath.slice(nodePath.lastIndexOf('/') + 1),
    depth: nodePath === '' ? 0 : nodePath.split('/').length,
    parent,
    children: [],
    hasSpec: false,
    lines: 0,
    requirements: [],
  };
  nodes.set(nodePath, node);
  if (parent !== null) {
    const parentNode = ensureNode(nodes, parent);
    if (!parentNode.children.includes(nodePath)) parentNode.children.push(nodePath);
  }
  return node;
}

/**
 * Build an inventory from in-memory spec contents keyed by capability path,
 * plus any directories that hold no spec of their own. Used for the real tree
 * and for trees produced by simulating a restructure manifest.
 */
export function buildInventoryFromContents(
  specsDir: string,
  specs: ReadonlyMap<string, string>,
  directories: Iterable<string> = [],
  specFiles: ReadonlyMap<string, string> = new Map()
): TreeInventory {
  const nodes = new Map<string, TreeNode>();
  ensureNode(nodes, '');
  for (const dir of directories) ensureNode(nodes, dir);
  for (const [capability, content] of specs) {
    const node = ensureNode(nodes, capability);
    const parsed = parseSpecContent(content);
    node.hasSpec = true;
    node.specFile = specFiles.get(capability) ?? path.join(specsDir, ...capability.split('/'), 'spec.md');
    node.lines = parsed.lines;
    node.purpose = parsed.purpose;
    node.requirements = parsed.requirements;
  }
  for (const node of nodes.values()) node.children.sort(compareCodePoints);
  const capabilities = [...nodes.values()]
    .filter((node) => node.hasSpec)
    .map((node) => node.path)
    .sort(compareCodePoints);
  return { specsDir, nodes, capabilities };
}

export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every non-dot, non-symlink directory below `root`, as forward-slash paths. */
async function listDirectories(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && segments.length === 0) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const next = [...segments, entry.name];
      result.push(next.join('/'));
      await walk(path.join(dir, entry.name), next);
    }
  };
  await walk(root, []);
  return result;
}

/** Read the main specs tree. Capability discovery reuses discoverSpecFiles. */
export async function buildTreeInventory(specsDir: string): Promise<TreeInventory> {
  const [discovered, directories] = await Promise.all([
    discoverSpecFiles(specsDir),
    listDirectories(specsDir),
  ]);
  const specs = new Map<string, string>();
  const specFiles = new Map<string, string>();
  for (const { id, specFile } of discovered) {
    specs.set(id, await fs.readFile(specFile, 'utf-8'));
    specFiles.set(id, specFile);
  }
  return buildInventoryFromContents(specsDir, specs, directories, specFiles);
}

/** Capability nodes that share a parent with `nodePath`, excluding itself. */
export function siblingCapabilities(inventory: TreeInventory, nodePath: string): string[] {
  const parent = parentOf(nodePath);
  if (parent === null) return [];
  const parentNode = inventory.nodes.get(parent);
  if (!parentNode) return [];
  return parentNode.children.filter(
    (child) => child !== nodePath && inventory.nodes.get(child)?.hasSpec === true
  );
}

export { parentOf as treeParentOf };
