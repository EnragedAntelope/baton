import { promises as fs } from 'node:fs';
import { batonPaths, BatonError, readState, writeState } from '../core/files.js';
import { claimState } from '../core/lock.js';
import {
  commitPaths,
  currentBranch,
  findRepoRoot,
  getGit,
  headCommit,
  pushFast,
  rollbackLastCommit,
  syncFromOrigin,
} from '../core/repo.js';
import { openTasks } from '../core/tasks.js';
import { verifyLastPass } from '../security/verify.js';
import { getAdapter } from '../adapters/index.js';
import { AgentNameSchema } from '../types.js';
import { loadContext } from './context.js';
import { describeHolder } from '../core/lock.js';

export interface PickupOptions {
  agent?: string;
  /** Proceed even when custody verification fails (loudly recorded). */
  force?: boolean;
}

/** Extract one section's body from HANDOFF.md. */
function section(content: string, heading: string): string {
  const idx = content.indexOf(`## ${heading}`);
  if (idx === -1) return '(none)';
  const rest = content.slice(idx + heading.length + 3);
  return (rest.split(/^## /m)[0] ?? '').trim() || '(none)';
}

export async function pickupCommand(
  cwd: string,
  opts: PickupOptions = {},
): Promise<string> {
  // Sync first so we claim against the latest relay state — a fresh clone
  // may not even have .baton/ until this pull lands.
  await syncFromOrigin(getGit(await findRepoRoot(cwd)));
  const ctx = await loadContext(cwd);
  const agentName = AgentNameSchema.parse(
    opts.agent ??
      ctx.config.participants.find((p) => p.handle === ctx.handle)?.agent ??
      ctx.config.defaultAgent,
  );

  // Verify the custody chain before trusting the handoff.
  const verification = await verifyLastPass(ctx.git, ctx.state, ctx.config);
  if (verification.errors.length > 0 && !opts.force) {
    throw new BatonError(
      [
        'Custody verification FAILED:',
        ...verification.errors.map((e) => `  - ${e}`),
        'Investigate before picking up, or re-run with --force to proceed anyway.',
      ].join('\n'),
    );
  }

  // Claim (no-op refresh if the queue already assigned it to you).
  const alreadyHolder = ctx.state.holder === ctx.handle;
  if (!alreadyHolder) {
    const claimed = claimState(ctx.state, ctx.handle);
    await writeState(ctx.root, claimed);
    await commitPaths(ctx.git, `baton: pickup by ${ctx.handle}`, [
      '.baton/state.json',
    ]);
    const push = await pushFast(ctx.git);
    if (push.rejected) {
      await rollbackLastCommit(ctx.git);
      await syncFromOrigin(ctx.git);
      const current = await readState(ctx.root);
      throw new BatonError(
        `Someone claimed the baton while you were picking up — ${describeHolder(current)}.`,
      );
    }
  }

  // Bootstrap the agent and build the digest.
  const adapter = getAdapter(agentName);
  const bootstrap = await adapter.bootstrap({
    root: ctx.root,
    project: ctx.config.project,
    tasks: ctx.tasks,
  });
  if (bootstrap.changedFiles.length > 0) {
    await commitPaths(
      ctx.git,
      `baton: bootstrap ${agentName} context`,
      bootstrap.changedFiles,
    );
    await pushFast(ctx.git);
  }

  const handoff = await fs.readFile(batonPaths(ctx.root).handoff, 'utf8');
  const branch = await currentBranch(ctx.git);
  const head = await headCommit(ctx.git);
  const next = openTasks(ctx.tasks).slice(0, 3);

  const lines: string[] = [];
  lines.push(`You have the baton (${ctx.handle}, via ${agentName}).`);
  if (ctx.state.lastPass) {
    lines.push(
      `Last pass: #${ctx.state.passCount} by ${ctx.state.lastPass.user} at ${ctx.state.lastPass.at}`,
    );
  } else {
    lines.push('First pickup — no pass has happened yet.');
  }
  for (const w of verification.warnings) lines.push(`  warning: ${w}`);
  for (const e of verification.errors) lines.push(`  OVERRIDDEN ERROR (--force): ${e}`);
  lines.push(`Branch: ${branch} @ ${head.slice(0, 7)}`);
  lines.push(`Build state (from handoff): ${section(handoff, 'Branch & build state').split('\n').join(' | ')}`);
  lines.push(`Blockers: ${section(handoff, 'Blockers & landmines').split('\n').join(' | ')}`);
  if (next.length > 0) {
    lines.push('Next up:');
    for (const t of next) lines.push(`  [${t.id}] ${t.title} — ${t.status}`);
  }
  lines.push(...bootstrap.messages);
  lines.push('', 'First prompt for your agent:', `  ${bootstrap.firstPrompt}`);
  return lines.join('\n');
}
