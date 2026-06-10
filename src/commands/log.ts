import { loadContext } from './context.js';

/** Walk the baton/pass/* tag chain — the relay's chain of custody. */
export async function logCommand(cwd: string): Promise<string> {
  const ctx = await loadContext(cwd);
  const raw = await ctx.git.raw([
    'for-each-ref',
    '--sort=v:refname',
    '--format=%(refname:short)%09%(creatordate:iso-strict)%09%(subject)',
    'refs/tags/baton/pass/*',
  ]);
  const rows = raw.split('\n').filter(Boolean);
  if (rows.length === 0) {
    return 'No passes yet. The chain starts with the first "baton pass".';
  }
  const lines = rows.map((row) => {
    const [ref, date, subject] = row.split('\t');
    return `${ref}  ${date}  ${subject}`;
  });
  if (ctx.state.lastPass) {
    lines.push(
      `\nCurrent: ${ctx.state.holder ? `held by ${ctx.state.holder}` : 'free'} — last pass by ${ctx.state.lastPass.user}`,
    );
  }
  return lines.join('\n');
}
