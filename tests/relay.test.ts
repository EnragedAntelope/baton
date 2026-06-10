import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCommand } from '../src/commands/claim.js';
import { initCommand } from '../src/commands/init.js';
import { logCommand } from '../src/commands/log.js';
import { passCommand } from '../src/commands/pass.js';
import { pickupCommand } from '../src/commands/pickup.js';
import { stealCommand } from '../src/commands/steal.js';
import { readState, writeConfig, readConfig, writeState } from '../src/core/files.js';
import { handoffTemplate } from '../src/core/handoff.js';
import { defaultTasksFile } from '../src/types.js';
import { makeRelay, rmrf, TempRepo } from './helpers.js';

/** Write a complete, fresh HANDOFF.md as the baton-pass skill would. */
async function writeValidHandoff(root: string, user: string): Promise<void> {
  let content = handoffTemplate({
    user,
    agent: 'generic',
    branch: 'main',
    commit: 'abc1234ef567',
    tasks: defaultTasksFile(),
    timestamp: new Date(Date.now() + 1000), // avoid same-ms ties with lastPass
  });
  content = content.replaceAll(
    '_(fill me in)_',
    'Auth flow implemented; tests green; nothing blocking.',
  );
  await fs.writeFile(path.join(root, '.baton', 'HANDOFF.md'), content, 'utf8');
}

/** Register both relay members in alice's config and push. */
async function registerBob(alice: TempRepo): Promise<void> {
  const config = await readConfig(alice.root);
  config.participants.push({ handle: 'Bob Dev', gitEmails: ['bob@example.com'] });
  await writeConfig(alice.root, config);
  await alice.git.add(['.baton/config.json']);
  await alice.git.commit('baton: add bob');
}

