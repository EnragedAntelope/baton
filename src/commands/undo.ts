import { promises as fs } from 'node:fs';
import readline from 'node:readline';
import {
  batonPaths,
  BatonError,
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
  writeState,
} from '../core/files.js';
import { releaseState } from '../core/lock.js';
import {
  commitPaths,
  headCommit,
  pushFast,
} from '../core/repo.js';
import { confirmPrompt, promptUser } from '../core/prompts.js';
import { loadContext } from './context.js';

export type UndoMode = 'claim' | 'pass' | 'state';

export interface UndoOptions {
  mode: UndoMode;
}

/** Test seam: inject a mock readline for interactive prompts. */
export interface UndoDeps {
  promptReadline?: readline.Interface;
}
function formatSnapshotList(timestamps: string[]): string {
  return timestamps
    .map((ts, i) => {
      const d = new Date(
        Number(ts.slice(0, 4)),
        Number(ts.slice(4, 6)) - 1,
        Number(ts.slice(6, 8)),
        Number(ts.slice(8, 10)),
        Number(ts.slice(10, 12)),
        Number(ts.slice(12, 14)),
        Number(ts.slice(14, 17)),
      );
      return `  [${i + 1}] ${ts}  (${d.toLocaleString()})`;
    })
    .join('\n');
}

export async function undoCommand(
  cwd: string,
  opts: UndoOptions,
  deps: UndoDeps = {},
): Promise<string> {
  const ctx = await loadContext(cwd);
  const paths = batonPaths(ctx.root);

  if (ctx.state.holder !== ctx.handle) {
    throw new BatonError(
      ctx.state.holder
        ? `You don't hold the baton (held by ${ctx.state.holder}). Only the current holder can undo.`
        : 'No one holds the baton — nothing to undo.',
    );
  }

  const snapshots = await listSnapshots(ctx.root);
  if (snapshots.length === 0) {
    throw new BatonError('Nothing to undo — no snapshots saved yet.');
  }

  // --state mode: interactive snapshot selection
  if (opts.mode === 'state') {
    console.log('Available snapshots:\n' + formatSnapshotList(snapshots));
    const { choice } = await promptUser([
      {
        name: 'choice',
        message: 'Enter snapshot number to restore (or "q" to cancel)',
        default: 'q',
        validate: (value: string) => {
          if (value === 'q') return true;
          const n = Number(value);
          if (Number.isNaN(n) || n < 1 || n > snapshots.length) {
            return `Enter a number between 1 and ${snapshots.length}, or "q" to cancel.`;
          }
          return true;
        },
      },
    ], deps.promptReadline);

    if (choice === 'q') {
      return 'Undo cancelled.';
    }
    const idx = Number(choice) - 1;
    if (idx < 0 || idx >= snapshots.length || !snapshots[idx]) {
      return 'Invalid selection.';
    }
    await restoreSnapshot(ctx.root, snapshots[idx]);
    const restored = snapshots[idx];
    const d = new Date(
      Number(restored.slice(0, 4)),
      Number(restored.slice(4, 6)) - 1,
      Number(restored.slice(6, 8)),
      Number(restored.slice(8, 10)),
      Number(restored.slice(10, 12)),
      Number(restored.slice(12, 14)),
      Number(restored.slice(14, 17)),
    );
    await commitPaths(ctx.git, `baton: undo --state (restored snapshot ${restored})`, [
      '.baton/state.json',
    ]);
    await pushFast(ctx.git);
    return `State restored to snapshot ${restored} (${d.toLocaleString()}).`;
  }

  // --claim and --pass modes require confirmation
  const confirmed = await confirmPrompt('This will release the baton. Continue?', false, deps.promptReadline);
  if (!confirmed) {
    return 'Undo cancelled.';
  }

  if (opts.mode === 'pass') {
    // Clean up partial HANDOFF.md if it exists
    try {
      await fs.unlink(paths.handoff);
    } catch {
      // HANDOFF.md may not exist if pass hadn't reached template-writing yet
    }
  }

  // Save current state as a snapshot first (preserve the undo point),
  // then restore the PREVIOUS snapshot — not the one just saved.
  await saveSnapshot(ctx.root);
  await restoreSnapshot(ctx.root, snapshots[snapshots.length - 1]!);

  await commitPaths(ctx.git, `baton: undo --${opts.mode} by ${ctx.handle}`, [
    '.baton/state.json',
  ]);
  await pushFast(ctx.git);
  return `Baton released — state restored to previous snapshot.`;
}
