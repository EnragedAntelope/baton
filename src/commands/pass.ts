import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import { batonPaths, BatonError, writeState } from '../core/files.js';
import {
  archiveHandoff,
  handoffTemplate,
  validateHandoff,
} from '../core/handoff.js';
import { releaseState } from '../core/lock.js';
import {
  commitPaths,
  createAnnotatedTag,
  currentBranch,
  headCommit,
  isCleanOutsideBaton,
  pushFast,
} from '../core/repo.js';
import { formatFindings, scanFiles } from '../security/secrets-scan.js';
import { getGit } from '../core/repo.js';
import { loadContext, BatonContext } from './context.js';

export interface PassOptions {
  agent?: string;
  /** Skip the test gate (recorded in the output, not silent). */
  skipTests?: boolean;
}

/** Parse the ISO timestamp out of the "# Handoff — {iso} — from …" header. */
function handoffTimestamp(content: string): Date | null {
  const m = content.match(/^# Handoff — (\S+) — from /m);
  if (!m || !m[1]) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function prepareTemplate(ctx: BatonContext, agent: string): Promise<never> {
  const paths = batonPaths(ctx.root);
  const archived = await archiveHandoff(ctx.root, ctx.handle);
  const template = handoffTemplate({
    user: ctx.handle,
    agent,
    branch: await currentBranch(ctx.git),
    commit: await headCommit(ctx.git),
    tasks: ctx.tasks,
  });
  await fs.writeFile(paths.handoff, template, 'utf8');
  throw new BatonError(
    [
      'HANDOFF.md is not ready — a fresh template has been written to .baton/HANDOFF.md.',
      archived ? `(previous handoff archived to ${archived})` : '',
      '',
      'Fill it in, then re-run "baton pass". Two ways:',
      '  - With an agent: ask it to run the baton-pass skill (skills/baton-pass/SKILL.md)',
      '  - By hand: replace every "_(fill me in)_" placeholder',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export async function passCommand(
  cwd: string,
  opts: PassOptions = {},
): Promise<string> {
  const ctx = await loadContext(cwd);
  const paths = batonPaths(ctx.root);
  const agent =
    opts.agent ??
    ctx.config.participants.find((p) => p.handle === ctx.handle)?.agent ??
    ctx.config.defaultAgent;

  if (ctx.state.holder !== ctx.handle) {
    throw new BatonError(
      ctx.state.holder
        ? `You don't hold the baton (held by ${ctx.state.holder}).`
        : 'You don\'t hold the baton. Run "baton claim" first so the pass is attributable.',
    );
  }

  // Gate 1: everything outside .baton/ must be committed.
  if (!(await isCleanOutsideBaton(ctx.git))) {
    throw new BatonError(
      'Working tree has uncommitted changes outside .baton/. Commit (or stash) your work first — a handoff must describe a reproducible state.',
    );
  }

  // Gate 2: the handoff must be fresh (newer than the last pass) and complete.
  const content = await fs.readFile(paths.handoff, 'utf8');
  const ts = handoffTimestamp(content);
  const stale =
    ts === null ||
    (ctx.state.lastPass !== null && ts.getTime() <= new Date(ctx.state.lastPass.at).getTime());
  if (stale) {
    await prepareTemplate(ctx, agent); // throws with instructions
  }
  const validation = validateHandoff(content);
  if (!validation.ok) {
    throw new BatonError(
      ['HANDOFF.md is incomplete:', ...validation.problems.map((p) => `  - ${p}`),
        'Fix it (or delete it and re-run "baton pass" for a fresh template).'].join('\n'),
    );
  }

  // Gate 3: tests must pass (policy), using the command from config.json.
  const notes: string[] = [];
  if (ctx.state.policy.requireCleanTests && !opts.skipTests) {
    const testCmd = ctx.config.commands.test;
    if (testCmd) {
      try {
        // Deliberate shell execution: commands.test is the repo's own configured
        // test command (same trust model as package.json scripts) and may need
        // shell features ("npm test && npm run lint"). It runs only at pass time
        // for the holder who can inspect config.json — never on pickup.
        execSync(testCmd, { cwd: ctx.root, stdio: 'pipe', timeout: 15 * 60 * 1000 });
        notes.push(`Tests passed (${testCmd})`);
      } catch (err) {
        const out = (err as { stdout?: Buffer; stderr?: Buffer });
        const tail = [out.stdout?.toString(), out.stderr?.toString()]
          .filter(Boolean).join('\n').split('\n').slice(-15).join('\n');
        throw new BatonError(
          `Test gate failed (${testCmd}). Fix the tests, document a blocker in HANDOFF.md, or pass --skip-tests (recorded).\n${tail}`,
        );
      }
    } else {
      notes.push('Test gate skipped: no commands.test in .baton/config.json');
    }
  } else if (opts.skipTests) {
    notes.push('Test gate SKIPPED by --skip-tests');
  }

  // Gate 4: no secrets in any tracked or new .baton/ file.
  if (ctx.state.policy.requireSecretScan) {
    const git = getGit(ctx.root);
    const out = await git.raw(['ls-files', '--cached', '--others', '--exclude-standard', '--', '.baton']);
    const files = out.split('\n').filter(Boolean);
    const findings = await scanFiles(ctx.root, files);
    if (findings.length > 0) {
      throw new BatonError(formatFindings(findings));
    }
    notes.push('Secret scan: clean');
  }

  // Record the pass: release holder, bump count, commit, tag, push.
  const workCommit = await headCommit(ctx.git);
  const released = releaseState(ctx.state, ctx.handle, workCommit);
  const next = released.queue[0];
  const finalState = next
    ? {
        ...released,
        holder: next,
        holderSince: new Date().toISOString(),
        queue: released.queue.slice(1),
      }
    : released;
  await writeState(ctx.root, finalState);

  const passNo = finalState.passCount;
  await commitPaths(ctx.git, `baton: pass #${passNo} by ${ctx.handle}`, ['.baton']);
  const tagName = `baton/pass/${passNo}`;
  const tag = await createAnnotatedTag(
    ctx.git,
    tagName,
    `Baton pass #${passNo} by ${ctx.handle} (${agent})\nwork: ${workCommit}\n${notes.join('\n')}`,
  );
  const push = await pushFast(ctx.git);
  if (push.rejected) {
    throw new BatonError(
      'Push rejected — origin moved while you held the baton. Pull --rebase, resolve, and push manually; the pass commit and tag are local.',
    );
  }

  const handle = next ? `Baton passed to ${next} (next in queue)` : 'Baton released';
  return [
    `${handle} — pass #${passNo} tagged ${tagName}${tag.signed ? ' (signed)' : ''}.`,
    ...notes.map((n) => `  - ${n}`),
    push.pushed ? 'Pushed to origin.' : 'No origin remote — share the repo manually.',
    next
      ? `Tell ${next}: "baton pickup" is ready.`
      : 'Anyone can now "baton pickup".',
  ].join('\n');
}
