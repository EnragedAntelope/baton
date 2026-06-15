import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { compactCommand } from '../src/commands/compact.js';
import { initCommand } from '../src/commands/init.js';
import { batonPaths } from '../src/core/files.js';
import { exists, makeRepo, rmrf, TempRepo } from './helpers.js';

/** Create a mock readline.Interface that returns preset answers in order. */
function mockReadline(answers: string[]): readline.Interface {
  let idx = 0;
  return {
    question: (_query: string, cb: (answer: string) => void) => {
      cb(answers[idx++] ?? '');
    },
    close: () => {},
  } as unknown as readline.Interface;
}

/** Create a fake session archive file in .baton/sessions/. */
async function createArchive(
  sessionsDir: string,
  timestamp: string,
  user: string,
  title = 'Session handoff',
): Promise<string> {
  const filename = `${timestamp}.${user}.md`;
  const filePath = path.join(sessionsDir, filename);
  const content = `# Handoff — ${title} — from ${user}\n\nSome session content.\n`;
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/** Create multiple archives with increasing timestamps. */
async function createArchives(
  sessionsDir: string,
  count: number,
  baseDate = new Date('2026-01-01T00:00:00Z'),
): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(baseDate.getTime() + i * 86400000); // +1 day each
    const ts = date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const user = `user${i}`;
    const f = await createArchive(sessionsDir, ts, user, `Session ${i}`);
    files.push(f);
  }
  return files;
}

/** Commit session archives to git so compact can track their moves/deletions. */
async function commitArchives(repo: TempRepo, files: string[]): Promise<void> {
  await repo.git.add(files);
  await repo.git.commit('add session archives');
}

