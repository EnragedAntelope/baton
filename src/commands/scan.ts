import path from 'node:path';
import { BatonError } from '../core/files.js';
import { findRepoRoot, getGit } from '../core/repo.js';
import { formatFindings, scanFiles, scanText } from '../security/secrets-scan.js';

export interface ScanOptions {
  staged?: boolean;
}

/** Scan .baton/ for secrets — working tree by default, staged with --staged. */
export async function scanCommand(
  cwd: string,
  opts: ScanOptions,
): Promise<string> {
  const root = await findRepoRoot(cwd);
  const git = getGit(root);

  if (opts.staged) {
    const out = await git.raw([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACM',
      '--',
      '.baton',
    ]);
    const files = out.split('\n').filter(Boolean);
    const findings = [];
    for (const file of files) {
      const content = await git.show([`:${file}`]);
      findings.push(...scanText(content, file));
    }
    if (findings.length > 0) throw new BatonError(formatFindings(findings));
    return `Scanned ${files.length} staged .baton file(s): clean`;
  }

  const out = await git.raw(['ls-files', '--cached', '--others', '--exclude-standard', '--', '.baton']);
  const files = out
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, path.sep));
  const findings = await scanFiles(root, files);
  if (findings.length > 0) throw new BatonError(formatFindings(findings));
  return `Scanned ${files.length} .baton file(s): clean`;
}
