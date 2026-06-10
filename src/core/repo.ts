import { simpleGit, SimpleGit } from 'simple-git';
import { BatonError } from './files.js';

export function getGit(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const git = getGit(cwd);
  if (!(await git.checkIsRepo())) {
    throw new BatonError(
      'Not inside a git repository. Baton uses git as its transport — run "git init" (or clone the project) first.',
    );
  }
  return (await git.revparse(['--show-toplevel'])).trim();
}

export interface GitIdentity {
  name: string;
  email: string;
}

export async function getIdentity(git: SimpleGit): Promise<GitIdentity> {
  const name = (await git.getConfig('user.name')).value;
  const email = (await git.getConfig('user.email')).value;
  if (!name || !email) {
    throw new BatonError(
      'git user.name / user.email not configured. Baton uses your git identity for attribution — set them with "git config".',
    );
  }
  return { name, email };
}

export async function currentBranch(git: SimpleGit): Promise<string> {
  return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
}

export async function headCommit(git: SimpleGit): Promise<string> {
  return (await git.revparse(['HEAD'])).trim();
}

/** True when nothing is staged/modified/untracked outside .baton/. */
export async function isCleanOutsideBaton(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return status.files.every((f) => f.path.replace(/\\/g, '/').startsWith('.baton/'));
}

export async function hasOrigin(git: SimpleGit): Promise<boolean> {
  const remotes = await git.getRemotes();
  return remotes.some((r) => r.name === 'origin');
}

/** Pull latest from origin if it exists. No-op for local-only repos. */
export async function syncFromOrigin(git: SimpleGit): Promise<void> {
  if (!(await hasOrigin(git))) return;
  const branch = await currentBranch(git);
  try {
    await git.pull('origin', branch, { '--ff-only': null });
  } catch (err) {
    throw new BatonError(
      `Could not fast-forward from origin/${branch}. Resolve your local divergence first.\n${(err as Error).message}`,
    );
  }
}

export interface PushResult {
  pushed: boolean;
  rejected: boolean;
}

/**
 * Push-fast: attempt an immediate push so a competing claim is detected
 * within seconds. Returns rejected=true when origin already moved
 * (someone else won the race).
 */
export async function pushFast(git: SimpleGit): Promise<PushResult> {
  if (!(await hasOrigin(git))) return { pushed: false, rejected: false };
  const branch = await currentBranch(git);
  try {
    await git.push('origin', branch, ['--follow-tags']);
    return { pushed: true, rejected: false };
  } catch (err) {
    const msg = (err as Error).message;
    if (/rejected|fetch first|non-fast-forward|stale info/i.test(msg)) {
      return { pushed: false, rejected: true };
    }
    throw err;
  }
}

/** Undo the most recent local commit (used to back out a lost claim race). */
export async function rollbackLastCommit(git: SimpleGit): Promise<void> {
  await git.reset(['--hard', 'HEAD~1']);
}

export async function commitPaths(
  git: SimpleGit,
  message: string,
  paths: string[],
): Promise<string> {
  await git.add(paths);
  const result = await git.commit(message, paths);
  return result.commit;
}

export async function createAnnotatedTag(
  git: SimpleGit,
  name: string,
  message: string,
): Promise<{ signed: boolean }> {
  // Prefer a signed tag when the user has signing configured; fall back to
  // a plain annotated tag so unsigned setups still get a custody chain.
  const signingKey = (await git.getConfig('user.signingkey')).value;
  if (signingKey) {
    try {
      await git.raw(['tag', '-s', name, '-m', message]);
      return { signed: true };
    } catch {
      // signing configured but unusable (no agent, no key) — fall through
    }
  }
  await git.addAnnotatedTag(name, message);
  return { signed: false };
}

export async function listPassTags(git: SimpleGit): Promise<string[]> {
  const result = await git.tags(['--list', 'baton/pass/*', '--sort=v:refname']);
  return result.all;
}
