---
name: openspec-tree-maintain
description: Maintain the OpenSpec capability tree by turning one tree-maintenance instruction (split, merge, review, place, prune) into a validated restructure change. Use only when tree governance is enabled (tree.enabled set to true in openspec/config.yaml). Also use when the user says "openspec maintain tree" or "opsx tree-maintain".
allowed-tools: Bash(openspec:*)
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
---

Maintain the capability tree by turning ONE tree-maintenance instruction into a restructure change.

This workflow applies only when `openspec/config.yaml` sets `tree.enabled: true`. If tree governance is not enabled, tell the user and stop.

**Store selection:** If the user names a store (a store is a standalone OpenSpec repo registered on this machine) or the work lives in one, run `openspec store list --json` to discover registered store ids, then pass `--store <id>` on the commands that read or write specs and changes (`new change`, `status`, `instructions`, `list`, `show`, `validate`, `archive`, `doctor`, `context`, `schemas`, `view`). Once selected, treat `--store <id>` as sticky for the rest of the workflow. Every unscoped example of those commands below is shorthand: before running it, append the flag. For example, run `openspec status --change "<name>" --json --store "<id>"`, not the unscoped form shown below. Other commands do not take the flag. Hints printed by commands already carry the flag; keep it on follow-ups. Without a store, commands act on the nearest local `openspec/` root.

**Project check:** These steps expect a project that already uses OpenSpec. Before the first step that writes anything (`new change`, `archive`, `sync specs`, or authoring an artifact file), confirm the project has a root: run `openspec list --json` (with `--store <id>` when a store is selected, since the store is then the root) and read `root`. A root object means the project is set up. `"root": null` means it is not - there is no `openspec/` directory here, and a write such as `openspec new change` would create one as a side effect. The command also exits non-zero, which is that answer rather than a broken CLI, so read the JSON instead of retrying or working around it.

One `"root": null` is not about setup: when a `status` error message starts with `Declared in` or `Invalid store declaration in` and names this project's `openspec/config.yaml` (or `config.yml`), the project does use OpenSpec through a store it declares, which this machine cannot resolve (the store is not registered, or the `store:` line is malformed). Do not treat it as uninitialized and skip the branches below: stop before writing and show the user that error's `message` and `fix`.

Otherwise, with no root, what happens next depends on how this workflow was reached:

- **Auto-selected**: you chose this workflow yourself, without the user naming OpenSpec, naming this skill, or running its slash command. Stop using OpenSpec and answer the request normally, as you would with no OpenSpec installed. Do not ask them to set anything up and do not mention OpenSpec setup.
- **Explicit OpenSpec request**: the user named OpenSpec, named this skill, or ran its slash command. Stop before writing and ask how to proceed: set this project up (`openspec init`), target a store they already have (`--store <id>`), or continue without OpenSpec for this request. Wait for their answer.

In both branches, never create the root as a side effect: do not run `openspec init` until the user asks for it, do not hand-create `openspec/` files, and do not let a command create it.

**Input**: Optionally a capability path scope or an operation kind. If omitted, take the first instruction returned.

**Steps**

1. **Pick one instruction**

   ```bash
   openspec tree instructions --json [--scope <capability-path>] [--op SPLIT|MERGE|REVIEW|PLACE|PRUNE]
   ```
   Take exactly ONE entry from `instructions`. Note its `id`, `op`, `node`, `trigger`, `inputs`, `allowedManifestOps`, `constraints` and `acceptance`. If the list is empty, report that the tree is healthy and stop.

   PLACE and PRUNE instructions have no manifest (`allowedManifestOps` is empty) and need no restructure change: for PLACE, record the decision under `placement` in the named change's `.openspec.yaml` as its constraints describe; for PRUNE, delete the empty directory. Then re-run the instruction's `acceptance` check and stop.

2. **Create the restructure change**

   ```bash
   openspec new change "<name>" --restructure
   ```
   Use a kebab-case name describing the operation (e.g. `split-auth-session`).

3. **Read every input node and decide**

   Read every node listed in `inputs` fully (`openspec show <id> --type spec`, `openspec tree context <path> --json`). Make the semantic decision yourself: how to group requirements, which requirement to keep when merging, whether to lift a shared fact to a parent or sink a narrow one to a child.

   **REVIEW judgement rules:**
   - One fact (same entity, constraint, value range) is defined in exactly one node.
   - The definition lives at the lowest common ancestor of all nodes that need it.
   - Other nodes keep only their own behaviour and cite the definition by capability path + requirement title.

4. **Write the manifest**

   Fill `restructure.yaml` in the change with `version: 1`, `instruction: <id>` and `operations:` using ONLY the op kinds in that instruction's `allowedManifestOps` (create-namespace, create-capability with a purpose of at least 50 characters, move-capability, move-requirement, merge-requirement, retire-capability). For REVIEW, rewrite a kept requirement with a MODIFIED delta under `specs/` (the only delta kind a restructure change may carry, and only for requirements kept by merge-requirement) and map every dropped scenario in `merge-requirement.scenarios`.

5. **Preview**

   ```bash
   openspec tree plan "<name>"
   ```
   Check the planned file operations and in-flight change rewrites match your intent.

6. **Validate**

   ```bash
   openspec validate "<name>" --strict
   ```
   On failure, fix the manifest (or the MODIFIED delta) and re-run. Never bypass or weaken validation.

7. **Hand over for approval**

   Stop and summarize the instruction, decisions and planned operations for human review. Never archive automatically.

   Once the user approves and explicitly asks to archive it, archive it with the `openspec-archive-change` workflow: it reviews `openspec tree plan` again and archives through `openspec archive`, which applies the manifest, rewrites in-flight changes and appends the redirects. Never move a restructure change into the archive by hand.

**Guardrails**
- Handle exactly one instruction per change
- Never use manifest ops outside `allowedManifestOps`
- Never drop a requirement or scenario without mapping it
- Never archive the change; a human approves it
