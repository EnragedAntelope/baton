import { State } from '../types.js';
import { BatonError } from './files.js';

const HOUR_MS = 60 * 60 * 1000;

export function isLockStale(state: State, now: Date = new Date()): boolean {
  if (!state.holder || !state.holderSince) return false;
  const heldMs = now.getTime() - new Date(state.holderSince).getTime();
  return heldMs > state.policy.staleLockHours * HOUR_MS;
}

export function describeHolder(state: State, now: Date = new Date()): string {
  if (!state.holder) return 'baton is free';
  const since = state.holderSince ? new Date(state.holderSince) : null;
  const hours = since
    ? ((now.getTime() - since.getTime()) / HOUR_MS).toFixed(1)
    : '?';
  const stale = isLockStale(state, now) ? ' — STALE, eligible for steal' : '';
  return `held by ${state.holder} for ${hours}h${stale}`;
}

export interface ClaimOptions {
  steal?: boolean;
  now?: Date;
}

/**
 * Pure state transition for claiming the baton. Throws when someone else
 * holds a fresh lock (unless steal is set). Re-claiming your own baton
 * is a no-op refresh.
 */
export function claimState(
  state: State,
  user: string,
  opts: ClaimOptions = {},
): State {
  const now = opts.now ?? new Date();
  if (state.holder && state.holder !== user) {
    const stale = isLockStale(state, now);
    if (!stale && !opts.steal) {
      throw new BatonError(
        `Baton is ${describeHolder(state, now)}. Wait for a pass, or "baton steal" once the lock is stale (${state.policy.staleLockHours}h).`,
      );
    }
    if (!stale && opts.steal) {
      throw new BatonError(
        `Refusing to steal a fresh lock (${describeHolder(state, now)}). Steal is only for locks older than ${state.policy.staleLockHours}h.`,
      );
    }
  }
  return {
    ...state,
    holder: user,
    holderSince: now.toISOString(),
    queue: state.queue.filter((q) => q !== user),
  };
}

/** Pure state transition for releasing the baton at pass time. */
export function releaseState(
  state: State,
  passer: string,
  commit: string,
  now: Date = new Date(),
): State {
  return {
    ...state,
    holder: null,
    holderSince: null,
    passCount: state.passCount + 1,
    lastPass: { user: passer, at: now.toISOString(), commit },
  };
}
