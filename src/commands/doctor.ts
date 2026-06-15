import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectAgent } from '../adapters/index.js';
import { batonPaths, BatonError, readState, readTasks, readConfig } from '../core/files.js';
import { findRepoRoot, getGit, getIdentity, hasOrigin } from '../core/repo.js';

export interface CheckResult {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

export async function doctorCommand(cwd: string): Promise<string> {
  const checks: CheckResult[] = [];
  let hasFail = false;

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = Number(nodeVersion.slice(1).split('.')[0]);
  if (major >= 20) {
    checks.push({ name: 'Node.js version', status: 'PASS', detail: nodeVersion });
  } else {
    checks.push({ name: 'Node.js version', status: 'FAIL', detail: `${nodeVersion} (requires ≥ 20)` });
    hasFail = true;
  }

  // 2. Git repo
  let root: string;
  try {
    root = await findRepoRoot(cwd);
    checks.push({ name: 'Git repo', status: 'PASS', detail: root });
  } catch {
    checks.push({ name: 'Git repo', status: 'FAIL', detail: 'Not inside a git repository' });
    hasFail = true;
    process.exitCode = 1;
    return formatChecks(checks, hasFail);
  }

  const git = getGit(root);

  // 3. Git remote
  if (await hasOrigin(git)) {
    checks.push({ name: 'Git remote', status: 'PASS', detail: 'origin configured' });
  } else {
    checks.push({ name: 'Git remote', status: 'WARN', detail: 'No origin remote' });
  }

  // 4. Git identity
  try {
    const identity = await getIdentity(git);
    checks.push({ name: 'Git identity', status: 'PASS', detail: `${identity.name} <${identity.email}>` });
  } catch {
    checks.push({ name: 'Git identity', status: 'WARN', detail: 'user.name / user.email not configured' });
  }

  // 5. .baton/ directory
  const paths = batonPaths(root);
  try {
    await fs.access(paths.dir);
    checks.push({ name: '.baton/ directory', status: 'PASS', detail: 'Exists' });
  } catch {
    checks.push({ name: '.baton/ directory', status: 'FAIL', detail: 'Not initialized — run "baton init"' });
    hasFail = true;
    process.exitCode = 1;
    return formatChecks(checks, hasFail);
  }

  // 6. state.json
  try {
    const state = await readState(root);
    checks.push({ name: 'state.json', status: 'PASS', detail: `holder: ${state.holder ?? 'none'}` });
  } catch (err) {
    checks.push({ name: 'state.json', status: 'FAIL', detail: (err as Error).message });
    hasFail = true;
  }

  // 7. tasks.json
  try {
    const tasks = await readTasks(root);
    checks.push({ name: 'tasks.json', status: 'PASS', detail: `${tasks.tasks.length} tasks` });
  } catch (err) {
    checks.push({ name: 'tasks.json', status: 'WARN', detail: (err as Error).message });
  }

  // 8. config.json
  try {
    const config = await readConfig(root);
    checks.push({ name: 'config.json', status: 'PASS', detail: `${config.participants.length} participants` });
  } catch (err) {
    checks.push({ name: 'config.json', status: 'FAIL', detail: (err as Error).message });
    hasFail = true;
  }

  // 9. Agent detection
  const agent = await detectAgent(root);
  if (agent) {
    checks.push({ name: 'Agent detected', status: 'PASS', detail: agent });
  } else {
    checks.push({ name: 'Agent detected', status: 'WARN', detail: 'No agent config found' });
  }

  // 10. Pre-commit hook
  const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
  try {
    await fs.access(hookPath);
    checks.push({ name: 'Pre-commit hook', status: 'PASS', detail: 'Installed' });
  } catch {
    checks.push({ name: 'Pre-commit hook', status: 'WARN', detail: 'Not installed — run "baton init --refresh-hook"' });
  }

  if (hasFail) process.exitCode = 1;
  return formatChecks(checks, hasFail);
}

function formatChecks(checks: CheckResult[], hasFail: boolean): string {
  const lines: string[] = [];
  lines.push('Baton Doctor');
  lines.push('');
  const maxName = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const status = check.status.padEnd(4);
    const name = check.name.padEnd(maxName);
    lines.push(`  ${status}  ${name}  ${check.detail}`);
  }
  lines.push('');
  if (hasFail) {
    lines.push('Result: FAIL — fix the issues above and re-run.');
  } else {
    lines.push('Result: PASS — baton is healthy.');
  }
  return lines.join('\n');
}
