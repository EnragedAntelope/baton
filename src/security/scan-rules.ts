/**
 * Gitleaks-style secret detection rules, kept as plain serializable data so
 * the generated pre-commit hook can embed an identical copy and run with
 * zero dependencies.
 */
export interface ScanRule {
  id: string;
  description: string;
  pattern: string; // RegExp source, applied per line with flags "g"
}

export const SCAN_RULES: ScanRule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    pattern: String.raw`\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key (keyword-gated)',
    pattern: String.raw`(?:aws|amazon)(?:.{0,30})?['"][0-9A-Za-z/+=]{40}['"]`,
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp/gho/ghu/ghs/ghr)',
    pattern: String.raw`\bgh[pousr]_[A-Za-z0-9]{36,255}\b`,
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token',
    pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{60,255}\b`,
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token',
    pattern: String.raw`\bglpat-[A-Za-z0-9_-]{20,}\b`,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}\b`,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key',
    pattern: String.raw`\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b`,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`,
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret/restricted key',
    pattern: String.raw`\b[sr]k_(?:test|live)_[0-9a-zA-Z]{10,}\b`,
  },
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    pattern: String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----`,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
  },
  {
    id: 'generic-assigned-secret',
    description: 'Hardcoded value assigned to a secret-looking name',
    pattern: String.raw`(?i)(?:api[_-]?key|secret|token|passw(?:or)?d)['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]`,
  },
];

/**
 * A match is ignored when the line also matches one of these — placeholders,
 * env-var references, and template syntax are exactly how handoffs are
 * SUPPOSED to mention secrets ("set STRIPE_KEY in your own .env").
 */
export const ALLOWLIST_PATTERNS: string[] = [
  String.raw`(?i)example|placeholder|your[-_ ]?(?:own[-_ ]?)?key|redacted|xxxx`,
  String.raw`\$\{?[A-Z][A-Z0-9_]*\}?`, // $VAR / ${VAR} references
  String.raw`\{\{.*\}\}`, // {{ template }}
  String.raw`<[^>]+>`, // <YOUR_KEY_HERE>
  String.raw`baton-allow-secret`, // explicit inline waiver comment
];
