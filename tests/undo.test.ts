import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCommand } from '../src/commands/claim.js';
import { initCommand } from '../src/commands/init.js';
import { undoCommand } from '../src/commands/undo.js';
import { readState, saveSnapshot, listSnapshots, batonPaths } from '../src/core/files.js';
import { makeRepo, rmrf, TempRepo } from './helpers.js';

/** Create a mock readline.Interface that returns preset answers in order. */
function mockReadline(answers: string[]): readline.Interface {
  let idx = 0;
  return {
    question: (_query: string, cb: (answer: string) => void) => {
      cb(answers[idx++] ?? '');
    },
    close: () => {},
  } as unknown as readline.Interface;
}

describe('baton undo', () => {
  let repo: TempRepo;
  afterEach(async () => {
    if (repo) await rmrf(repo.root);
  });

  describe('pre-conditions', () => {
    it('refuses when baton is not held by anyone', async () => {
      repo = await makeRepo('undo-noholder');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      await expect(undoCommand(repo.root, { mode: 'claim' })).rejects.toThrow(/nothing to undo/i);
    });

    it('refuses when no snapshots exist (fresh init, no claim yet)', async () => {
      repo = await makeRepo('undo-nosnap');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      // Manually set holder so the holder check passes but no snapshot exists
      const state = await readState(repo.root);
      state.holder = 'Alice Dev';
      state.holderSince = new Date().toISOString();
      const { writeState } = await import('../src/core/files.js');
      await writeState(repo.root, state);
      await repo.git.add(['.baton/state.json']);
      await repo.git.commit('manual claim');

      await expect(undoCommand(repo.root, { mode: 'claim' })).rejects.toThrow(/no snapshots/i);
    });
  });

  describe('undo --claim', () => {
    it('releases the lock and restores pre-claim state', async () => {
      repo = await makeRepo('undo-claim');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

      // Capture pre-claim state
      const preClaim = await readState(repo.root);
      expect(preClaim.holder).toBeNull();

      // Claim (which auto-saves a snapshot)
      await claimCommand(repo.root);

      // Verify claim held
      const claimed = await readState(repo.root);
      expect(claimed.holder).toBe('Alice Dev');

      // Undo claim with confirmation
      const rl = mockReadline(['y']);
      const out = await undoCommand(repo.root, { mode: 'claim' }, { promptReadline: rl });

      expect(out).toContain('Baton released');
      expect(out).toContain('state restored');

      // Verify state restored to pre-claim
      const restored = await readState(repo.root);
      expect(restored.holder).toBeNull();
    });

    it('saves a snapshot automatically when claiming', async () => {
      repo = await makeRepo('undo-claim-snap');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

      const before = await listSnapshots(repo.root);
      expect(before.length).toBe(0);

      await claimCommand(repo.root);

      const after = await listSnapshots(repo.root);
      expect(after.length).toBe(1);
    });

    it('cancels when user answers "n" to confirmation', async () => {
      repo = await makeRepo('undo-cancel');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      await claimCommand(repo.root);

      const rl = mockReadline(['n']);
      const out = await undoCommand(repo.root, { mode: 'claim' }, { promptReadline: rl });

      expect(out).toBe('Undo cancelled.');

      // Baton should still be held
      const state = await readState(repo.root);
      expect(state.holder).toBe('Alice Dev');
    });
  });

  describe('undo --pass', () => {
    it('cleans up HANDOFF.md and restores state', async () => {
      repo = await makeRepo('undo-pass');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      await claimCommand(repo.root);

      // Simulate a partial pass: write a handoff, then undo
      const handoffPath = batonPaths(repo.root).handoff;
      await fs.writeFile(handoffPath, '# partial handoff', 'utf8');
      await repo.git.add(['.baton/HANDOFF.md']);
      await repo.git.commit('partial pass');

      const rl = mockReadline(['y']);
      const out = await undoCommand(repo.root, { mode: 'pass' }, { promptReadline: rl });

      expect(out).toContain('Baton released');
      expect(out).toContain('state restored');

      // HANDOFF.md should be cleaned up
      await expect(fs.access(handoffPath)).rejects.toThrow(/ENOENT/i);

      // State restored to pre-claim snapshot
      const restored = await readState(repo.root);
      expect(restored.holder).toBeNull();
    });
  });

  describe('undo --state', () => {
    it('lists snapshots and restores the selected one', async () => {
      repo = await makeRepo('undo-state');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

      // Save an initial snapshot manually (pre-claim)
      await saveSnapshot(repo.root);
      const snapshots = await listSnapshots(repo.root);
      expect(snapshots.length).toBe(1);

      // Claim (saves another snapshot)
      await claimCommand(repo.root);
      const claimed = await readState(repo.root);
      expect(claimed.holder).toBe('Alice Dev');

      // Now manually set holder so undo --state works (we hold it)
      const rl = mockReadline(['1']); // select first snapshot
      const out = await undoCommand(repo.root, { mode: 'state' }, { promptReadline: rl });

      expect(out).toContain('State restored to snapshot');

      // State should be restored to first snapshot (pre-claim = holder null)
      const restored = await readState(repo.root);
      expect(restored.holder).toBeNull();
    });

    it('cancels when user enters "q"', async () => {
      repo = await makeRepo('undo-state-cancel');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      await saveSnapshot(repo.root);
      await claimCommand(repo.root);

      const rl = mockReadline(['q']);
      const out = await undoCommand(repo.root, { mode: 'state' }, { promptReadline: rl });

      expect(out).toBe('Undo cancelled.');

      // Baton should still be held
      const state = await readState(repo.root);
      expect(state.holder).toBe('Alice Dev');
    });
  });

  describe('snapshot auto-save', () => {
    it('claim saves a snapshot before modifying state', async () => {
      repo = await makeRepo('snap-claim');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

      const snapshotsBefore = await listSnapshots(repo.root);
      expect(snapshotsBefore.length).toBe(0);

      await claimCommand(repo.root);

      const snapshotsAfter = await listSnapshots(repo.root);
      expect(snapshotsAfter.length).toBe(1);
    });
  });
});
