import { z } from 'zod';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// state.json — who holds the baton, the pass chain, and relay policy
// ---------------------------------------------------------------------------

export const PolicySchema = z
  .object({
    staleLockHours: z.number().positive().default(12),
    requireCleanTests: z.boolean().default(true),
    requireSecretScan: z.boolean().default(true),
  })
  .strict();

export const LastPassSchema = z
  .object({
    user: z.string().min(1),
    at: z.string().datetime(),
    commit: z.string().min(7),
  })
  .strict();

export const StateSchema = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    holder: z.string().min(1).nullable(),
    holderSince: z.string().datetime().nullable(),
    lastPass: LastPassSchema.nullable(),
    passCount: z.number().int().nonnegative().default(0),
    queue: z.array(z.string().min(1)).default([]),
    policy: PolicySchema.default({}),
  })
  .strict();

export type State = z.infer<typeof StateSchema>;
export type Policy = z.infer<typeof PolicySchema>;

export function defaultState(): State {
  return StateSchema.parse({
    schema: SCHEMA_VERSION,
    holder: null,
    holderSince: null,
    lastPass: null,
  });
}

// ---------------------------------------------------------------------------
// tasks.json — the machine-readable task ledger
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
  'todo',
  'in-progress',
  'blocked',
  'done',
  'dropped',
]);

export const TaskSchema = z
  .object({
    id: z.string().regex(/^task-\d+$/, 'task ids look like "task-7"'),
    title: z.string().min(1),
    status: TaskStatusSchema,
    deps: z.array(z.string().regex(/^task-\d+$/)).default([]),
    notes: z.string().optional(),
    owner: z.string().nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const TasksFileSchema = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    nextId: z.number().int().positive().default(1),
    tasks: z.array(TaskSchema).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const task of file.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate task id: ${task.id}`,
        });
      }
      ids.add(task.id);
    }
    for (const task of file.tasks) {
      for (const dep of task.deps) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `task ${task.id} depends on unknown task ${dep}`,
          });
        }
      }
    }
  });

export type Task = z.infer<typeof TaskSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TasksFile = z.infer<typeof TasksFileSchema>;

export function defaultTasksFile(): TasksFile {
  return TasksFileSchema.parse({ schema: SCHEMA_VERSION });
}

// ---------------------------------------------------------------------------
// config.json — participants, agent adapters, project commands
// ---------------------------------------------------------------------------

export const AgentNameSchema = z.enum([
'claude-code',
'opencode',
  'codex',
  'gemini',
  'antigravity',
'generic',
]);

export const ParticipantSchema = z
  .object({
    handle: z.string().min(1),
    gitEmails: z.array(z.string().email()).min(1),
    agent: AgentNameSchema.optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    project: z.string().min(1),
    participants: z.array(ParticipantSchema).default([]),
    defaultAgent: AgentNameSchema.default('generic'),
    // Machine-readable commands for policy gates; echoed for humans in project.md.
    commands: z
      .object({
        test: z.string().optional(),
        lint: z.string().optional(),
        build: z.string().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type AgentName = z.infer<typeof AgentNameSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;

export function defaultConfig(project: string): Config {
  return ConfigSchema.parse({ schema: SCHEMA_VERSION, project });
}
