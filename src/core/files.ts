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
    snapshots: path.join(dir, '.snapshots'),
  };
}

export class BatonError extends Error {}

async function readValidatedJson<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S>> {
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

async function writeValidatedJson<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
  value: z.output<S>,
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

function formatTimestamp(date: Date): string {
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return (
    p(date.getFullYear(), 4) +
    p(date.getMonth() + 1, 2) +
    p(date.getDate(), 2) +
    p(date.getHours(), 2) +
    p(date.getMinutes(), 2) +
    p(date.getSeconds(), 2) +
    p(date.getMilliseconds(), 3)
  );
}

function parseTimestamp(ts: string): Date | null {
  if (!/^\d{17}$/.test(ts)) return null;
  const y = Number(ts.slice(0, 4));
  const m = Number(ts.slice(4, 6)) - 1;
  const d = Number(ts.slice(6, 8));
  const h = Number(ts.slice(8, 10));
  const mi = Number(ts.slice(10, 12));
  const s = Number(ts.slice(12, 14));
  const ms = Number(ts.slice(14, 17));
  const date = new Date(y, m, d, h, mi, s, ms);
  return isNaN(date.getTime()) ? null : date;
}

const SNAPSHOT_RE = /^state-(\d{17})\.json$/;

export async function saveSnapshot(root: string): Promise<string> {
  const paths = batonPaths(root);
  await fs.mkdir(paths.snapshots, { recursive: true });
  const stateRaw = await fs.readFile(paths.state, 'utf8');
  const ts = formatTimestamp(new Date());
  const finalPath = path.join(paths.snapshots, `state-${ts}.json`);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, stateRaw, 'utf8');
  await fs.rename(tmpPath, finalPath);
  return ts;
}

export async function restoreSnapshot(
  root: string,
  timestamp?: string,
): Promise<void> {
  const paths = batonPaths(root);
  let targetTs = timestamp;

  if (!targetTs) {
    const snapshots = await listSnapshots(root);
    if (snapshots.length === 0) {
      throw new BatonError('No snapshots found to restore.');
    }
    targetTs = snapshots[snapshots.length - 1];
  }

  const snapPath = path.join(paths.snapshots, `state-${targetTs}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(snapPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BatonError(`Snapshot ${targetTs} not found.`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BatonError(`Snapshot ${targetTs} is not valid JSON.`);
  }

  const result = StateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new BatonError(
      `Snapshot ${targetTs} failed schema validation:\n${issues}`,
    );
  }

  await writeState(root, result.data);
}

export async function listSnapshots(root: string): Promise<string[]> {
  const paths = batonPaths(root);
  let entries: string[];
  try {
    entries = await fs.readdir(paths.snapshots);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const timestamps: string[] = [];
  for (const entry of entries) {
    const match = entry.match(SNAPSHOT_RE);
    if (match && match[1]) timestamps.push(match[1]);
  }
  return timestamps.sort();
}
