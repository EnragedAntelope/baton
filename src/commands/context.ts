import { SimpleGit } from 'simple-git';
import { Config, State, TasksFile } from '../types.js';
import {
  batonInitialized,
  BatonError,
  readConfig,
  readState,
  readTasks,
} from '../core/files.js';
import { findRepoRoot, getGit, getIdentity, GitIdentity } from '../core/repo.js';

export interface BatonContext {
  root: string;
  git: SimpleGit;
  identity: GitIdentity;
  /** Relay handle: participant matched by git email, else git user.name. */
  handle: string;
  knownParticipant: boolean;
  state: State;
  config: Config;
  tasks: TasksFile;
}

export function resolveHandle(
  config: Config,
  identity: GitIdentity,
): { handle: string; known: boolean } {
  const participant = config.participants.find((p) =>
    p.gitEmails.some((e) => e.toLowerCase() === identity.email.toLowerCase()),
  );
  if (participant) return { handle: participant.handle, known: true };
  return { handle: identity.name, known: false };
}

export async function loadContext(cwd: string): Promise<BatonContext> {
  const root = await findRepoRoot(cwd);
  if (!(await batonInitialized(root))) {
    throw new BatonError(
      'This repository has no .baton/ directory. Run "baton init" to start a relay.',
    );
  }
  const git = getGit(root);
  const identity = await getIdentity(git);
  const [state, config, tasks] = await Promise.all([
    readState(root),
    readConfig(root),
    readTasks(root),
  ]);
  const { handle, known } = resolveHandle(config, identity);
  return {
    root,
    git,
    identity,
    handle,
    knownParticipant: known,
    state,
    config,
    tasks,
  };
}
