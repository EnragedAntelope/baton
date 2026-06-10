import { describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  StateSchema,
  TasksFileSchema,
  defaultConfig,
  defaultState,
  defaultTasksFile,
} from '../src/types.js';

describe('state.json schema', () => {
  it('round-trips a fully populated state', () => {
    const state = {
      schema: 1,
      holder: 'alice',
      holderSince: '2026-06-09T14:30:00.000Z',
      lastPass: {
        user: 'bob',
        at: '2026-06-08T20:00:00.000Z',
        commit: 'a1b2c3d4e5f',
      },
      passCount: 4,
      queue: ['carol'],
      policy: {
        staleLockHours: 12,
        requireCleanTests: true,
        requireSecretScan: true,
      },
    };
    const parsed = StateSchema.parse(state);
    expect(StateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('applies defaults for a fresh state', () => {
    const state = defaultState();
    expect(state.holder).toBeNull();
    expect(state.passCount).toBe(0);
    expect(state.queue).toEqual([]);
    expect(state.policy.staleLockHours).toBe(12);
    expect(state.policy.requireCleanTests).toBe(true);
    expect(state.policy.requireSecretScan).toBe(true);
  });

  it('rejects unknown keys and bad schema versions', () => {
    expect(() => StateSchema.parse({ ...defaultState(), extra: 1 })).toThrow();
    expect(() => StateSchema.parse({ ...defaultState(), schema: 2 })).toThrow();
  });
});

describe('tasks.json schema', () => {
  it('round-trips a task ledger', () => {
    const now = '2026-06-09T14:30:00.000Z';
    const file = {
      schema: 1,
      nextId: 3,
      tasks: [
        {
          id: 'task-1',
          title: 'Implement auth',
          status: 'done',
          deps: [],
          owner: 'alice',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'task-2',
          title: 'Rate limiting',
          status: 'in-progress',
          deps: ['task-1'],
          notes: 'see HANDOFF.md',
          owner: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const parsed = TasksFileSchema.parse(file);
    expect(TasksFileSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it('rejects duplicate ids and unknown dependencies', () => {
    const now = '2026-06-09T14:30:00.000Z';
    const base = {
      id: 'task-1',
      title: 'x',
      status: 'todo',
      deps: [],
      owner: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(() =>
      TasksFileSchema.parse({ schema: 1, nextId: 2, tasks: [base, base] }),
    ).toThrow(/duplicate/);
    expect(() =>
      TasksFileSchema.parse({
        schema: 1,
        nextId: 2,
        tasks: [{ ...base, deps: ['task-99'] }],
      }),
    ).toThrow(/unknown task/);
  });

  it('rejects malformed task ids', () => {
    expect(() =>
      TasksFileSchema.parse({
        schema: 1,
        nextId: 1,
        tasks: [
          {
            id: 'TASK_1',
            title: 'x',
            status: 'todo',
            deps: [],
            owner: null,
            createdAt: '2026-06-09T14:30:00.000Z',
            updatedAt: '2026-06-09T14:30:00.000Z',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('config.json schema', () => {
  it('round-trips a config', () => {
    const config = {
      schema: 1,
      project: 'demo',
      participants: [
        { handle: 'alice', gitEmails: ['alice@example.com'], agent: 'claude-code' },
        { handle: 'bob', gitEmails: ['bob@example.com', 'bob@work.com'] },
      ],
      defaultAgent: 'generic',
      commands: { test: 'npm test', lint: 'npm run lint' },
    };
    const parsed = ConfigSchema.parse(config);
    expect(ConfigSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it('defaults to the generic agent and empty participants', () => {
    const config = defaultConfig('demo');
    expect(config.defaultAgent).toBe('generic');
    expect(config.participants).toEqual([]);
  });

  it('rejects unknown agents and invalid emails', () => {
    expect(() =>
      ConfigSchema.parse({ ...defaultConfig('x'), defaultAgent: 'cursor' }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        ...defaultConfig('x'),
        participants: [{ handle: 'a', gitEmails: ['not-an-email'] }],
      }),
    ).toThrow();
  });
});

describe('defaults round-trip through JSON', () => {
  it('all default factories survive serialize/parse', () => {
    expect(StateSchema.parse(JSON.parse(JSON.stringify(defaultState())))).toEqual(
      defaultState(),
    );
    expect(
      TasksFileSchema.parse(JSON.parse(JSON.stringify(defaultTasksFile()))),
    ).toEqual(defaultTasksFile());
    expect(
      ConfigSchema.parse(JSON.parse(JSON.stringify(defaultConfig('p')))),
    ).toEqual(defaultConfig('p'));
  });
});
