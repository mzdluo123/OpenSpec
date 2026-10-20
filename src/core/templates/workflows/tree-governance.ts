/**
 * Shared tree-governance guidance for change-authoring workflow templates.
 *
 * Every step applies only when `tree.enabled: true` is set in
 * openspec/config.yaml; projects without tree config behave as upstream.
 */
import { optionalWorkflow } from '../optional-workflow.js';

const PLACEMENT_LINES = [
  '**Tree placement (only when `openspec/config.yaml` sets `tree.enabled: true`; otherwise skip):** before drafting the `specs` artifact, for every requirement you will ADD:',
  '  1. Pick a candidate capability path and run `openspec tree context <candidate> --json` to see its parent, siblings, children and in-flight changes touching them.',
  '  2. Read the relevant node specs fully (`openspec show <id> --type spec`).',
  '  3. If the fact is already defined elsewhere, MODIFY it there or reference it (capability path + requirement title) instead of restating it. If several siblings need it, place it in the parent capability.',
  '  4. Record the decision under `placement` in the change\'s `.openspec.yaml`: `{ requirement, capability, decision: existing-capability|new-capability|new-parent, reviewed: [...], rationale }`. `capability` must equal the delta path; `reviewed` must include the target capability (if it exists), its parent (if it has a spec) and every sibling.',
];

const PIN_LINE =
  '**Tree pin (only when `tree.enabled: true`):** right after writing or editing any specs delta, run `openspec tree pin "<name>"` to record base snapshots of MODIFIED/REMOVED/RENAMED targets.';

function indent(lines: string[], prefix: string): string {
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

/** Placement + pin guidance as a bullet block at the given indentation. */
export function treeGovernanceGuidance(prefix: string): string {
  return `${indent([`- ${PLACEMENT_LINES[0]}`], prefix)}
${indent(PLACEMENT_LINES.slice(1), prefix)}
${indent([`- ${PIN_LINE}`], prefix)}`;
}

const TREE_MAINTAIN_HINT = optionalWorkflow(
  'tree-maintain',
  'suggest running the `openspec-tree-maintain` workflow for that instruction',
  'suggest turning that instruction into a restructure change with `openspec new change "<restructure-name>" --restructure`'
);

/**
 * Archive-time tree gate, shared by the archive skill and command. Under tree
 * governance the CLI archive is the only path that enforces drift and stale
 * paths and applies restructure manifests, so the manual sync + move is
 * replaced by `openspec archive`.
 */
export const TREE_ARCHIVE_GATE = `**Tree governance gate (only when \`openspec/config.yaml\` sets \`tree.enabled: true\`; otherwise go straight to step 4).** Run it after step 3:

   a. Run \`openspec validate "<name>" --json\` and collect every issue that has a \`code\`.

   b. **Restructure change** (\`.openspec.yaml\` has \`restructure: true\`): never sync or move it by hand; that would archive it without applying \`restructure.yaml\`. Run \`openspec tree plan "<name>" --json\` and show the operations, spec file writes and deletions, in-flight changes it rewrites, and redirects it appends. If \`valid\` is false or \`conflicts\` is not empty, report them and stop. Archive only when the user explicitly asked to archive this restructure: run \`openspec archive "<name>" --yes --json\`, show \`archive.restructure\`, run \`openspec validate "<rewritten-change>" --strict\` for each rewritten change, then skip to step 6.

   c. **Normal change**, handle each code before archiving:
   - \`CHANGE_STALE_PATH\`: run \`openspec tree rebase "<name>" --dry-run --json\`, show the moves, then run it without \`--dry-run\` and validate again. Rebase only moves files; requirement text is unchanged. If it reports a merged requirement, stop and tell the user which kept requirement the delta must target instead.
   - \`CHANGE_DRIFT\`: the main spec changed after this change pinned its base. Show the diff from the message, merge the newer text into this change's MODIFIED block, show the edited block, and stop for approval: this changes reviewed content. After approval, accept each requirement separately with \`openspec tree pin "<name>" --accept "<capability>#<requirement>"\` and validate again. Never accept text you did not merge, and never accept several requirements in one step.
   - \`CHANGE_BASE_UNPINNED\`: report it and ask whether the current main-spec text is the base this change was written against before running \`openspec tree pin "<name>"\`. Pinning at archive time would bless text that may already have drifted.
   - \`CHANGE_OVERLAP\`: list the other changes. Archiving this one makes their pinned bases drift; say so, but do not edit them.
   - \`CHANGE_REMOTE_DRIFT\`: report it; the branch should be rebased onto the base branch and re-checked before archiving.

   d. With the gate clear, do not run the inline sync in step 4 or the manual move in step 5. Show the step 4 assessment of what will merge, then archive with \`openspec archive "<name>" --yes --json\` (add \`--skip-specs\` only if the user chose to archive without syncing). The CLI merges the deltas, refuses on drift or stale paths at the moment it writes, and moves the change with its \`bases.yaml\`. If it refuses, report the \`status\` code and message and return to c.

   e. After archiving, run \`openspec tree check --json --scope <domain>\` for each top-level domain the change touched. If it reports \`TREE_FANOUT\`, \`TREE_SPEC_TOO_LONG\` or \`TREE_REVIEW_DUE\` there, ${TREE_MAINTAIN_HINT}; do not start a restructure yourself.`;

/** Bulk-archive variant: one tree gate per change, re-run after every archive. */
export const TREE_BULK_ARCHIVE_GATE = `**Tree governance (only when \`openspec/config.yaml\` sets \`tree.enabled: true\`):**
   - Exclude restructure changes (\`restructure: true\` in \`.openspec.yaml\`) from the batch; they are archived one at a time with the single-change archive workflow after \`openspec tree plan\` review.
   - For each selected change, run \`openspec validate "<name>" --json\` and mark it blocked when it reports \`CHANGE_STALE_PATH\` or \`CHANGE_DRIFT\`. Show the code in the status table. Resolve stale paths with \`openspec tree rebase "<name>"\`; drift needs the author's merge and a per-requirement \`openspec tree pin "<name>" --accept "<capability>#<requirement>"\`, so skip drifted changes in this batch.
   - Archive each change with \`openspec archive "<name>" --yes --json\` instead of syncing and moving it by hand, so the CLI enforces drift and stale paths when it writes the specs.
   - After each archive, validate the remaining batch again: an earlier archive can make a later change drift. Skip any change that now reports \`CHANGE_DRIFT\` and list it in the summary.`;

export const TREE_ARCHIVE_GUARDRAIL =
  '- Under tree governance (`tree.enabled: true`), archive only through `openspec archive`; never move a restructure change by hand and never `--accept` drift you did not merge';
