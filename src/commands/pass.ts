import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { batonPaths, BatonError, writeState, saveSnapshot } from '../core/files.js';
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
import {
  buildAgentCommand,
  buildFillPrompt,
  detectAgentSession,
  invokeAgent,
} from '../core/agent-invoke.js';
import { AgentNameSchema } from '../types.js';
import { loadContext, BatonContext } from './context.js';
import { promptUser } from '../core/prompts.js';
export interface PassOptions {
  agent?: string;
  /** Skip the test gate (recorded in the output, not silent). */
  skipTests?: boolean;
  /** Invoke the agent CLI headlessly to fill the template. */
  auto?: boolean;
  /** Timeout in seconds for --auto agent invocation (default 60). */
  autoTimeout?: number;
  /** Prompt interactively for handoff sections instead of reading HANDOFF.md. */
  interactive?: boolean;
}

/** Test seam for the headless-agent path. */
export interface PassDeps {
  invoke?: typeof invokeAgent;
  detectSession?: typeof detectAgentSession;
  /** Injected readline interface for interactive mode testing. */
  promptReadline?: readline.Interface;
}

/** Parse the ISO timestamp out of the "# Handoff — {iso} — from …" header. */
function handoffTimestamp(content: string): Date | null {
  const m = content.match(/^# Handoff — (\S+) — from /m);
  if (!m || !m[1]) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function writeFreshTemplate(
  ctx: BatonContext,
  agent: string,
): Promise<string | null> {
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
  return archived;
}

function templateInstructions(archived: string | null): string {
  return [
    'HANDOFF.md is not ready — a fresh template has been written to .baton/HANDOFF.md.',
    archived ? `(previous handoff archived to ${archived})` : '',
    '',
    'Fill it in, then re-run "baton pass". Three ways:',
    '  - From inside your agent session: ask it to pass the baton (baton-pass skill)',
    '  - Headless (experimental): baton pass --auto invokes your agent CLI for you',
    '  - By hand: replace every "_(fill me in)_" placeholder',
  ]
    .filter(Boolean)
    .join('\n');
}
/** Extract the body of a markdown section (e.g. "## Where things stand"). */
function extractSection(content: string, heading: string): string | undefined {
  const marker = `## ${heading}`;
  const idx = content.indexOf(marker);
  if (idx === -1) return undefined;
  const rest = content.slice(idx + marker.length);
  const body = rest.split(/^## /m)[0] ?? '';
  const cleaned = body.replace(/_\(fill me in\)_/g, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Build a HANDOFF.md from the template, replacing placeholders with interactive answers. */
function buildInteractiveHandoff(
  template: string,
  answers: Record<string, string>,
): string {
  let result = template;

  // Where things stand: replace placeholder with goal
  result = result.replace(
    `## Where things stand
_(fill me in)_`,
    `## Where things stand
${answers.goal || ''}`
  );

  // Done this session: replace placeholder with decisions/actions
  result = result.replace(
    `## Done this session
_(fill me in)_`,
    `## Done this session
${answers.done || ''}`
  );

  // Blockers & landmines: replace placeholder with blockers
  result = result.replace(
    `## Blockers & landmines
_(fill me in)_`,
    `## Blockers & landmines
${answers.blockers || ''}`
  );

  // Branch & build state: replace only the Tests line
  result = result.replace(
    /- Tests: _\(fill me in\)_/,
    `- Tests: ${answers.buildState || ''}`
  );

  // In progress / next up: replace placeholder with dead ends
  result = result.replace(
    `## In progress / next up
_(fill me in)_`,
    `## In progress / next up
${answers.deadEnds || ''}`
  );

  return result;
}

export async function passCommand(
  cwd: string,
  opts: PassOptions = {},
  deps: PassDeps = {},
): Promise<string> {
  const ctx = await loadContext(cwd);
  // Save snapshot before pass so undo can restore pre-pass state.
  await saveSnapshot(ctx.root);
  const paths = batonPaths(ctx.root);
  const agent = AgentNameSchema.parse(
    opts.agent ??
      ctx.config.participants.find((p) => p.handle === ctx.handle)?.agent ??
      ctx.config.defaultAgent,
  );

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

  const notes: string[] = [];

  // Gate 2: the handoff must be fresh (newer than the last pass) and complete.
  const isStale = (text: string): boolean => {
    const ts = handoffTimestamp(text);
    return (
      ts === null ||
      (ctx.state.lastPass !== null &&
        ts.getTime() <= new Date(ctx.state.lastPass.at).getTime())
    );
  };
  let content = await fs.readFile(paths.handoff, 'utf8');
  if (isStale(content) || opts.interactive) {
    const archived = await writeFreshTemplate(ctx, agent);

    if (opts.interactive) {
      // Interactive mode: prompt for each handoff section.
      const previousGoal = extractSection(content, 'Where things stand');
      const questions = [
        { name: 'goal', message: 'What is the current goal?', default: previousGoal },
        { name: 'done', message: 'What decisions did you make?' },
        { name: 'blockers', message: 'What blockers exist?' },
        { name: 'deadEnds', message: 'What dead ends did you hit?' },
        { name: 'buildState', message: 'What is the current build/test state?' },
      ];
      const answers = await promptUser(questions, deps.promptReadline);
      const template = await fs.readFile(paths.handoff, 'utf8');
      content = buildInteractiveHandoff(template, answers);
      await fs.writeFile(paths.handoff, content, 'utf8');
    } else if (!opts.auto) {
      throw new BatonError(templateInstructions(archived));
    } else {
      // --auto: have the holder's agent CLI fill the template headlessly.
      const session = (deps.detectSession ?? detectAgentSession)();
      if (session) {
        throw new BatonError(
          `--auto refused: this looks like the inside of a ${session} session. The agent doing the work should fill .baton/HANDOFF.md itself (baton-pass skill) — spawning a second, cold agent would produce a worse handoff.`,
        );
      }
      const spec = buildAgentCommand(agent);
      if (!spec) {
        throw new BatonError(
          `--auto: no headless command known for agent "${agent}". ${templateInstructions(archived)}`,
        );
      }

      // Invoke the agent with configurable timeout (--auto-timeout).
      const invokeOpts = {
        timeoutMs: (opts.autoTimeout ?? 60) * 1000,
      };
      let invokeResult;
      try {
        invokeResult = await (deps.invoke ?? invokeAgent)(spec, buildFillPrompt(), ctx.root, invokeOpts);
      } catch (err) {
        if (err instanceof BatonError) {
          throw new BatonError(
            `--auto: ${err.message}\n\n${templateInstructions(archived)}`,
          );
        }
        throw err;
      }

      if (!invokeResult.ok) {
        throw new BatonError(
          `--auto: agent invocation failed — ${invokeResult.detail}\n\n${templateInstructions(archived)}`,
        );
      }
      content = await fs.readFile(paths.handoff, 'utf8');
      if (isStale(content)) {
        throw new BatonError(
          '--auto: the agent rewrote the handoff header instead of keeping it. Fix .baton/HANDOFF.md by hand and re-run "baton pass".',
        );
      }
      // Re-check gate 1: the agent was told to touch only .baton/, but verify.
      if (!(await isCleanOutsideBaton(ctx.git))) {
        throw new BatonError(
          '--auto: the agent modified files outside .baton/. Review those changes (commit or revert), then re-run "baton pass".',
        );
      }
      notes.push(`Handoff filled headlessly by ${agent} (--auto)`);
    }
  }
  const validation = validateHandoff(content);
  if (!validation.ok) {
    throw new BatonError(
      ['HANDOFF.md is incomplete:', ...validation.problems.map((p) => `  - ${p}`),
        'Fix it (or delete it and re-run "baton pass" for a fresh template).'].join('\n'),
    );
  }

  // Gate 3: tests must pass (policy), using the command from config.json.
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
