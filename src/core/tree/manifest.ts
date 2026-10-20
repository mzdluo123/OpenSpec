import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalizeTreePath } from './config.js';

/** changes/<change>/restructure.yaml: the operations a restructure change applies. */

export const MANIFEST_FILENAME = 'restructure.yaml';

const TreePathSchema = z
  .string()
  .min(1)
  .transform(normalizeTreePath)
  .refine((value) => value !== '' && value.split('/').every((segment) => segment !== '.' && segment !== '..' && !segment.startsWith('.')), {
    message: 'must be a capability path relative to openspec/specs (no ".", ".." or dot segments)',
  });

const RequirementRefSchema = z.object({
  capability: TreePathSchema,
  requirement: z.string().min(1),
});

const OperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create-namespace'), path: TreePathSchema }).strict(),
  z.object({ op: z.literal('create-capability'), path: TreePathSchema, purpose: z.string() }).strict(),
  z.object({ op: z.literal('move-capability'), from: TreePathSchema, to: TreePathSchema }).strict(),
  z
    .object({
      op: z.literal('move-requirement'),
      from: TreePathSchema,
      to: TreePathSchema,
      requirement: z.string().min(1),
      renameTo: z.string().min(1).nullish(),
    })
    .strict(),
  z
    .object({
      op: z.literal('merge-requirement'),
      keep: RequirementRefSchema,
      drop: RequirementRefSchema,
      scenarios: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z.object({ op: z.literal('retire-capability'), path: TreePathSchema }).strict(),
]);

export type ManifestOperation = z.infer<typeof OperationSchema>;
export type ManifestOpName = ManifestOperation['op'];

const ManifestSchema = z
  .object({
    version: z.literal(1),
    instruction: z.string().min(1).nullish(),
    operations: z.array(OperationSchema).nullish().transform((value) => value ?? []),
  })
  .strict();

export interface RestructureManifest {
  version: 1;
  instruction?: string;
  operations: ManifestOperation[];
}

export function manifestPath(changeDir: string): string {
  return path.join(changeDir, MANIFEST_FILENAME);
}

export const EMPTY_MANIFEST = 'version: 1\noperations: []\n';

export function parseManifest(content: string): RestructureManifest {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    throw new Error(`Invalid YAML in ${MANIFEST_FILENAME}: ${(error as Error).message}`);
  }
  const parsed = ManifestSchema.safeParse(raw ?? { version: 1 });
  if (!parsed.success) {
    throw new Error(
      `Invalid ${MANIFEST_FILENAME}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  return {
    version: 1,
    ...(parsed.data.instruction ? { instruction: parsed.data.instruction } : {}),
    operations: parsed.data.operations,
  };
}

export async function readManifest(changeDir: string): Promise<RestructureManifest> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath(changeDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Restructure change has no ${MANIFEST_FILENAME}.`);
    }
    throw error;
  }
  return parseManifest(content);
}

/** Short human description of an operation. */
export function describeOperation(operation: ManifestOperation): string {
  switch (operation.op) {
    case 'create-namespace':
      return `create-namespace ${operation.path}`;
    case 'create-capability':
      return `create-capability ${operation.path}`;
    case 'move-capability':
      return `move-capability ${operation.from} -> ${operation.to}`;
    case 'move-requirement':
      return `move-requirement "${operation.requirement}" ${operation.from} -> ${operation.to}${operation.renameTo ? ` as "${operation.renameTo}"` : ''}`;
    case 'merge-requirement':
      return `merge-requirement ${operation.drop.capability}#${operation.drop.requirement} into ${operation.keep.capability}#${operation.keep.requirement}`;
    case 'retire-capability':
      return `retire-capability ${operation.path}`;
  }
}
