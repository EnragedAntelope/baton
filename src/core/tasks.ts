import { Task, TaskStatus, TasksFile } from '../types.js';
import { BatonError } from './files.js';

export function addTask(
  file: TasksFile,
  title: string,
  deps: string[] = [],
  now: Date = new Date(),
): { file: TasksFile; task: Task } {
  const known = new Set(file.tasks.map((t) => t.id));
  for (const dep of deps) {
    if (!known.has(dep)) {
      throw new BatonError(`Unknown dependency: ${dep}`);
    }
  }
  const iso = now.toISOString();
  const task: Task = {
    id: `task-${file.nextId}`,
    title,
    status: 'todo',
    deps,
    owner: null,
    createdAt: iso,
    updatedAt: iso,
  };
  return {
    file: { ...file, nextId: file.nextId + 1, tasks: [...file.tasks, task] },
    task,
  };
}

export function setTaskStatus(
  file: TasksFile,
  id: string,
  status: TaskStatus,
  now: Date = new Date(),
): TasksFile {
  const task = file.tasks.find((t) => t.id === id);
  if (!task) {
    throw new BatonError(
      `No such task: ${id}. Run "baton task list" to see ids.`,
    );
  }
  return {
    ...file,
    tasks: file.tasks.map((t) =>
      t.id === id ? { ...t, status, updatedAt: now.toISOString() } : t,
    ),
  };
}

export function openTasks(file: TasksFile): Task[] {
  return file.tasks.filter(
    (t) => t.status === 'todo' || t.status === 'in-progress' || t.status === 'blocked',
  );
}

export function taskSummary(file: TasksFile): string {
  const counts = new Map<string, number>();
  for (const t of file.tasks) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  if (file.tasks.length === 0) return 'no tasks yet';
  return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
}
