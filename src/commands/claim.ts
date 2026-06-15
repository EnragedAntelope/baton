import { readState, writeState, saveSnapshot } from '../core/files.js';
import { claimState, describeHolder } from '../core/lock.js';
import {
  commitPaths,
  pushFast,
  rollbackLastCommit,
  syncFromOrigin,
} from '../core/repo.js';
import { BatonError } from '../core/files.js';
import { loadContext } from './context.js';

export interface ClaimHooks {
  /** Test seam: runs between the pull and the push to simulate a race. */
  afterSync?: () => Promise<void>;
}

export async function claimCommand(
  cwd: string,
  hooks: ClaimHooks = {},
): Promise<string> {
  const ctx = await loadContext(cwd);
  await syncFromOrigin(ctx.git);
  if (hooks.afterSync) await hooks.afterSync();

  // Re-read after the pull — state.json may have just changed.
  const state = await readState(ctx.root);
  // Save snapshot before claiming so undo can restore pre-claim state.
  await saveSnapshot(ctx.root);
  const claimed = claimState(state, ctx.handle);
  if (state.holder === ctx.handle) {
    return `You already hold the baton (${describeHolder(state)}).`;
  }
  await writeState(ctx.root, claimed);
  await commitPaths(ctx.git, `baton: claim by ${ctx.handle}`, [
    '.baton/state.json',
  ]);

  const push = await pushFast(ctx.git);
  if (push.rejected) {
    // Lost the race: back out our claim commit and report the real holder.
    await rollbackLastCommit(ctx.git);
    await syncFromOrigin(ctx.git);
    const current = await readState(ctx.root);
    throw new BatonError(
      `Someone claimed the baton while you were claiming it — ${describeHolder(current)}.`,
    );
  }
  const where = push.pushed ? 'pushed to origin' : 'committed (no origin remote)';
  return `Baton claimed by ${ctx.handle} — ${where}. Run "baton pickup" if you haven't bootstrapped your agent yet.`;
}
