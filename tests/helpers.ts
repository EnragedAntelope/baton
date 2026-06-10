import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';

export interface TempRepo {
  root: string;
  git: SimpleGit;
}

/** Create a temp git repo with an identity and one initial commit. */
export async function makeRepo(
  name = 'repo',
  identity = { name: 'Alice Dev', email: 'alice@example.com' },
): Promise<TempRepo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `baton-test-${name}-`));
  const git = simpleGit({ baseDir: root });
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', identity.name);
  await git.addConfig('user.email', identity.email);
  await git.addConfig('commit.gpgsign', 'false');
  await git.addConfig('tag.gpgsign', 'false');
  await fs.writeFile(path.join(root, 'README.md'), `# ${name}\n`, 'utf8');
  await git.add(['README.md']);
  await git.commit('initial commit');
  return { root, git };
}

/** Create a bare "origin" plus two user clones — a relay fixture. */
export async function makeRelay(): Promise<{
  origin: string;
  alice: TempRepo;
  bob: TempRepo;
}> {
  const seed = await makeRepo('seed');
  const origin = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-test-origin-'));
  await simpleGit({ baseDir: origin }).init(['--bare', '-b', 'main']);
  await seed.git.addRemote('origin', origin);
  await seed.git.push('origin', 'main');

  const clone = async (
    name: string,
    identity: { name: string; email: string },
  ): Promise<TempRepo> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `baton-test-${name}-`));
    const git = simpleGit({ baseDir: root });
    await git.clone(origin, root);
    await git.addConfig('user.name', identity.name);
    await git.addConfig('user.email', identity.email);
    await git.addConfig('commit.gpgsign', 'false');
    await git.addConfig('tag.gpgsign', 'false');
    return { root, git };
  };

  const alice = await clone('alice', { name: 'Alice Dev', email: 'alice@example.com' });
  const bob = await clone('bob', { name: 'Bob Dev', email: 'bob@example.com' });
  await rmrf(seed.root);
  return { origin, alice, bob };
}

export async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
