import { promises as fs } from 'node:fs';
import { batonPaths, BatonError, readState, writeState } from '../core/files.js';
import { claimState, describeHolder, isLockStale } from '../core/lock.js';
import {
  commitPaths,
  pushFast,
  rollbackLastCommit,
  syncFromOrigin,
} from '../core/repo.js';
import { loadContext } from './context.js';

/**
 * Take a stale baton from an unreachable holder. Deliberately loud:
 * refuses fresh locks and writes an audit entry to decisions.md.
 */
export async function stealCommand(cwd: string): Promise<string> {
  const ctx = await loadContext(cwd);
  await syncFromOrigin(ctx.git);
  const state = await readState(ctx.root);

  if (!state.holder) {
    throw new BatonError('Baton is free — just "baton claim".');
  }
  if (state.holder === ctx.handle) {
    throw new BatonError('You already hold the baton.');
  }
  if (!isLockStale(state)) {
    throw new BatonError(
      `Refusing: ${describeHolder(state)} and the stale threshold is ${state.policy.staleLockHours}h. Ask them to pass, or wait.`,
    );
  }

  const previousHolder = state.holder;
  const claimed = claimState(state, ctx.handle, { steal: true });
  await writeState(ctx.root, claimed);

  const entry = `\n- ${new Date().toISOString()} — **${ctx.handle}** stole the baton from **${previousHolder}** (lock exceeded ${state.policy.staleLockHours}h, holder unreachable). Work in progress may exist — check the branch before building on it.\n`;
  await fs.appendFile(batonPaths(ctx.root).decisions, entry, 'utf8');

  await commitPaths(
    ctx.git,
    `baton: STEAL by ${ctx.handle} from ${previousHolder} (stale lock)`,
    ['.baton/state.json', '.baton/decisions.md'],
  );
  const push = await pushFast(ctx.git);
  if (push.rejected) {
    await rollbackLastCommit(ctx.git);
    await syncFromOrigin(ctx.git);
    const current = await readState(ctx.root);
    throw new BatonError(
      `State changed while stealing — ${describeHolder(current)}. Re-check before trying again.`,
    );
  }
  return [
    `Baton stolen from ${previousHolder} (stale lock). Recorded in decisions.md.`,
    `Heads up: ${previousHolder} may have uncommitted local work. Coordinate when they resurface.`,
    'Run "baton pickup" to bootstrap your agent.',
  ].join('\n');
}
