import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from 'yaml';
import type { TreePaths } from '../../../src/core/tree/context.js';

export interface RequirementFixture {
  name: string;
  text?: string;
  scenarios?: string[];
}

export function requirement(fixture: RequirementFixture): string {
  const scenarios = fixture.scenarios ?? [`${fixture.name} works`];
  return [
    `### Requirement: ${fixture.name}`,
    fixture.text ?? `The system SHALL support ${fixture.name.toLowerCase()}.`,
    '',
    ...scenarios.flatMap((scenario) => [`#### Scenario: ${scenario}`, '- **WHEN** it is used', '- **THEN** it behaves', '']),
  ]
    .join('\n')
    .trimEnd();
}

export function spec(
  name: string,
  requirements: Array<RequirementFixture | string>,
  purpose = `Defines ${name} behaviour so every reader finds one authoritative owner for it.`
): string {
  const blocks = requirements.map((entry) => (typeof entry === 'string' ? requirement({ name: entry }) : requirement(entry)));
  return `# ${name} Specification\n\n## Purpose\n${purpose}\n\n## Requirements\n\n${blocks.join('\n\n')}\n`;
}

export interface ChangeFixture {
  metadata?: Record<string, unknown>;
  files: Record<string, string>;
}

export interface TreeProject {
  root: string;
  paths: TreePaths;
  write(relative: string, content: string): Promise<void>;
  read(relative: string): Promise<string>;
  exists(relative: string): Promise<boolean>;
  /** Every file under openspec/, relative, with content - for before/after comparisons. */
  snapshot(): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

export const DEFAULT_PROPOSAL = '# Change\n\n## Why\nExercise tree governance in a test.\n\n## What Changes\n- Something\n';

export async function createTreeProject(options: {
  tree?: Record<string, unknown> | false;
  specs?: Record<string, string>;
  changes?: Record<string, ChangeFixture>;
  extra?: Record<string, string>;
}): Promise<TreeProject> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-tree-')));
  const root = path.join(base, 'project');
  const openspecDir = path.join(root, 'openspec');
  const write = async (relative: string, content: string) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const config: Record<string, unknown> = { schema: 'spec-driven' };
  if (options.tree !== false) config.tree = { enabled: true, ...(options.tree ?? {}) };
  await write('openspec/config.yaml', stringify(config));
  await fs.mkdir(path.join(openspecDir, 'specs'), { recursive: true });
  await fs.mkdir(path.join(openspecDir, 'changes', 'archive'), { recursive: true });
  for (const [capability, content] of Object.entries(options.specs ?? {})) {
    await write(`openspec/specs/${capability}/spec.md`, content);
  }
  for (const [name, change] of Object.entries(options.changes ?? {})) {
    await write(`openspec/changes/${name}/.openspec.yaml`, stringify({ schema: 'spec-driven', ...(change.metadata ?? {}) }));
    await write(`openspec/changes/${name}/proposal.md`, DEFAULT_PROPOSAL);
    for (const [relative, content] of Object.entries(change.files)) {
      await write(`openspec/changes/${name}/${relative}`, content);
    }
  }
  for (const [relative, content] of Object.entries(options.extra ?? {})) await write(relative, content);

  const snapshot = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          result[`${path.relative(root, absolute).split(path.sep).join('/')}/`] = '';
          await walk(absolute);
        } else {
          result[path.relative(root, absolute).split(path.sep).join('/')] = await fs.readFile(absolute, 'utf-8');
        }
      }
    };
    await walk(openspecDir);
    return result;
  };

  return {
    root,
    paths: {
      projectRoot: root,
      openspecDir,
      specsDir: path.join(openspecDir, 'specs'),
      changesDir: path.join(openspecDir, 'changes'),
      archiveDir: path.join(openspecDir, 'changes', 'archive'),
    },
    write,
    read: (relative) => fs.readFile(path.join(root, relative), 'utf-8'),
    exists: (relative) => fs.access(path.join(root, relative)).then(() => true, () => false),
    snapshot,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}