describe('baton compact', () => {
  let repo: TempRepo;
  afterEach(async () => {
    if (repo) await rmrf(repo.root);
  });

  describe('pre-conditions', () => {
    it('rejects --keep 0 with error', async () => {
      repo = await makeRepo('compact-keep0');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      await expect(
        compactCommand(repo.root, { keep: 0, dryRun: false, prune: false }),
      ).rejects.toThrow(/--keep must be at least 1/);
    });

    it('errors outside a baton repo', async () => {
      repo = await makeRepo('compact-noinit');
      // No initCommand — .baton/ doesn't exist
      await expect(
        compactCommand(repo.root, { keep: 3, dryRun: false, prune: false }),
      ).rejects.toThrow(/baton init/i);
    });
  });

  describe('--dry-run', () => {
    it('prints plan and makes zero filesystem changes', async () => {
      repo = await makeRepo('compact-dryrun');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });
      await createArchives(paths.sessions, 5);

      const archivesBefore = await fs.readdir(paths.sessions);
      expect(archivesBefore.length).toBe(5);

      const out = await compactCommand(repo.root, {
        keep: 3,
        dryRun: true,
        prune: false,
      });

      expect(out).toContain('DRY RUN');
      expect(out).toContain('Would compact');
      expect(out).toContain('Would keep');

      // Zero filesystem changes
      const archivesAfter = await fs.readdir(paths.sessions);
      expect(archivesAfter.length).toBe(5);
      expect(archivesAfter.sort()).toEqual(archivesBefore.sort());

      // No trash directory created
      const trashDir = path.join(paths.sessions, '.trash');
      expect(await exists(trashDir)).toBe(false);

      // No rollup file created
      const rollups = archivesAfter.filter((f) => f.startsWith('rollup-'));
      expect(rollups.length).toBe(0);
    });

    it('reports "nothing to compact" when archives <= keep', async () => {
      repo = await makeRepo('compact-dryrun-noop');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });
      await createArchives(paths.sessions, 1);

      const out = await compactCommand(repo.root, {
        keep: 1,
        dryRun: true,
        prune: false,
      });

      expect(out).toContain('Nothing to compact');
      expect(out).toContain('1 archive(s) found');
    });
  });

  describe('--keep N (normal compact)', () => {
    it('moves archives to .trash/, creates rollup summary, commits', async () => {
      repo = await makeRepo('compact-keep');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });
      const files = await createArchives(paths.sessions, 5);
      await commitArchives(repo, files);

      const out = await compactCommand(repo.root, {
        keep: 3,
        dryRun: false,
        prune: false,
      });

      expect(out).toContain('Compacted 2 archive(s)');
      expect(out).toContain('Rollup summary:');
      expect(out).toContain('Moved to trash:');
      expect(out).toContain('Committed:');
      expect(out).toContain('Archives kept:');

      // 3 archives remain in sessions/
      const sessionsContents = await fs.readdir(paths.sessions);
      const archives = sessionsContents.filter((f) => f.endsWith('.md') && !f.startsWith('rollup-'));
      expect(archives.length).toBe(3);

      // Rollup file created
      const rollups = sessionsContents.filter((f) => f.startsWith('rollup-'));
      expect(rollups.length).toBe(1);

      // Trash directory created with moved files
      const trashDir = path.join(paths.sessions, '.trash');
      expect(await exists(trashDir)).toBe(true);
      const trashBatches = await fs.readdir(trashDir);
      expect(trashBatches.length).toBe(1);
      const trashContents = await fs.readdir(path.join(trashDir, trashBatches[0]!));
      expect(trashContents.length).toBe(2);

      // Commit was created
      const log = await repo.git.log();
      expect(log.latest?.message).toMatch(/baton: compact 2 archive/);
    });

    it('is a no-op when only 2 sessions exist and --keep 3', async () => {
      repo = await makeRepo('compact-noop');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });
      const files = await createArchives(paths.sessions, 2);
      await commitArchives(repo, files);

      const out = await compactCommand(repo.root, {
        keep: 3,
        dryRun: false,
        prune: false,
      });

      expect(out).toContain('Nothing to compact');
      expect(out).toContain('2 archive(s) found');

      // No changes
      const sessionsContents = await fs.readdir(paths.sessions);
      expect(sessionsContents.length).toBe(2);
      expect(await exists(path.join(paths.sessions, '.trash'))).toBe(false);
    });
  });

  describe('--prune', () => {
    it('deletes .trash/ after confirmation', async () => {
      repo = await makeRepo('compact-prune');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });

      // First, do a normal compact to create trash
      const files = await createArchives(paths.sessions, 5);
      await commitArchives(repo, files);
      await compactCommand(repo.root, { keep: 3, dryRun: false, prune: false });

      const trashDir = path.join(paths.sessions, '.trash');
      expect(await exists(trashDir)).toBe(true);

      // Need more archives to reach the prune branch (archives > keep)
      const moreFiles = await createArchives(
        paths.sessions,
        3,
        new Date('2026-02-01T00:00:00Z'),
      );
      await commitArchives(repo, moreFiles);

      // Now prune with confirmation
      const rl = mockReadline(['y']);
      const out = await compactCommand(
        repo.root,
        { keep: 2, dryRun: false, prune: true },
        { promptReadline: rl },
      );

      expect(out).toContain('Pruned');
      expect(out).toContain('Committed:');

      // Trash directory removed
      expect(await exists(trashDir)).toBe(false);
    });

    it('aborts deletion when user declines confirmation', async () => {
      repo = await makeRepo('compact-prune-cancel');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });

      // Create trash via normal compact
      const files = await createArchives(paths.sessions, 5);
      await commitArchives(repo, files);
      await compactCommand(repo.root, { keep: 3, dryRun: false, prune: false });

      const trashDir = path.join(paths.sessions, '.trash');
      expect(await exists(trashDir)).toBe(true);

      // Need more archives to reach the prune branch (archives > keep)
      const moreFiles = await createArchives(
        paths.sessions,
        3,
        new Date('2026-02-01T00:00:00Z'),
      );
      await commitArchives(repo, moreFiles);

      // Prune with decline
      const rl = mockReadline(['n']);
      const out = await compactCommand(
        repo.root,
        { keep: 2, dryRun: false, prune: true },
        { promptReadline: rl },
      );

      expect(out).toContain('Prune cancelled');

      // Trash still exists
      expect(await exists(trashDir)).toBe(true);
    });

    it('reports nothing to prune when .trash/ does not exist', async () => {
      repo = await makeRepo('compact-prune-empty');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });
      // Create archives > keep so the code reaches the prune branch
      const files = await createArchives(paths.sessions, 5);
      await commitArchives(repo, files);

      const out = await compactCommand(repo.root, {
        keep: 3,
        dryRun: false,
        prune: true,
      });

      expect(out).toContain('Nothing in trash to prune');
    });
  });

  describe('edge cases', () => {
    it('handles corrupt archive files gracefully (unreadable title)', async () => {
      repo = await makeRepo('compact-corrupt');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });

      // Create 3 valid archives + 1 with empty content
      await createArchives(paths.sessions, 3);
      const corruptFile = path.join(
        paths.sessions,
        '2026-01-05T00-00-00Z.corrupt.md',
      );
      await fs.writeFile(corruptFile, '', 'utf8');

      const out = await compactCommand(repo.root, {
        keep: 2,
        dryRun: true,
        prune: false,
      });

      // Should not crash; corrupt file is listed with (unreadable) title
      expect(out).toContain('DRY RUN');
      expect(out).toContain('Would compact');
    });

    it('handles sessions/ directory with no archives', async () => {
      repo = await makeRepo('compact-empty');
      await initCommand(repo.root, { testCmd: 'node -e "process.exit(0)"' });
      const paths = batonPaths(repo.root);
      await fs.mkdir(paths.sessions, { recursive: true });

      const out = await compactCommand(repo.root, {
        keep: 3,
        dryRun: false,
        prune: false,
      });

      expect(out).toContain('Nothing to compact');
      expect(out).toContain('0 archive(s) found');
    });
  });
});
