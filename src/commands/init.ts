import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  batonInitialized,
  BatonError,
  batonPaths,
  writeConfig,
  writeState,
  writeTasks,
} from '../core/files.js';
import {
  commitPaths,
  findRepoRoot,
  getGit,
  getIdentity,
  hasOrigin,
} from '../core/repo.js';
import { confirmPrompt } from '../core/prompts.js';
import { installHook } from '../security/hook.js';
import {
  AgentNameSchema,
  defaultConfig,
  defaultState,
  defaultTasksFile,
} from '../types.js';
import { detectAgent } from '../adapters/index.js';

export interface InitOptions {
  project?: string;
  handle?: string;
  agent?: string;
  testCmd?: string;
  commit?: boolean; // commander --no-commit
  refreshHook?: boolean;
  auto?: boolean; // --auto: accept all detected defaults without prompting
}

const GITIGNORE_BLOCK = `
# Added by baton init — secrets must never enter the repo or the handoff
.env
.env.*
!.env.example
*.pem
*.key
.baton/.snapshots/
`;

function projectMd(project: string, testCmd?: string): string {
  return `# Project: ${project}

Stable context every relay member (and their agent) should know.
Keep this file short and current — narrative history goes in decisions.md.

## Goal
_(what are we building, in one paragraph)_

## Stack
_(languages, frameworks, key dependencies)_

## Conventions
_(style rules, patterns, things agents must respect)_

## Run / test commands
- Test: \`${testCmd ?? '(set in .baton/config.json "commands.test")'}\`

## Secrets
Each member keeps their own .env (gitignored). Reference secrets by NAME only —
never paste values into any .baton/ file.
`;
}

/** Scan the project root for known test commands. */
export async function autoDetectTestCmd(root: string): Promise<string | null> {
  // npm / package.json
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.scripts?.test) return 'npm test';
  } catch { /* no package.json */ }

  // Cargo
  try {
    await fs.access(path.join(root, 'Cargo.toml'));
    return 'cargo test';
  } catch { /* no Cargo.toml */ }

  // Go
  try {
    await fs.access(path.join(root, 'go.mod'));
    return 'go test ./...';
  } catch { /* no go.mod */ }

  // Makefile
  try {
    const raw = await fs.readFile(path.join(root, 'Makefile'), 'utf8');
    if (/^test:/m.test(raw)) return 'make test';
  } catch { /* no Makefile or no test: target */ }

  return null;
}

const DECISIONS_MD = `# Decision log

Append-only, newest at the bottom. One short entry per decision:
date, author, what was decided, and why.

---
`;

const HANDOFF_STUB = `# Handoff — (none yet)

No pass has happened yet. The first "baton pass" will generate this file.
`;

export async function initCommand(
  cwd: string,
  opts: InitOptions,
): Promise<string> {
  const root = await findRepoRoot(cwd);
  const git = getGit(root);
  const identity = await getIdentity(git);
  const paths = batonPaths(root);

  if (opts.refreshHook) {
    if (!(await batonInitialized(root))) {
      throw new BatonError('Cannot refresh hook: .baton/ not initialized.');
    }
    const hook = await installHook(root);
    return `Regenerated ${path.relative(root, hook.scriptPath)}${
      hook.shimInstalled ? ' and reinstalled .git/hooks/pre-commit' : ''
    }`;
  }

  if (await batonInitialized(root)) {
    throw new BatonError(
      '.baton/ already exists. Use "baton status" — or "baton init --refresh-hook" to reinstall the hook.',
    );
  }

  const project = opts.project ?? path.basename(root);
  const handle = opts.handle ?? identity.name;

  // --- Auto-detect agent ---
  let agent = opts.agent ? AgentNameSchema.parse(opts.agent) : undefined;
  if (!agent && opts.auto) {
    agent = (await detectAgent(root)) ?? undefined;
  } else if (!agent && process.stdin.isTTY) {
    const detected = await detectAgent(root);
    if (detected) {
      const ok = await confirmPrompt(`Detected agent: ${detected}. Use this?`);
      if (ok) agent = detected;
    }
  }

  // --- Auto-detect test command ---
  let testCmd = opts.testCmd;
  if (!testCmd) {
    if (opts.auto) {
      testCmd = (await autoDetectTestCmd(root)) ?? undefined;
      if (!testCmd) {
        throw new BatonError(
          'Could not auto-detect a test command. Run "baton init --test-cmd <cmd>" to specify one explicitly.',
        );
      }
    } else if (process.stdin.isTTY) {
      const detected = await autoDetectTestCmd(root);
      if (detected) {
        const ok = await confirmPrompt(`Detected test command: ${detected}. Use this?`);
        if (ok) testCmd = detected;
      }
      if (!testCmd) {
        throw new BatonError(
          'No test command detected. Run "baton init --test-cmd <cmd>" to specify one.',
        );
      }
    } else {
      // Non-TTY, non-auto: leave testCmd undefined (backward compat with tests)
      testCmd = undefined;
    }
  }

  // --- Git remote check (informational) ---
  if (!opts.auto && process.stdin.isTTY && !(await hasOrigin(git))) {
    await confirmPrompt(
      'No git remote "origin" found. Continue anyway? (needed for relay)',
      true,
    );
  }

  await fs.mkdir(paths.sessions, { recursive: true });

  const config = defaultConfig(project);
  config.participants.push({
    handle,
    gitEmails: [identity.email],
    ...(agent ? { agent } : {}),
  });
  if (agent) config.defaultAgent = agent;
  if (testCmd) config.commands.test = testCmd;

  await writeState(root, defaultState());
  await writeTasks(root, defaultTasksFile());
  await writeConfig(root, config);
  await fs.writeFile(paths.project, projectMd(project, testCmd), 'utf8');
  await fs.writeFile(paths.decisions, DECISIONS_MD, 'utf8');
  await fs.writeFile(paths.handoff, HANDOFF_STUB, 'utf8');

  // Seed .gitignore so env files can never ride along with a handoff.
  const gitignorePath = path.join(root, '.gitignore');
  let gitignore = '';
  try {
    gitignore = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    // no .gitignore yet
  }
  if (!/^\.env$/m.test(gitignore)) {
    await fs.writeFile(gitignorePath, gitignore + GITIGNORE_BLOCK, 'utf8');
  }

  const hook = await installHook(root);

  const lines = [
    `Initialized .baton/ for project "${project}" (participant: ${handle} <${identity.email}>)`,
    `Secret-scan hook: ${path.relative(root, hook.scriptPath)}`,
  ];
  if (agent && !opts.agent) {
    lines.push(`Auto-detected agent: ${agent}`);
  }
  if (testCmd && !opts.testCmd) {
    lines.push(`Auto-detected test command: ${testCmd}`);
  }
  const hasRemote = await hasOrigin(git);
  if (!hasRemote) {
    lines.push(
      'Note: no git remote "origin" found. Push to set one up before the first relay pass.',
    );
  }
  if (!hook.shimInstalled) {
    lines.push(
      'WARNING: an existing .git/hooks/pre-commit was left untouched — chain it to',
      '  node .baton/hooks/pre-commit.mjs',
    );
  }

  if (opts.commit !== false) {
    await commitPaths(git, 'baton: init relay', ['.baton', '.gitignore']);
    lines.push('Committed: baton: init relay');
    lines.push(
      'Next: fill in .baton/project.md, add participants to .baton/config.json, push, and "baton claim".',
    );
  } else {
    lines.push('Files staged-ready (no commit, per --no-commit).');
  }
  return lines.join('\n');
}
