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
} from '../core/repo.js';
import { installHook } from '../security/hook.js';
import {
  AgentNameSchema,
  defaultConfig,
  defaultState,
  defaultTasksFile,
} from '../types.js';

export interface InitOptions {
  project?: string;
  handle?: string;
  agent?: string;
  testCmd?: string;
  commit?: boolean; // commander --no-commit
  refreshHook?: boolean;
}

const GITIGNORE_BLOCK = `
# Added by baton init — secrets must never enter the repo or the handoff
.env
.env.*
!.env.example
*.pem
*.key
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
  const agent = opts.agent ? AgentNameSchema.parse(opts.agent) : undefined;

  await fs.mkdir(paths.sessions, { recursive: true });

  const config = defaultConfig(project);
  config.participants.push({
    handle,
    gitEmails: [identity.email],
    ...(agent ? { agent } : {}),
  });
  if (agent) config.defaultAgent = agent;
  if (opts.testCmd) config.commands.test = opts.testCmd;

  await writeState(root, defaultState());
  await writeTasks(root, defaultTasksFile());
  await writeConfig(root, config);
  await fs.writeFile(paths.project, projectMd(project, opts.testCmd), 'utf8');
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
