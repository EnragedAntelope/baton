#!/usr/bin/env node
import { Command } from 'commander';
import { ZodError } from 'zod';
import { BatonError } from './core/files.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { scanCommand } from './commands/scan.js';
import { claimCommand } from './commands/claim.js';
import { passCommand } from './commands/pass.js';
import { pickupCommand } from './commands/pickup.js';
import { stealCommand } from './commands/steal.js';
import { logCommand } from './commands/log.js';
import { doctorCommand } from './commands/doctor.js';
import { undoCommand, UndoMode } from './commands/undo.js';
import { taskAddCommand, taskListCommand, taskSetCommand } from './commands/task.js';

const program = new Command();

program
  .name('baton')
  .description(
    'Pass-me-along AI coding: relay one project across people and agents. State travels, credentials never do.',
  )
  .version('0.1.0');

function run(action: () => Promise<string>): Promise<void> {
  return action()
    .then((output) => {
      if (output) console.log(output);
    })
    .catch((err: unknown) => {
      if (err instanceof BatonError) {
        console.error(`baton: ${err.message}`);
      } else if (err instanceof ZodError) {
        console.error(
          `baton: invalid value — ${err.issues.map((i) => i.message).join('; ')}`,
        );
      } else {
        console.error(`baton: unexpected error — ${(err as Error).stack ?? err}`);
      }
      process.exitCode = 1;
    });
}

program
  .command('init')
  .description('Scaffold .baton/ in this repo and install the secret-scan hook')
  .option('--project <name>', 'project name (default: repo folder name)')
  .option('--handle <handle>', 'your relay handle (default: git user.name)')
  .option('--agent <agent>', 'your agent: claude-code | opencode | codex | generic')
  .option('--test-cmd <cmd>', 'test command used by the pass policy gate')
  .option('--no-commit', 'do not create the init commit')
  .option('--refresh-hook', 'regenerate the secret-scan hook only')
  .option('--auto', 'auto-detect project settings without prompting')
  .action((opts) => run(() => initCommand(process.cwd(), opts)));

program
  .command('status')
  .description('Show who holds the baton, branch state, and open tasks')
  .action(() => run(() => statusCommand(process.cwd())));

program
  .command('claim')
  .description('Take the baton (refuses if someone else holds a fresh lock)')
  .action(() => run(() => claimCommand(process.cwd())));

program
  .command('pass')
  .description('Hand off: validate HANDOFF.md, run policy gates, tag, release, push')
  .option('--agent <agent>', 'agent that produced this session (for the record)')
  .option('--skip-tests', 'skip the test gate — recorded in the pass tag')
  .option(
    '--auto',
    'invoke your agent CLI headlessly to fill the handoff template',
  )
  .option(
    '--auto-timeout <seconds>',
    'timeout for --auto agent invocation (default 60)',
    '60',
  )
  .option(
    '--interactive',
    'prompt for each handoff section with smart defaults',
  )
  .action((opts) =>
    run(() =>
      passCommand(process.cwd(), {
        agent: opts.agent,
        skipTests: opts.skipTests,
        auto: opts.auto,
        autoTimeout: Number(opts.autoTimeout),
        interactive: opts.interactive,
      }),
    ),
  );

program
  .command('pickup')
  .description('Pull, claim, verify custody, bootstrap your agent, show the digest')
  .option('--agent <agent>', 'your agent: claude-code | opencode | codex | generic')
  .option('--force', 'proceed despite custody verification errors')
  .option('--no-pull', 'skip the automatic git pull before pickup')
  .action((opts) =>
    run(() => pickupCommand(process.cwd(), { agent: opts.agent, force: opts.force, noPull: !opts.pull })),
  );

program
  .command('steal')
  .description('Take a STALE baton from an unreachable holder (audited in decisions.md)')
  .action(() => run(() => stealCommand(process.cwd())));

program
  .command('undo')
  .description('Undo a claim or pass — release the baton and restore state from a snapshot')
  .option('--claim', 'Undo a claim: release the lock and restore pre-claim state')
  .option('--pass', 'Undo a pass mid-pipeline: clean up partial HANDOFF.md and restore state')
  .option('--state', 'Interactively select a snapshot to restore')
  .action((opts) => {
    const modes: UndoMode[] = [];
    if (opts.claim) modes.push('claim');
    if (opts.pass) modes.push('pass');
    if (opts.state) modes.push('state');
    if (modes.length !== 1) {
      console.error('baton: specify exactly one of --claim, --pass, or --state');
      process.exitCode = 1;
      return;
    }
    return run(() => undoCommand(process.cwd(), { mode: modes[0]! }));
  });
program
  .command('log')
  .description('Show the pass history (chain of custody tags)')
  .action(() => run(() => logCommand(process.cwd())));

program
  .command('doctor')
  .description('Diagnose environment and .baton/ health')
  .action(() => run(() => doctorCommand(process.cwd())));
program
  .command('scan')
  .description('Scan .baton/ files for secrets (used by the pre-commit hook)')
  .option('--staged', 'scan staged changes instead of the working tree')
  .action((opts) => run(() => scanCommand(process.cwd(), opts)));

const task = program
  .command('task')
  .description('Inspect or edit the task ledger (.baton/tasks.json)');
task
  .command('list')
  .description('List all tasks')
  .action(() => run(() => taskListCommand(process.cwd())));
task
  .command('add <title>')
  .description('Add a task')
  .option('--deps <ids...>', 'dependency task ids (e.g. task-1 task-2)')
  .action((title, opts) =>
    run(() => taskAddCommand(process.cwd(), title, opts.deps ?? [])),
  );
task
  .command('set <id> <status>')
  .description('Set task status: todo | in-progress | blocked | done | dropped')
  .action((id, status) => run(() => taskSetCommand(process.cwd(), id, status)));

program.parseAsync(process.argv);
