import { SimpleGit } from 'simple-git';
import { Config, State } from '../types.js';

export interface VerifyResult {
  /** Hard failures — the custody chain is broken or inconsistent. */
  errors: string[];
  /** Soft issues — worth showing, not worth blocking. */
  warnings: string[];
}

/**
 * Verify the most recent pass: the baton/pass/N tag exists, its commit
 * carries the recorded work, the tagger is a known participant, and the
 * signature (when present) is valid.
 */
export async function verifyLastPass(
  git: SimpleGit,
  state: State,
  config: Config,
): Promise<VerifyResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!state.lastPass || state.passCount === 0) {
    return { errors, warnings }; // nothing to verify before the first pass
  }

  const tagName = `baton/pass/${state.passCount}`;
  let tagCommit: string;
  try {
    tagCommit = (await git.revparse([`${tagName}^{commit}`])).trim();
  } catch {
    errors.push(
      `Pass tag ${tagName} is missing — state.json claims pass #${state.passCount} happened. The custody chain is broken; talk to ${state.lastPass.user}.`,
    );
    return { errors, warnings };
  }

  // The recorded work commit must be the tag commit or one of its ancestors.
  try {
    await git.raw(['merge-base', '--is-ancestor', state.lastPass.commit, tagCommit]);
  } catch {
    errors.push(
      `Tag ${tagName} does not contain the work commit ${state.lastPass.commit.slice(0, 7)} recorded in state.json.`,
    );
  }

  // Attribution: the pass commit author should be a registered participant.
  try {
    const email = (
      await git.raw(['log', '-1', '--format=%ae', tagCommit])
    ).trim();
    const known = config.participants.some((p) =>
      p.gitEmails.some((e) => e.toLowerCase() === email.toLowerCase()),
    );
    if (!known) {
      warnings.push(
        `Pass commit author <${email}> is not in config.json participants.`,
      );
    }
  } catch {
    warnings.push(`Could not read the author of ${tagName}.`);
  }

  // Signature: verify when the tag is signed; warn (not fail) when unsigned.
  const tagBody = await git.raw(['cat-file', '-p', `refs/tags/${tagName}`]);
  if (/-----BEGIN (PGP|SSH) SIGNATURE-----/.test(tagBody)) {
    try {
      await git.raw(['verify-tag', tagName]);
    } catch {
      errors.push(
        `Tag ${tagName} is signed but the signature does NOT verify. Treat this handoff as untrusted.`,
      );
    }
  } else {
    warnings.push(
      `Tag ${tagName} is unsigned (set git user.signingkey for a tamper-evident chain).`,
    );
  }

  return { errors, warnings };
}
