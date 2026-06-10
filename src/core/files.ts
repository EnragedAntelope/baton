import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  Config,
  ConfigSchema,
  State,
  StateSchema,
  TasksFile,
  TasksFileSchema,
} from '../types.js';

export const BATON_DIR = '.baton';

export function batonPaths(repoRoot: string) {
  const dir = path.join(repoRoot, BATON_DIR);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    tasks: path.join(dir, 'tasks.json'),
    config: path.join(dir, 'config.json'),
    handoff: path.join(dir, 'HANDOFF.md'),
    project: path.join(dir, 'project.md'),
    decisions: path.join(dir, 'decisions.md'),
    sessions: path.join(dir, 'sessions'),
  };
}

export class BatonError extends Error {}

async function readValidatedJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BatonError(
        `${path.basename(filePath)} not found — is this a Baton repo? Run "baton init" first.`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BatonError(`${path.basename(filePath)} is not valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new BatonError(
      `${path.basename(filePath)} failed schema validation:\n${issues}`,
    );
  }
  return result.data;
}

async function writeValidatedJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  const validated = schema.parse(value); // refuse to write invalid state
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

export const readState = (root: string): Promise<State> =>
  readValidatedJson(batonPaths(root).state, StateSchema);
export const writeState = (root: string, state: State): Promise<void> =>
  writeValidatedJson(batonPaths(root).state, StateSchema, state);

export const readTasks = (root: string): Promise<TasksFile> =>
  readValidatedJson(batonPaths(root).tasks, TasksFileSchema);
export const writeTasks = (root: string, tasks: TasksFile): Promise<void> =>
  writeValidatedJson(batonPaths(root).tasks, TasksFileSchema, tasks);

export const readConfig = (root: string): Promise<Config> =>
  readValidatedJson(batonPaths(root).config, ConfigSchema);
export const writeConfig = (root: string, config: Config): Promise<void> =>
  writeValidatedJson(batonPaths(root).config, ConfigSchema, config);

export async function batonInitialized(root: string): Promise<boolean> {
  try {
    await fs.access(batonPaths(root).state);
    return true;
  } catch {
    return false;
  }
}
