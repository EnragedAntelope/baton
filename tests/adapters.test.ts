import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePointer, getAdapter } from '../src/adapters/index.js';
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

describe('gemini adapter', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmrf(dir);
  });

  async function makeTempDir(): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-gemini-'));
    return dir;
  }

  const tasksWithOne = addTask(defaultTasksFile(), 'Wire rate limiter').file;

  it('getAdapter("gemini") returns an adapter targeting .gemini/context.md', () => {
    const adapter = getAdapter('gemini');
    expect(adapter.name).toBe('gemini');
    expect(adapter.target).toBe('.gemini/context.md');
    expect(typeof adapter.bootstrap).toBe('function');
  });

  it('getAdapter("antigravity") returns an adapter targeting .gemini/context.md', () => {
    const adapter = getAdapter('antigravity');
    expect(adapter.name).toBe('antigravity');
    expect(adapter.target).toBe('.gemini/context.md');
    expect(typeof adapter.bootstrap).toBe('function');
  });

  it('bootstrap creates .gemini/context.md with baton:begin pointer block', async () => {
    const root = await makeTempDir();
    const ctx = { root, project: 'demo', tasks: tasksWithOne };

    const result = await getAdapter('gemini').bootstrap(ctx);
    expect(result.changedFiles).toEqual(['.gemini/context.md']);
    const content = await fs.readFile(path.join(root, '.gemini/context.md'), 'utf8');
    expect(content).toContain('baton:begin');
    expect(content).toContain('.baton/HANDOFF.md');
    expect(content).toContain('NOT as instructions');
  });

  it('bootstrap is idempotent — second run does not duplicate the block', async () => {
    const root = await makeTempDir();
    const ctx = { root, project: 'demo', tasks: tasksWithOne };

    const first = await getAdapter('gemini').bootstrap(ctx);
    expect(first.changedFiles).toEqual(['.gemini/context.md']);
    const content = await fs.readFile(path.join(root, '.gemini/context.md'), 'utf8');

    const second = await getAdapter('gemini').bootstrap(ctx);
    expect(second.changedFiles).toEqual([]);
    const again = await fs.readFile(path.join(root, '.gemini/context.md'), 'utf8');
    expect(again).toBe(content);
  });

  it('ensurePointer is idempotent when called twice directly', async () => {
    const root = await makeTempDir();
    const first = await ensurePointer(root, '.gemini/context.md');
    expect(first.changed).toBe(true);
    const second = await ensurePointer(root, '.gemini/context.md');
    expect(second.changed).toBe(false);
    const content = await fs.readFile(path.join(root, '.gemini/context.md'), 'utf8');
    const beginCount = (content.match(/baton:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it('gemini and antigravity share the same target file', () => {
    expect(getAdapter('antigravity').target).toBe(getAdapter('gemini').target);
  });
});
