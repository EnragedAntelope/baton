import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { batonPaths, BatonError } from '../core/files.js';
import { commitPaths, pushFast } from '../core/repo.js';
import { confirmPrompt } from '../core/prompts.js';
import { loadContext } from './context.js';

export interface CompactOptions {
  keep: number;
  dryRun: boolean;
  prune: boolean;
}

export interface CompactDeps {
  promptReadline?: readline.Interface;
}

interface SessionArchive {
  file: string;
  filename: string;
  date: Date;
  user: string;
  title: string;
}

const ARCHIVE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z)\.(.+)\.md$/;

function parseArchiveFilename(filename: string): { date: Date; user: string } | null {
  const match = filename.match(ARCHIVE_RE);
  if (!match || !match[1] || !match[2]) return null;
  const dateStr = match[1].replace(/-/g, (m, offset: number) => {
    // Only replace hyphens in the time portion (after the T)
    const tIdx = match![1]!.indexOf('T');
    return offset > tIdx ? ':' : '-';
  });
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return { date, user: match[2] };
}

async function extractTitle(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const firstLine = content.split('\n')[0] ?? '';
    const titleMatch = firstLine.match(/^# Handoff — (.+?) — from/);
    if (titleMatch && titleMatch[1]) return titleMatch[1].trim();
    return firstLine.slice(0, 80) || '(untitled)';
  } catch {
    return '(unreadable)';
  }
}

async function listSessionArchives(sessionsDir: string): Promise<SessionArchive[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const archives: SessionArchive[] = [];
  for (const filename of entries) {
    const parsed = parseArchiveFilename(filename);
    if (!parsed) continue;
    const file = path.join(sessionsDir, filename);
    const title = await extractTitle(file);
    archives.push({ file, filename, date: parsed.date, user: parsed.user, title });
  }

  return archives.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function formatTrashDate(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

function generateRollupSummary(archives: SessionArchive[]): string {
  if (archives.length === 0) return '';

  const first = archives[0]!;
  const last = archives[archives.length - 1]!;
  const lines: string[] = [];

  lines.push(`## Rollup: ${first.filename} through ${last.filename}`);
  lines.push('');
  lines.push(`Compacted ${archives.length} session archive(s) into this summary.`);
  lines.push('');
  lines.push('| # | Date | Who | Title |');
  lines.push('|---|------|-----|-------|');

  for (let i = 0; i < archives.length; i++) {
    const a = archives[i]!;
    const dateStr = a.date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const shortTitle = a.title.length > 60 ? a.title.slice(0, 57) + '...' : a.title;
    lines.push(`| ${i + 1} | ${dateStr} | ${a.user} | ${shortTitle} |`);
  }

  lines.push('');
  return lines.join('\n');
}

export async function compactCommand(
  cwd: string,
  opts: CompactOptions,
  deps: CompactDeps = {},
): Promise<string> {
  if (opts.keep < 1) {
    throw new BatonError('--keep must be at least 1.');
  }

  const ctx = await loadContext(cwd);
  const paths = batonPaths(ctx.root);
  const sessionsDir = paths.sessions;
  const trashDir = path.join(sessionsDir, '.trash');

  const allArchives = await listSessionArchives(sessionsDir);

  if (allArchives.length <= opts.keep) {
    return `Nothing to compact — ${allArchives.length} archive(s) found, keeping ${opts.keep}.`;
  }

  const toRollup = allArchives.slice(0, allArchives.length - opts.keep);
  const toKeep = allArchives.slice(allArchives.length - opts.keep);

  const lines: string[] = [];
  lines.push('Baton Compact');
  lines.push('');
  lines.push(`Found ${allArchives.length} session archive(s).`);
  lines.push(`Keeping ${toKeep.length} most recent, compacting ${toRollup.length}.`);
  lines.push('');

  if (opts.dryRun) {
    lines.push('DRY RUN — no changes will be made.');
    lines.push('');
    lines.push('Would compact:');
    for (const a of toRollup) {
      lines.push(`  - ${a.filename}  (${a.user}, ${a.date.toISOString()})`);
    }
    lines.push('');
    lines.push('Would keep:');
    for (const a of toKeep) {
      lines.push(`  - ${a.filename}  (${a.user}, ${a.date.toISOString()})`);
    }
    lines.push('');
    lines.push(`Would generate rollup summary in .baton/sessions/`);
    lines.push(`Would move ${toRollup.length} archive(s) to .baton/sessions/.trash/`);
    return lines.join('\n');
  }

  if (opts.prune) {
    const trashExists = await dirExists(trashDir);
    if (!trashExists) {
      return 'Nothing in trash to prune — .baton/sessions/.trash/ does not exist.';
    }

    const trashContents = await fs.readdir(trashDir);
    if (trashContents.length === 0) {
      return 'Nothing in trash to prune — .baton/sessions/.trash/ is empty.';
    }

    lines.push(`Permanently delete ${trashContents.length} item(s) from .baton/sessions/.trash/?`);
    lines.push('This cannot be undone.');
    lines.push('');

    const confirmed = await confirmPrompt(
      `Delete ${trashContents.length} item(s) from trash permanently?`,
      false,
      deps.promptReadline,
    );
    if (!confirmed) {
      return 'Prune cancelled.';
    }

    await fs.rm(trashDir, { recursive: true, force: true });

    const commitHash = await commitPaths(ctx.git, 'baton: compact --prune (deleted trash)', [
      '.baton/sessions/.trash',
    ]);
    await pushFast(ctx.git);

    lines.push(`Pruned ${trashContents.length} item(s) from trash.`);
    lines.push(`Committed: ${commitHash.slice(0, 7)}`);
    return lines.join('\n');
  }

  // Normal compact: generate rollup + move to trash
  const rollupContent = generateRollupSummary(toRollup);
  const rollupFile = path.join(
    sessionsDir,
    `rollup-${formatTrashDate(new Date())}.md`,
  );
  await fs.writeFile(rollupFile, rollupContent, 'utf8');

  const trashStamp = formatTrashDate(new Date());
  const trashBatchDir = path.join(trashDir, trashStamp);
  await fs.mkdir(trashBatchDir, { recursive: true });

  const movedFiles: string[] = [];
  for (const archive of toRollup) {
    const dest = path.join(trashBatchDir, archive.filename);
    await fs.rename(archive.file, dest);
    movedFiles.push(dest);
  }

  const gitPaths = [
    rollupFile,
    ...movedFiles,
    ...toRollup.map((a) => a.file),
  ];

  const commitHash = await commitPaths(
    ctx.git,
    `baton: compact ${toRollup.length} archive(s) (keep ${opts.keep})`,
    gitPaths,
  );
  await pushFast(ctx.git);

  lines.push(`Compacted ${toRollup.length} archive(s).`);
  lines.push(`Rollup summary: ${path.relative(ctx.root, rollupFile)}`);
  lines.push(`Moved to trash: .baton/sessions/.trash/${trashStamp}/`);
  lines.push(`Committed: ${commitHash.slice(0, 7)}`);
  lines.push('');
  lines.push('Archives kept:');
  for (const a of toKeep) {
    lines.push(`  - ${a.filename}`);
  }

  return lines.join('\n');
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
