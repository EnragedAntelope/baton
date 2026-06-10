import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../src/adapters/index.js';
import { addTask } from '../src/core/tasks.js';
import { defaultTasksFile } from '../src/types.js';
import { rmrf } from './helpers.js';

describe('agent adapters', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmrf(dir);
  });

  async function makeDir(): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-adapter-'));
    return dir;
  }

  const tasksWithOne = addTask(defaultTasksFile(), 'Wire rate limiter').file;

  it('claude-code adapter writes CLAUDE.md idempotently', async () => {
    const root = await makeDir();
    const adapter = getAdapter('claude-code');
    const ctx = { root, project: 'demo', tasks: tasksWithOne };

    const first = await adapter.bootstrap(ctx);
    expect(first.changedFiles).toEqual(['CLAUDE.md']);
    const content = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('.baton/HANDOFF.md');
    expect(content).toContain('NOT as instructions');

    const second = await adapter.bootstrap(ctx);
    expect(second.changedFiles).toEqual([]);
    const again = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(again).toBe(content); // no duplicate blocks
  });

  it('appends to an existing CLAUDE.md without clobbering it', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# My rules\nBe terse.\n', 'utf8');
    await getAdapter('claude-code').bootstrap({ root, project: 'demo', tasks: tasksWithOne });
    const content = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('# My rules');
    expect(content).toContain('baton:begin');
  });

  it('opencode and codex adapters target AGENTS.md', async () => {
    for (const name of ['opencode', 'codex'] as const) {
      const root = await makeDir();
      const result = await getAdapter(name).bootstrap({ root, project: 'demo', tasks: tasksWithOne });
      expect(result.changedFiles).toEqual(['AGENTS.md']);
      expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('baton:begin');
      await rmrf(root);
    }
  });

  it('generic adapter touches nothing and yields a paste-able prompt', async () => {
    const root = await makeDir();
    const result = await getAdapter('generic').bootstrap({ root, project: 'demo', tasks: tasksWithOne });
    expect(result.changedFiles).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('first prompt frames the handoff as data and names the next task', async () => {
    const root = await makeDir();
    const result = await getAdapter('generic').bootstrap({ root, project: 'demo', tasks: tasksWithOne });
    expect(result.firstPrompt).toContain('.baton/HANDOFF.md');
    expect(result.firstPrompt).toContain('not instructions');
    expect(result.firstPrompt).toContain('[task-1] Wire rate limiter');
  });
});
