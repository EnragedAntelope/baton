import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { batonPaths } from '../src/core/files.js';
import { makeRepo, rmrf, TempRepo } from './helpers.js';

describe('baton doctor', () => {
  let repo: TempRepo;
  afterEach(async () => {
    if (repo) await rmrf(repo.root);
  });

  it('outputs a table with at least 7 checks for a healthy project', async () => {
    repo = await makeRepo('doctor-healthy');
    await repo.git.addRemote('origin', 'https://github.com/example/test.git');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

    const out = await doctorCommand(repo.root);
    const lines = out.split('\n');

    // Verify key check names appear
    expect(out).toContain('Node.js version');
    expect(out).toContain('Git repo');
    expect(out).toContain('Git remote');
    expect(out).toContain('Git identity');
    expect(out).toContain('.baton/ directory');
    expect(out).toContain('state.json');
    expect(out).toContain('tasks.json');
    expect(out).toContain('config.json');
    expect(out).toContain('Agent detected');
    expect(out).toContain('Pre-commit hook');

    // At least 7 checks (we have 10 now)
    const statusCount = lines.filter(l => l.includes('PASS') || l.includes('WARN')).length;
    expect(statusCount).toBeGreaterThanOrEqual(7);

    // Should say PASS (healthy) — no FAIL will appear
    expect(out).toContain('Result: PASS');

    // Doctor is read-only — should not modify any files
    const state = await fs.readFile(batonPaths(repo.root).state, 'utf8');
    expect(state).toContain('"holder"');
  });

  it('doctor exits with FAIL on corrupted state.json', async () => {
    repo = await makeRepo('doctor-corrupt');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

    // Corrupt state.json
    const statePath = batonPaths(repo.root).state;
    await fs.writeFile(statePath, 'not valid json {{{', 'utf8');

    const out = await doctorCommand(repo.root);
    expect(out).toContain('Result: FAIL');
    expect(out).toContain('state.json');
    expect(out).toMatch(/FAIL.*state/);
  });

  it('doctor reports FAIL when not in a git repo', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'baton-nogit-'));
    try {
      const out = await doctorCommand(dir);
      expect(out).toContain('Result: FAIL');
      expect(out).toContain('Not inside a git repository');
    } finally {
      await rmrf(dir);
    }
  });

  it('doctor shows WARN when no origin remote', async () => {
    repo = await makeRepo('doctor-noremote');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

    const out = await doctorCommand(repo.root);
    expect(out).toContain('WARN');
    expect(out).toContain('No origin remote');
  });

  it('doctor shows PASS when all checks healthy', async () => {
    repo = await makeRepo('doctor-allpass');
    await repo.git.addRemote('origin', 'https://github.com/example/test.git');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });

    const out = await doctorCommand(repo.root);
    // With origin, node >= 20, and proper init, all mandatory checks pass
    expect(out).toContain('Result: PASS');
    expect(out).not.toContain('FAIL');
  });
});
