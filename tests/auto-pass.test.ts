import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimCommand } from '../src/commands/claim.js';
import { initCommand } from '../src/commands/init.js';
import {
  buildAgentCommand,
  detectAgentSession,
  } from '../src/core/agent-invoke.js';
import { passCommand } from '../src/commands/pass.js';
import { BatonError } from '../src/core/files.js';
import { makeRepo, rmrf, TempRepo } from './helpers.js';

const noSession = () => null;

describe('baton pass --auto (headless agent fill)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await makeRepo('auto');
    await initCommand(repo.root, { project: 'auto-demo', agent: 'claude-code', testCmd: 'node -e "process.exit(0)"' });
    await claimCommand(repo.root);
  });

  afterEach(async () => {
    await rmrf(repo.root);
  });

  it('completes the pass when the agent fills the template', async () => {
    const prompts: string[] = [];
    const out = await passCommand(
      repo.root,
      { auto: true },
      {
        detectSession: noSession,
        invoke: async (cmd, prompt) => {
          prompts.push(prompt);
          // Simulate the agent: replace placeholders, keep the header.
          const handoffPath = path.join(repo.root, '.baton', 'HANDOFF.md');
          const template = await fs.readFile(handoffPath, 'utf8');
          await fs.writeFile(
            handoffPath,
            template.replaceAll('_(fill me in)_', 'Filled by headless agent.'),
            'utf8',
          );
          return { ok: true, detail: 'done' };
        },
      },
    );
    expect(out).toContain('pass #1');
    expect(out).toContain('filled headlessly by claude-code');
    // The prompt enforces the security rules
    expect(prompts[0]).toContain('NEVER write a secret value');
    expect(prompts[0]).toContain('ONLY files inside .baton/');
  });

  it('fails clearly when the agent leaves placeholders', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true },
        {
          detectSession: noSession,
          invoke: async () => ({ ok: true, detail: 'did nothing' }),
        },
      ),
    ).rejects.toThrow(/placeholder/);
  });

  it('falls back with instructions when the agent CLI is missing', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true },
        {
          detectSession: noSession,
          invoke: async () => ({ ok: false, detail: 'could not start "claude"' }),
        },
      ),
    ).rejects.toThrow(/agent invocation failed[\s\S]*Fill it in/);
  });

  it('refuses --auto for the generic agent', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true, agent: 'generic' },
        { detectSession: noSession },
      ),
    ).rejects.toThrow(/no headless command known/);
  });

  it('refuses --auto from inside an agent session', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true },
        { detectSession: () => 'claude-code' },
      ),
    ).rejects.toThrow(/inside of a claude-code session/);
  });

  it('surfaces timeout from agent invocation', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true, autoTimeout: 5 },
        {
          detectSession: noSession,
          invoke: async () => {
            // Simulate the real invokeAgent timing out
            throw new BatonError('Agent invocation timed out after 5 seconds');
          },
        },
      ),
    ).rejects.toThrow(/timed out after 5 seconds/);
  });

  it('rejects when agent returns invalid output', async () => {
    await expect(
      passCommand(
        repo.root,
        { auto: true },
        {
          detectSession: noSession,
          invoke: async () => {
            // Simulate invokeAgent detecting non-text/garbage output
            return { ok: false, detail: 'Agent returned invalid output (non-text or binary garbage)' };
          },
        },
      ),
    ).rejects.toThrow(/invalid output/);
  });
});

describe('agent command mapping', () => {
  it('maps each agent to a fixed-argument headless command', () => {
    expect(buildAgentCommand('claude-code')).toEqual({
      command: 'claude',
      args: ['-p', '--permission-mode', 'acceptEdits'],
    });
    expect(buildAgentCommand('opencode')).toEqual({
      command: 'opencode',
      args: ['run'],
    });
    expect(buildAgentCommand('codex')?.command).toBe('codex');
    expect(buildAgentCommand('generic')).toBeNull();
  });

  it('detects agent sessions from environment markers', () => {
    expect(detectAgentSession({})).toBeNull();
    expect(detectAgentSession({ CLAUDECODE: '1' })).toBe('claude-code');
    expect(detectAgentSession({ OPENCODE: '1' })).toBe('opencode');
    expect(detectAgentSession({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
  });
});
