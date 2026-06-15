import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCommand } from '../src/commands/claim.js';
import { initCommand } from '../src/commands/init.js';
import { passCommand } from '../src/commands/pass.js';
import { readConfig, writeConfig } from '../src/core/files.js';
import { handoffTemplate } from '../src/core/handoff.js';
import { defaultTasksFile } from '../src/types.js';
import { makeRelay, rmrf, TempRepo } from './helpers.js';

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

/** Register a participant in the config so the user is a known relay member. */
async function registerSelf(handle: string, email: string, repo: TempRepo): Promise<void> {
  const config = await readConfig(repo.root);
  config.participants.push({ handle, gitEmails: [email] });
  await writeConfig(repo.root, config);
  await repo.git.add(['.baton/config.json']);
  await repo.git.commit('baton: add self');
}

describe('pass --interactive', () => {
  let origin: string;
  let alice: TempRepo;

  beforeEach(async () => {
    ({ origin, alice } = await makeRelay());
    await initCommand(alice.root, { project: 'interactive-demo', handle: 'Alice Dev', testCmd: 'node -e "process.exit(0)"' });
    await registerSelf('Alice Dev', 'alice@example.com', alice);
    await alice.git.push('origin', 'main');
  });

  afterEach(async () => {
    await rmrf(alice.root);
    await rmrf(origin);
  });

  it('builds HANDOFF.md from five prompt answers and completes the pass', async () => {
    await claimCommand(alice.root);

    const answers = [
      'Implement user login flow',
      'Chose JWT auth over sessions; created User model and auth middleware',
      'Rate limiting not yet implemented',
      'Tried Passport.js but it was too heavy for our needs',
      'All tests pass, coverage at 85%',
    ];
    const rl = mockReadline(answers);

    const out = await passCommand(
      alice.root,
      { interactive: true },
      { promptReadline: rl },
    );

    expect(out).toContain('pass #1');
    expect(out).toContain('baton/pass/1');

    const handoffPath = path.join(alice.root, '.baton', 'HANDOFF.md');
    const content = await fs.readFile(handoffPath, 'utf8');

    expect(content).toContain('# Handoff —');
    expect(content).toContain('from Alice Dev');

    // Answers mapped to correct sections
    expect(content).toContain('## Where things stand');
    expect(content).toContain('Implement user login flow');
    expect(content).toContain('## Done this session');
    expect(content).toContain('Chose JWT auth over sessions; created User model and auth middleware');
    expect(content).toContain('## Blockers & landmines');
    expect(content).toContain('Rate limiting not yet implemented');
    expect(content).toContain('Tried Passport.js but it was too heavy for our needs');
    expect(content).toContain('## Branch & build state');
    expect(content).toContain('All tests pass, coverage at 85%');

    // Template must be valid (no placeholders)
    expect(content).not.toContain('_(fill me in)_');
  });

  it('uses previous Where things stand as default for the first prompt', async () => {
    await claimCommand(alice.root);

    // Write a previous HANDOFF.md so the default gets extracted
    const prevContent = handoffTemplate({
      user: 'Alice Dev',
      agent: 'generic',
      branch: 'main',
      commit: 'abc1234ef567',
      tasks: defaultTasksFile(),
      timestamp: new Date(Date.now() + 1000),
    }).replaceAll('_(fill me in)_', 'Previous goal: building auth module');

    const handoffPath = path.join(alice.root, '.baton', 'HANDOFF.md');
    await fs.writeFile(handoffPath, prevContent, 'utf8');

    // Pass interactively — first answer is empty, so the default should be used
    const answers = [
      '', // empty → uses default "Previous goal: building auth module"
      'Fixed password reset flow',
      'None',
      'None',
      'Tests green',
    ];
    const rl = mockReadline(answers);

    const out = await passCommand(
      alice.root,
      { interactive: true },
      { promptReadline: rl },
    );

    expect(out).toContain('pass #1');

    const content = await fs.readFile(handoffPath, 'utf8');
    expect(content).toContain('Previous goal: building auth module');
    expect(content).toContain('Fixed password reset flow');
  });

  it('rejects pass when answers produce an empty handoff section', async () => {
    await claimCommand(alice.root);

    // All answers empty → HANDOFF.md sections will be empty → validation fails
    const answers = ['', '', '', '', ''];
    const rl = mockReadline(answers);

    await expect(
      passCommand(alice.root, { interactive: true }, { promptReadline: rl }),
    ).rejects.toThrow(/HANDOFF.md is incomplete/);
  });

  it('non-interactive pass still works after interactive pass', async () => {
    // Alice passes interactively
    await claimCommand(alice.root);

    const answers = [
      'Built the relay core',
      'Wired up all commands',
      'None',
      'None',
      'All green',
    ];
    let out = await passCommand(
      alice.root,
      { interactive: true },
      { promptReadline: mockReadline(answers) },
    );
    expect(out).toContain('pass #1');

    // Bob picks up and does a non-interactive pass (the normal flow)
    // Simulate this by re-claiming (the state was released) and passing normally
    const { bob } = await makeRelay();
    // Actually we need bob to be part of the same relay... let's test on alice instead.
    // After pass #1, alice no longer holds it. A second `claim` should work.
    // But passCommand checks claim. Let me simplify: test that --interactive=false works via the default.
    
    // Re-claim, write a fresh handoff, pass non-interactively
    await alice.git.pull('origin', 'main', ['--tags']);
    await claimCommand(alice.root);

    const handoffPath = path.join(alice.root, '.baton', 'HANDOFF.md');
    const freshContent = handoffTemplate({
      user: 'Alice Dev',
      agent: 'generic',
      branch: 'main',
      commit: 'abc1234ef567',
      tasks: defaultTasksFile(),
      timestamp: new Date(Date.now() + 1000),
    }).replaceAll('_(fill me in)_', 'Continuing relay work');
    await fs.writeFile(handoffPath, freshContent, 'utf8');

    out = await passCommand(alice.root);
    expect(out).toContain('pass #2');
    expect(out).toContain('baton/pass/2');
  });
});
