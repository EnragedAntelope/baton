import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { statusCommand } from '../src/commands/status.js';
import { taskAddCommand, taskListCommand, taskSetCommand } from '../src/commands/task.js';
import { readConfig, readState, readTasks } from '../src/core/files.js';
import { exists, makeRepo, rmrf, TempRepo } from './helpers.js';

describe('baton init', () => {
  let repo: TempRepo;
  afterEach(async () => {
    if (repo) await rmrf(repo.root);
  });

  it('scaffolds .baton/, seeds .gitignore, installs hook, and commits', async () => {
    repo = await makeRepo('init');
    const out = await initCommand(repo.root, { testCmd: 'npm test' });
    expect(out).toContain('Initialized .baton/');

    // All scaffold files exist and validate against their schemas
    const state = await readState(repo.root);
    expect(state.holder).toBeNull();
    const config = await readConfig(repo.root);
    expect(config.participants).toEqual([
      { handle: 'Alice Dev', gitEmails: ['alice@example.com'] },
    ]);
    expect(config.commands.test).toBe('npm test');
    const tasks = await readTasks(repo.root);
    expect(tasks.tasks).toEqual([]);

    for (const f of ['HANDOFF.md', 'project.md', 'decisions.md', 'hooks/pre-commit.mjs']) {
      expect(await exists(path.join(repo.root, '.baton', f)), f).toBe(true);
    }

    // .gitignore seeded with env patterns
    const gitignore = await fs.readFile(path.join(repo.root, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\.env$/m);

    // Hook shim installed
    expect(await exists(path.join(repo.root, '.git', 'hooks', 'pre-commit'))).toBe(true);

    // Init commit created and tree clean
    const log = await repo.git.log();
    expect(log.latest?.message).toBe('baton: init relay');
    expect((await repo.git.status()).isClean()).toBe(true);
  });

  it('refuses to re-init', async () => {
    repo = await makeRepo('reinit');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
    await expect(initCommand(repo.root, {})).rejects.toThrow(/already exists/);
  });

  it('errors outside a git repo', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'baton-nogit-'));
    try {
      await expect(initCommand(dir, {})).rejects.toThrow(/git/i);
    } finally {
      await rmrf(dir);
    }
  });

  it('the installed pre-commit hook blocks a staged secret in .baton/', async () => {
    repo = await makeRepo('hook');
    await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
    const secretFile = path.join(repo.root, '.baton', 'HANDOFF.md');
    await fs.writeFile(
      secretFile,
      '# Handoff\nUse key AKIAIOSFODNN7REALKEY when testing\n',
      'utf8',
    );
    await repo.git.add(['.baton/HANDOFF.md']);
    await expect(repo.git.commit('leak attempt')).rejects.toThrow(/secret|pre-commit/i);

    // A clean change passes
    await fs.writeFile(secretFile, '# Handoff\nSet AWS_KEY in your own .env\n', 'utf8');
    await repo.git.add(['.baton/HANDOFF.md']);
    await repo.git.commit('clean change');
  });
});

describe('baton status & task', () => {
  let repo: TempRepo;
  afterEach(async () => {
    if (repo) await rmrf(repo.root);
  });

  it('shows holder, branch, and task summary', async () => {
    repo = await makeRepo('status');
    await initCommand(repo.root, { project: 'demo', testCmd: 'node -e "process.exit(0)"' });
    await taskAddCommand(repo.root, 'Build auth', []);
    await taskAddCommand(repo.root, 'Rate limiting', ['task-1']);
    await taskSetCommand(repo.root, 'task-1', 'in-progress');

    const out = await statusCommand(repo.root);
    expect(out).toContain('demo');
    expect(out).toContain('baton is free');
    expect(out).toContain('main @');
    expect(out).toMatch(/1 todo/);
    expect(out).toMatch(/1 in-progress/);
    expect(out).toContain('[task-1] Build auth');

    const list = await taskListCommand(repo.root);
    expect(list).toContain('[task-2]');
    expect(list).toContain('deps: task-1');
  });

  it('errors before init', async () => {
    repo = await makeRepo('noinit');
    await expect(statusCommand(repo.root)).rejects.toThrow(/baton init/);
  });
});
