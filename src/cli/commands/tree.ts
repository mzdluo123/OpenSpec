import { Command } from 'commander';
import type { TreeCommonOptions } from '../../commands/tree.js';

type WithScope = TreeCommonOptions & { scope?: string };

/**
 * Run a tree subcommand with the CLI's JSON failure contract: one JSON
 * document on stdout with a status array, or `Error:`/`Fix:` lines.
 */
function run<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const options = args.find(
      (arg): arg is TreeCommonOptions => typeof arg === 'object' && arg !== null && !(arg instanceof Command)
    );
    try {
      await action(...args);
    } catch (error) {
      // Implementations load lazily so `openspec --help` stays cheap (see src/cli/index.ts).
      const { emitFailure } = await import('../../commands/shared-output.js');
      emitFailure(options?.json, {}, error, 'tree_error');
    }
  };
}

/** Tree commands are project-local: store roots are unsupported in v1, so no --store. */
function withRoot(command: Command): Command {
  return command.option('--json', 'Output as JSON');
}

export function registerTreeCommand(program: Command): void {
  const tree = program
    .command('tree')
    .description('Tree-structured spec governance (enabled by tree.enabled in openspec/config.yaml)');

  withRoot(tree.command('check'))
    .description('Check structural tree rules (fanout, spec size, depth, empty nodes, review due)')
    .option('--scope <path>', 'Only report nodes inside this subtree')
    .action(run(async (options: WithScope) => (await import('../../commands/tree.js')).treeCheckCommand(options)));

  withRoot(tree.command('instructions'))
    .description('Turn findings into structured SPLIT / MERGE / REVIEW / PLACE instructions for an agent')
    .option('--scope <path>', 'Only instructions for nodes inside this subtree')
    .option('--op <op>', 'Only this instruction kind: SPLIT|MERGE|REVIEW|PLACE|PRUNE')
    .action(run(async (options: WithScope & { op?: string }) => (await import('../../commands/tree.js')).treeInstructionsCommand(options)));

  withRoot(tree.command('context <capability-path>'))
    .description('Show a node with its parent, siblings, children and the in-flight changes touching them')
    .action(run(async (nodePath: string, options: TreeCommonOptions) => (await import('../../commands/tree.js')).treeContextCommand(nodePath, options)));

  withRoot(tree.command('overlap'))
    .description('List requirements changed by more than one in-flight change')
    .action(run(async (options: TreeCommonOptions) => (await import('../../commands/tree.js')).treeOverlapCommand(options)));

  withRoot(tree.command('plan <change>'))
    .description('Show every file a restructure change would write, delete or rewrite, without writing')
    .action(run(async (change: string, options: TreeCommonOptions) => (await import('../../commands/tree.js')).treePlanCommand(change, options)));

  withRoot(tree.command('pin [change]'))
    .description('Record base snapshots of the main-spec requirements a change rewrites')
    .option('--all', 'Pin every in-flight change')
    .option('--from <source>', 'Where base text comes from: worktree|merge-base', 'worktree')
    .option('--base <ref>', 'Base branch for --from merge-base (default: tree.drift.baseRef)')
    .option('--accept <capability#requirement>', 'Accept the current main-spec text of one drifted requirement')
    .action(run(async (change: string | undefined, options: TreeCommonOptions & { all?: boolean; from?: string; accept?: string; base?: string }) => (await import('../../commands/tree.js')).treePinCommand(change, options)));

  withRoot(tree.command('drift [change]'))
    .description('Compare base snapshots with the working tree and with the base branch')
    .option('--base <ref>', 'Base branch for the remote check (default: tree.drift.baseRef)')
    .action(run(async (change: string | undefined, options: TreeCommonOptions & { base?: string }) => (await import('../../commands/tree.js')).treeDriftCommand(change, options)));

  withRoot(tree.command('rebase <change>'))
    .description('Rewrite a change\'s delta paths and bases through tree-redirects.yaml')
    .option('--dry-run', 'Show what would move without writing')
    .action(run(async (change: string, options: TreeCommonOptions & { dryRun?: boolean }) => (await import('../../commands/tree.js')).treeRebaseCommand(change, options)));

  const migrate = tree.command('migrate').description('Move a project to tree governance in phases');

  withRoot(migrate.command('status'))
    .description('Show the current migration phase and rule violation counts')
    .action(run(async (options: TreeCommonOptions) => (await import('../../commands/tree.js')).treeMigrateStatusCommand(options)));

  withRoot(migrate.command('init'))
    .description('Write the tree config section (all rules warn) and empty redirect/state files')
    .option('--base <ref>', 'Record tree.drift.baseRef')
    .action(run(async (options: TreeCommonOptions & { base?: string }) => (await import('../../commands/tree.js')).treeMigrateInitCommand(options)));

  withRoot(migrate.command('plan'))
    .description('List the tasks and instructions of a migration phase')
    .option('--phase <n>', 'Phase 0-5 (default: current phase)')
    .action(run(async (options: TreeCommonOptions & { phase?: string }) => (await import('../../commands/tree.js')).treeMigratePlanCommand(options)));

  withRoot(migrate.command('import-redirects'))
    .description('Import capability redirects from git renames of spec.md files')
    .option('--from-git <commit-range>', 'Commit range to scan, e.g. v1.0..HEAD')
    .option('-y, --yes', 'Append without confirmation')
    .action(run(async (options: TreeCommonOptions & { fromGit?: string; yes?: boolean }) => (await import('../../commands/tree.js')).treeMigrateImportRedirectsCommand(options)));
}
