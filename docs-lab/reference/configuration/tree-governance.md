# Tree governance (tree:, restructure.yaml, bases.yaml)

> The `tree:` config section, the files tree governance writes, the `openspec tree` commands, and the rule codes they report.

Tree governance treats `openspec/specs/` as a tree: one fact lives in one capability, and every move happens through a restructure change the CLI applies. It is off unless `openspec/config.yaml` sets `tree.enabled: true`. Without it, every command behaves as it does upstream.

## Files

- **`openspec/config.yaml` → `tree:`**: limits and per-rule enforcement.
- **`openspec/tree-redirects.yaml`**: every archived capability move, requirement move, and merge, in archive order.
- **`openspec/tree-state.yaml`**: when each subtree was last reviewed.
- **`openspec/changes/<change>/bases.yaml`**: the main-spec text each MODIFIED, REMOVED, or RENAMED target had when the delta was written.
- **`openspec/changes/<change>/restructure.yaml`**: the operations of a restructure change.

## tree:

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Turns every tree hook on |
| `maxChildren` | integer | `20` | Direct subdirectories a node may have (`TREE_FANOUT`) |
| `maxSpecLines` | integer | `300` | Lines a `spec.md` may have (`TREE_SPEC_TOO_LONG`) |
| `maxRequirements` | integer | `15` | Requirements a `spec.md` may have (`TREE_SPEC_TOO_LONG`) |
| `minSpecLines` | integer | `60` | Floor for a capability a restructure creates or shrinks; it must reach this many lines or `minRequirements` (`RESTRUCTURE_TOO_GRANULAR`). Must be at most half of `maxSpecLines` |
| `minRequirements` | integer | `3` | Requirement-count side of the same floor. Must be at most half of `maxRequirements` |
| `mergeBelowLines` | integer | `80` | A spec shorter than this with sibling capabilities is a merge candidate (`TREE_SPEC_TOO_SHORT`) |
| `maxDepth` | integer | `4` | Directory depth below `specs/` (`TREE_DEPTH`) |
| `reviewAfterArchives` | integer | `10` | Archives touching a subtree since its last review before `TREE_REVIEW_DUE` |
| `maxOpenChanges` | integer | none | In-flight change limit that `tree migrate status` checks in phase 1 |
| `scope` | list of paths | `[]` | Subtrees that use the configured enforcement; elsewhere a finding is at most a warning. Empty means the whole tree |
| `enforcement` | map: code → `off`, `info`, `warn`, `error` | see [Rule codes](#rule-codes) | Level each rule reports at |
| `drift.baseRef` | string | none | Branch the remote drift check reads, such as `origin/main` |

An invalid `tree:` section prints a warning and turns tree governance off. The rest of the config still loads.

Tree warnings never fail `openspec validate --strict`. Only rules set to `error` block.

## Rule codes

| Code | Default | Reported when |
| --- | --- | --- |
| `TREE_FANOUT` | `warn` | A node has more than `maxChildren` children, or a new capability would push its parent over |
| `TREE_SPEC_TOO_LONG` | `warn` | A spec exceeds `maxSpecLines` or `maxRequirements` |
| `TREE_SPEC_TOO_SHORT` | `info` | A spec is under `mergeBelowLines` and has sibling capabilities |
| `TREE_SPEC_TOO_GRANULAR` | `warn` | A normal change creates a capability below `minSpecLines` lines and `minRequirements` requirements |
| `TREE_DEPTH` | `warn` | A node is deeper than `maxDepth` |
| `TREE_EMPTY_NODE` | `error` | A directory has no `spec.md` and no capability below it |
| `TREE_REVIEW_DUE` | `info` | A subtree reached `reviewAfterArchives` archives since its last review |
| `CHANGE_PLACEMENT_MISSING` | `error` | An ADDED requirement has no matching `placement` entry, or the entry skips a neighbour |
| `CHANGE_STALE_PATH` | `error` | A delta targets a capability or requirement that `tree-redirects.yaml` says moved |
| `CHANGE_OVERLAP` | `warn` | Two in-flight changes modify, remove, or rename the same requirement |
| `CHANGE_DRIFT` | `error` | A pinned base differs from the current main spec, or its requirement was removed or merged |
| `CHANGE_BASE_UNPINNED` | `warn` | A MODIFIED, REMOVED, or RENAMED target has no entry in `bases.yaml` |
| `CHANGE_REMOTE_DRIFT` | `warn` | A pinned base already differs on `drift.baseRef` |

Restructure changes also report `CONSERVATION_*` and `RESTRUCTURE_*` codes. These are always errors. `RESTRUCTURE_TOO_GRANULAR` refuses a restructure that leaves a created capability, or one it moved requirements out of, below the floor; capabilities it does not touch are not checked. A `split-spec` instruction states the floor and `maxParts`, the most parts (parent included) that can each clear it.

`openspec archive` refuses a normal change while `CHANGE_DRIFT` (diagnostic code `drift`) or `CHANGE_STALE_PATH` (`stale_path`) is an error.

## Change metadata

Two `.openspec.yaml` keys belong to tree governance:

- **`placement`**: a list of `{ requirement, capability, decision, reviewed, rationale }`, one entry per ADDED requirement. `decision` is `existing-capability`, `new-capability`, or `new-parent`. `capability` must equal the delta path. `reviewed` must list the target capability if it exists, its parent if the parent has a `spec.md`, and every sibling capability.
- **`restructure`**: `true` marks a restructure change. `openspec new change <name> --restructure` sets it and writes an empty `restructure.yaml`.

## restructure.yaml

```yaml
version: 1
instruction: split:contract-review   # optional: the instruction id this change answers
operations:
  - op: create-namespace
    path: contract-review/review-run
  - op: move-capability
    from: contract-review/orchestration-integrity
    to: contract-review/review-run/orchestration-integrity
```

| Operation | Fields | Precondition |
| --- | --- | --- |
| `create-namespace` | `path` | Path does not exist; parent exists |
| `create-capability` | `path`, `purpose` | Path does not exist; parent exists; purpose has 50 or more characters |
| `move-capability` | `from`, `to` | `from` exists; `to` does not; `to` is not inside `from`; parent of `to` exists |
| `move-requirement` | `from`, `to`, `requirement`, `renameTo` | Exactly one requirement with that name in `from`; none with the target name in `to` |
| `merge-requirement` | `keep`, `drop`, `scenarios` | Both exist; every scenario of `drop` maps to a scenario `keep` has after this change's MODIFIED delta |
| `retire-capability` | `path` | The capability has no requirements left |

Operations apply in order. The first failed precondition stops the simulation. A restructure change may carry only MODIFIED deltas, and only for requirements it keeps in `merge-requirement`. Every other requirement must arrive byte-identical, apart from a renamed header.

An `instruction` limits the operations allowed: `split` allows `create-namespace` and `move-capability`; `split-spec` allows `create-capability` and `move-requirement`; `lift` allows `move-capability`; `merge` allows `move-requirement` and `retire-capability`; `review` allows `move-requirement`, `merge-requirement`, `create-capability`, and `retire-capability`. Archiving a `review:<node>` instruction records the review in `tree-state.yaml`.

Archiving a restructure change writes the new tree, rewrites the deltas and `bases.yaml` of other in-flight changes, appends to `tree-redirects.yaml`, and moves the change to the archive. A failure at any step restores every file. Archive refuses with `RESTRUCTURE_INFLIGHT_CONFLICT` when another change targets a merged-away requirement or a retired capability.

## Commands

| Command | What it does |
| --- | --- |
| `openspec tree check [--scope <path>] [--json]` | Structural findings; exits 1 on any error-level finding |
| `openspec tree instructions [--scope <path>] [--op SPLIT\|MERGE\|REVIEW\|PLACE\|PRUNE] [--json]` | One structured instruction per finding, with the inputs an agent needs |
| `openspec tree context <capability-path> [--json]` | The node, its parent, siblings and children, and the in-flight changes touching them |
| `openspec tree overlap [--json]` | Requirements changed by more than one in-flight change |
| `openspec tree plan <change> [--json]` | Every file a restructure change would write, delete, or rewrite; writes nothing |
| `openspec tree pin [<change> \| --all] [--from worktree\|merge-base] [--base <ref>]` | Records missing base snapshots; never overwrites an existing one |
| `openspec tree pin <change> --accept "<capability>#<requirement>"` | Accepts the current main-spec text for one drifted requirement and keeps the old hash in `previous` |
| `openspec tree drift [<change>] [--base <ref>] [--json]` | Local and remote drift per pinned requirement |
| `openspec tree rebase <change> [--dry-run] [--json]` | Moves a change's deltas and bases along `tree-redirects.yaml` |
| `openspec tree migrate status \| init \| plan [--phase <n>] \| import-redirects --from-git <range> [--yes]` | Migration phases 0 to 5 |

Tree commands work on the project's own `openspec/`. A store root reports `TREE_STORE_UNSUPPORTED`.

## Skills

- **`openspec-tree-maintain`**: turns one instruction from `openspec tree instructions` into a restructure change, validates it, and stops for approval.
- **`openspec-archive-change`** and **`openspec-bulk-archive-change`**: with `tree.enabled: true` they check the change before archiving. They rebase stale paths, stop on drift until the merged text is approved and accepted per requirement, review `openspec tree plan` for restructure changes, and archive through `openspec archive` instead of moving the folder by hand.
