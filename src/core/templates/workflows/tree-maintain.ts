/**
 * Tree maintenance workflow: turns one `openspec tree instructions` item
 * into a reviewed restructure change.
 */
import type { SkillTemplate, CommandTemplate } from '../types.js';
import { STORE_SELECTION_GUIDANCE } from './store-selection.js';
import { PROJECT_ROOT_GUARD } from './project-root.js';
import { optionalWorkflow } from '../optional-workflow.js';

const ARCHIVE_HANDOFF = optionalWorkflow(
  'archive',
  'archive it with the `openspec-archive-change` workflow',
  'archive it with `openspec archive "<name>"` after reviewing `openspec tree plan "<name>"`'
);

function treeMaintainBody(input: string): string {
  return `Maintain the capability tree by turning ONE tree-maintenance instruction into a restructure change.

This workflow applies only when \`openspec/config.yaml\` sets \`tree.enabled: true\`. If tree governance is not enabled, tell the user and stop.

${STORE_SELECTION_GUIDANCE}

${PROJECT_ROOT_GUARD}

${input}

**Steps**

1. **Pick one instruction**

   \`\`\`bash
   openspec tree instructions --json [--scope <capability-path>] [--op SPLIT|MERGE|REVIEW|PLACE|PRUNE]
   \`\`\`
   Take exactly ONE entry from \`instructions\`. Note its \`id\`, \`op\`, \`node\`, \`trigger\`, \`inputs\`, \`allowedManifestOps\`, \`constraints\` and \`acceptance\`. If the list is empty, report that the tree is healthy and stop.

   PLACE and PRUNE instructions have no manifest (\`allowedManifestOps\` is empty) and need no restructure change: for PLACE, record the decision under \`placement\` in the named change's \`.openspec.yaml\` as its constraints describe; for PRUNE, delete the empty directory. Then re-run the instruction's \`acceptance\` check and stop.

2. **Create the restructure change**

   \`\`\`bash
   openspec new change "<name>" --restructure
   \`\`\`
   Use a kebab-case name describing the operation (e.g. \`split-auth-session\`).

3. **Read every input node and decide**

   Read every node listed in \`inputs\` fully (\`openspec show <id> --type spec\`, \`openspec tree context <path> --json\`). Make the semantic decision yourself: how to group requirements, which requirement to keep when merging, whether to lift a shared fact to a parent or sink a narrow one to a child.

   **REVIEW judgement rules:**
   - One fact (same entity, constraint, value range) is defined in exactly one node.
   - The definition lives at the lowest common ancestor of all nodes that need it.
   - Other nodes keep only their own behaviour and cite the definition by capability path + requirement title.

4. **Write the manifest**

   Fill \`restructure.yaml\` in the change with \`version: 1\`, \`instruction: <id>\` and \`operations:\` using ONLY the op kinds in that instruction's \`allowedManifestOps\` (create-namespace, create-capability with a purpose of at least 50 characters, move-capability, move-requirement, merge-requirement, retire-capability). For REVIEW, rewrite a kept requirement with a MODIFIED delta under \`specs/\` (the only delta kind a restructure change may carry, and only for requirements kept by merge-requirement) and map every dropped scenario in \`merge-requirement.scenarios\`.

5. **Preview**

   \`\`\`bash
   openspec tree plan "<name>"
   \`\`\`
   Check the planned file operations and in-flight change rewrites match your intent.

6. **Validate**

   \`\`\`bash
   openspec validate "<name>" --strict
   \`\`\`
   On failure, fix the manifest (or the MODIFIED delta) and re-run. Never bypass or weaken validation.

7. **Hand over for approval**

   Stop and summarize the instruction, decisions and planned operations for human review. Never archive automatically.

   Once the user approves and explicitly asks to archive it, ${ARCHIVE_HANDOFF}: it reviews \`openspec tree plan\` again and archives through \`openspec archive\`, which applies the manifest, rewrites in-flight changes and appends the redirects. Never move a restructure change into the archive by hand.

**Guardrails**
- Handle exactly one instruction per change
- Never use manifest ops outside \`allowedManifestOps\`
- Never drop a requirement or scenario without mapping it
- Never archive the change; a human approves it`;
}

export function getTreeMaintainSkillTemplate(): SkillTemplate {
  return {
    name: 'openspec-tree-maintain',
    description: 'Maintain the OpenSpec capability tree by turning one tree-maintenance instruction (split, merge, review, place, prune) into a validated restructure change. Use only when tree governance is enabled (tree.enabled set to true in openspec/config.yaml). Also use when the user says "openspec maintain tree" or "opsx tree-maintain".',
    instructions: treeMaintainBody(
      '**Input**: Optionally a capability path scope or an operation kind. If omitted, take the first instruction returned.'
    ),
    license: 'MIT',
    compatibility: 'Requires openspec CLI.',
    metadata: { author: 'openspec', version: '1.0' },
  };
}

export function getOpsxTreeMaintainCommandTemplate(): CommandTemplate {
  return {
    name: 'OPSX: Tree Maintain',
    description: 'Turn one tree-maintenance instruction into a validated restructure change (tree governance only)',
    category: 'Workflow',
    tags: ['workflow', 'tree', 'experimental'],
    content: treeMaintainBody(
      '**Input**: Optionally a capability path scope or operation kind after `/opsx:tree-maintain` (e.g. `/opsx:tree-maintain identity`). If omitted, take the first instruction returned.'
    ),
  };
}
