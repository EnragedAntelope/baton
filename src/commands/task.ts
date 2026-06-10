import { readTasks, writeTasks } from '../core/files.js';
import { addTask, setTaskStatus } from '../core/tasks.js';
import { TaskStatusSchema } from '../types.js';
import { loadContext } from './context.js';

export async function taskListCommand(cwd: string): Promise<string> {
  const ctx = await loadContext(cwd);
  if (ctx.tasks.tasks.length === 0) {
    return 'No tasks yet. Add one: baton task add "title"';
  }
  return ctx.tasks.tasks
    .map(
      (t) =>
        `[${t.id}] ${t.status.padEnd(11)} ${t.title}${t.deps.length ? `  (deps: ${t.deps.join(', ')})` : ''}`,
    )
    .join('\n');
}

export async function taskAddCommand(
  cwd: string,
  title: string,
  deps: string[],
): Promise<string> {
  const ctx = await loadContext(cwd);
  const current = await readTasks(ctx.root);
  const { file, task } = addTask(current, title, deps);
  await writeTasks(ctx.root, file);
  return `Added [${task.id}] ${task.title}`;
}

export async function taskSetCommand(
  cwd: string,
  id: string,
  status: string,
): Promise<string> {
  const ctx = await loadContext(cwd);
  const parsed = TaskStatusSchema.parse(status);
  const current = await readTasks(ctx.root);
  await writeTasks(ctx.root, setTaskStatus(current, id, parsed));
  return `[${id}] → ${parsed}`;
}
