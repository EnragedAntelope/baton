import { describe, expect, it } from 'vitest';
import { claimState, isLockStale, releaseState } from '../src/core/lock.js';
import { handoffTemplate, validateHandoff } from '../src/core/handoff.js';
import { defaultState, defaultTasksFile } from '../src/types.js';
import { scanText } from '../src/security/secrets-scan.js';

describe('lock state machine', () => {
  it('claims a free baton and clears the claimer from the queue', () => {
    const state = { ...defaultState(), queue: ['alice', 'bob'] };
    const claimed = claimState(state, 'alice');
    expect(claimed.holder).toBe('alice');
    expect(claimed.holderSince).toBeTruthy();
    expect(claimed.queue).toEqual(['bob']);
  });

  it('refuses to claim a fresh lock held by someone else', () => {
    const held = claimState(defaultState(), 'alice');
    expect(() => claimState(held, 'bob')).toThrow(/held by alice/);
  });

  it('allows claiming over a stale lock only with steal', () => {
    const now = new Date('2026-06-09T12:00:00Z');
    const old = new Date('2026-06-08T12:00:00Z'); // 24h > 12h threshold
    const held = claimState(defaultState(), 'alice', { now: old });
    expect(isLockStale(held, now)).toBe(true);
    expect(claimState(held, 'bob', { now, steal: true }).holder).toBe('bob');
    // stale locks also yield to a plain claim
    expect(claimState(held, 'bob', { now }).holder).toBe('bob');
  });

  it('refuses to steal a fresh lock', () => {
    const held = claimState(defaultState(), 'alice');
    expect(() => claimState(held, 'bob', { steal: true })).toThrow(/fresh lock/);
  });

  it('release bumps passCount and records the pass', () => {
    const held = claimState(defaultState(), 'alice');
    const now = new Date('2026-06-09T12:00:00Z');
    const released = releaseState(held, 'alice', 'abc1234ef', now);
    expect(released.holder).toBeNull();
    expect(released.passCount).toBe(1);
    expect(released.lastPass).toEqual({
      user: 'alice',
      at: now.toISOString(),
      commit: 'abc1234ef',
    });
  });
});

describe('handoff template & validation', () => {
  const ctx = {
    user: 'alice',
    agent: 'claude-code',
    branch: 'main',
    commit: 'abc1234ef567',
    tasks: defaultTasksFile(),
  };

  it('fresh template fails validation (placeholders present)', () => {
    const result = validateHandoff(handoffTemplate(ctx));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('placeholder'))).toBe(true);
  });

  it('a completed handoff validates', () => {
    let content = handoffTemplate(ctx);
    content = content.replaceAll('_(fill me in)_', 'All good, auth shipped.');
    const result = validateHandoff(content);
    expect(result.ok).toBe(true);
  });

  it('flags missing sections', () => {
    const result = validateHandoff('# Handoff — 2026-06-09 — from alice\n\n## Where things stand\nok\n');
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain('Done this session');
  });
});

describe('secret scanner', () => {
  it('detects common credentials', () => {
    // Fake keys are assembled by concatenation so no realistic secret literal
    // ever exists in this repo's blobs (GitHub push protection scans them).
    const samples = [
      'key = ' + 'AKIA' + 'IOSFODNN7REALKEY',
      'token: ' + 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901',
      'anthropic ' + 'sk-ant-' + 'api03-aaaaaaaaaaaaaaaaaaaaaaaa',
      '-----BEGIN RSA ' + 'PRIVATE KEY-----',
      'stripe ' + 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc',
      `"password": ` + `"hunter2hunter2hunter2"`,
    ];
    for (const sample of samples) {
      expect(scanText(sample, 'HANDOFF.md').length, sample).toBeGreaterThan(0);
    }
  });

  it('allows name-only references, placeholders, and env-var syntax', () => {
    const samples = [
      'Set STRIPE_TEST_KEY in your own .env',
      'export AWS_KEY=$AWS_ACCESS_KEY_ID',
      'api_key = "<YOUR_KEY_HERE>"',
      'token: "{{ vault.github_token }}"',
      'password = "example-placeholder"',
    ];
    for (const sample of samples) {
      expect(scanText(sample, 'HANDOFF.md'), sample).toEqual([]);
    }
  });

  it('never includes the full secret in findings output', () => {
    const secret = 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901';
    const findings = scanText(`token: ${secret}`, 'HANDOFF.md');
    expect(findings[0]?.preview).not.toContain(secret);
  });
});