describe('full relay between two machines', () => {
  let origin: string;
  let alice: TempRepo;
  let bob: TempRepo;

  beforeEach(async () => {
    ({ origin, alice, bob } = await makeRelay());
    await initCommand(alice.root, { project: 'relay-demo', handle: 'Alice Dev' });
    await registerBob(alice);
    await alice.git.push('origin', 'main');
    await bob.git.pull('origin', 'main');
  });

  afterEach(async () => {
    await rmrf(alice.root);
    await rmrf(bob.root);
    await rmrf(origin);
  });

  it('relays: alice claims and passes, bob picks up with full context', async () => {
    // Alice claims (pushes init + claim to origin)
    const claimOut = await claimCommand(alice.root);
    expect(claimOut).toContain('claimed by Alice Dev');

    // First pass attempt: handoff not ready → template written, pass refused
    await expect(passCommand(alice.root)).rejects.toThrow(/HANDOFF.md is not ready/);

    // Alice (or her agent) fills the handoff, then passes
    await writeValidHandoff(alice.root, 'Alice Dev');
    const passOut = await passCommand(alice.root);
    expect(passOut).toContain('pass #1');
    expect(passOut).toContain('baton/pass/1');

    const aliceState = await readState(alice.root);
    expect(aliceState.holder).toBeNull();
    expect(aliceState.lastPass?.user).toBe('Alice Dev');

    // Bob picks up on his machine with the claude-code adapter
    const pickupOut = await pickupCommand(bob.root, { agent: 'claude-code' });
    expect(pickupOut).toContain('You have the baton (Bob Dev');
    expect(pickupOut).toContain('Last pass: #1 by Alice Dev');
    expect(pickupOut).toContain('First prompt for your agent');
    expect(pickupOut).toContain('Blockers');

    // Adapter injected the pointer block into CLAUDE.md
    const claudeMd = await fs.readFile(path.join(bob.root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('baton:begin');
    expect(claudeMd).toContain('.baton/HANDOFF.md');

    // Bob now holds the baton — visible from alice's machine after a pull
    await alice.git.pull('origin', 'main');
    const state = await readState(alice.root);
    expect(state.holder).toBe('Bob Dev');

    // And alice can no longer claim
    await expect(claimCommand(alice.root)).rejects.toThrow(/held by Bob Dev/);

    // Chain of custody is visible
    const logOut = await logCommand(alice.root);
    expect(logOut).toContain('baton/pass/1');
    expect(logOut).toContain('pass #1 by Alice Dev');
  });

  it('claim race: the slower claimer loses cleanly and learns who won', async () => {
    // Bob's claim pulls, then alice claims+pushes before bob's push (the race window)
    await expect(
      claimCommand(bob.root, {
        afterSync: async () => {
          await claimCommand(alice.root);
        },
      }),
    ).rejects.toThrow(/while you were claiming/);

    // Bob's repo rolled back cleanly: no claim commit left behind
    const state = await readState(bob.root);
    expect(state.holder).toBe('Alice Dev');
    expect((await bob.git.status()).isClean()).toBe(true);
  });

  it('pass refuses a dirty working tree', async () => {
    await claimCommand(alice.root);
    await fs.writeFile(path.join(alice.root, 'wip.txt'), 'uncommitted', 'utf8');
    await writeValidHandoff(alice.root, 'Alice Dev');
    await expect(passCommand(alice.root)).rejects.toThrow(/uncommitted changes/);
    await fs.rm(path.join(alice.root, 'wip.txt'));
  });

  it('pass refuses without holding the baton', async () => {
    await writeValidHandoff(alice.root, 'Alice Dev');
    await expect(passCommand(alice.root)).rejects.toThrow(/don't hold the baton/);
  });

  it('test gate: failing tests block the pass, --skip-tests is recorded', async () => {
    const config = await readConfig(alice.root);
    config.commands.test = 'node -e "process.exit(1)"';
    await writeConfig(alice.root, config);
    await alice.git.add(['.baton/config.json']);
    await alice.git.commit('set failing test cmd');

    await claimCommand(alice.root);
    await writeValidHandoff(alice.root, 'Alice Dev');
    await expect(passCommand(alice.root)).rejects.toThrow(/Test gate failed/);

    const out = await passCommand(alice.root, { skipTests: true });
    expect(out).toContain('SKIPPED by --skip-tests');
  });

  it('secret gate: a planted AWS key in HANDOFF.md blocks the pass', async () => {
    await claimCommand(alice.root);
    await writeValidHandoff(alice.root, 'Alice Dev');
    const handoffPath = path.join(alice.root, '.baton', 'HANDOFF.md');
    const content = await fs.readFile(handoffPath, 'utf8');
    await fs.writeFile(
      handoffPath,
      content.replace(
        'nothing blocking.',
        'use key AKIAIOSFODNN7REALKEY to test',
      ),
      'utf8',
    );
    await expect(passCommand(alice.root)).rejects.toThrow(/Secret scan found/);
  });

  it('steal: refuses fresh locks, takes stale ones with an audit trail', async () => {
    await claimCommand(alice.root);

    // Fresh lock → refused
    await bob.git.pull('origin', 'main');
    await expect(stealCommand(bob.root)).rejects.toThrow(/Refusing/);

    // Age the lock 24h (threshold 12h) by editing state directly
    const state = await readState(alice.root);
    state.holderSince = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await writeState(alice.root, state);
    await alice.git.add(['.baton/state.json']);
    await alice.git.commit('age the lock (test)');
    await alice.git.push('origin', 'main');

    const out = await stealCommand(bob.root);
    expect(out).toContain('stolen from Alice Dev');

    const decisions = await fs.readFile(
      path.join(bob.root, '.baton', 'decisions.md'),
      'utf8',
    );
    expect(decisions).toContain('stole the baton from **Alice Dev**');
  });

  it('pickup verifies the custody chain and fails on a broken one', async () => {
    await claimCommand(alice.root);
    await writeValidHandoff(alice.root, 'Alice Dev');
    await passCommand(alice.root);

    // Sabotage: delete the pass tag from origin (simulates tampering)
    await alice.git.raw(['push', 'origin', ':refs/tags/baton/pass/1']);
    await alice.git.raw(['tag', '-d', 'baton/pass/1']);

    await expect(pickupCommand(bob.root, { agent: 'generic' })).rejects.toThrow(
      /Custody verification FAILED/,
    );

    // --force proceeds loudly
    const out = await pickupCommand(bob.root, { agent: 'generic', force: true });
    expect(out).toContain('OVERRIDDEN ERROR');
  });
});
