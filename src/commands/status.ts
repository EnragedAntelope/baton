import { describeHolder } from '../core/lock.js';
import { currentBranch, headCommit, isCleanOutsideBaton } from '../core/repo.js';
import { openTasks, taskSummary } from '../core/tasks.js';
import { loadContext } from './context.js';

export async function statusCommand(cwd: string): Promise<string> {
  const ctx = await loadContext(cwd);
  const [branch, head, clean] = await Promise.all([
    currentBranch(ctx.git),
    headCommit(ctx.git),
    isCleanOutsideBaton(ctx.git),
  ]);

  const lines: string[] = [];
  lines.push(`Baton — ${ctx.config.project}`);
  lines.push(`  Baton:     ${describeHolder(ctx.state)}`);
  if (ctx.state.lastPass) {
    lines.push(
      `  Last pass: #${ctx.state.passCount} by ${ctx.state.lastPass.user} at ${ctx.state.lastPass.at} (${ctx.state.lastPass.commit.slice(0, 7)})`,
    );
  } else {
    lines.push('  Last pass: none yet');
  }
  if (ctx.state.queue.length > 0) {
    lines.push(`  Queue:     ${ctx.state.queue.join(' → ')}`);
  }
  lines.push(`  Branch:    ${branch} @ ${head.slice(0, 7)} (${clean ? 'clean' : 'DIRTY'})`);
  lines.push(`  Tasks:     ${taskSummary(ctx.tasks)}`);
  const next = openTasks(ctx.tasks).slice(0, 3);
  for (const t of next) {
    lines.push(`             [${t.id}] ${t.title} — ${t.status}`);
  }
  lines.push(`  You:       ${ctx.handle}${ctx.knownParticipant ? '' : ' (NOT in config.json participants — add yourself)'}`);
  return lines.join('\n');
}
