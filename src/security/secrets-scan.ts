import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALLOWLIST_PATTERNS, SCAN_RULES } from './scan-rules.js';

export interface Finding {
  file: string;
  line: number;
  ruleId: string;
  description: string;
  /** Redacted preview — never the full matched secret. */
  preview: string;
}

// JS RegExp has no inline (?i); translate gitleaks-style sources.
function compile(source: string): RegExp {
  if (source.startsWith('(?i)')) {
    return new RegExp(source.slice(4), 'gi');
  }
  return new RegExp(source, 'g');
}

const COMPILED_RULES = SCAN_RULES.map((r) => ({ ...r, regex: compile(r.pattern) }));
const COMPILED_ALLOWLIST = ALLOWLIST_PATTERNS.map((p) => compile(p));

export function redact(match: string): string {
  if (match.length <= 8) return '********';
  return `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`;
}

export function scanText(content: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (COMPILED_ALLOWLIST.some((a) => (a.lastIndex = 0, a.test(line)))) return;
    for (const rule of COMPILED_RULES) {
      rule.regex.lastIndex = 0;
      const match = rule.regex.exec(line);
      if (match) {
        findings.push({
          file,
          line: idx + 1,
          ruleId: rule.id,
          description: rule.description,
          preview: redact(match[0]),
        });
      }
    }
  });
  return findings;
}

/** Scan a set of files on disk (paths relative to root). */
export async function scanFiles(
  root: string,
  files: string[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(root, file), 'utf8');
    } catch {
      continue; // deleted or unreadable — nothing to scan
    }
    findings.push(...scanText(content, file));
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  const lines = findings.map(
    (f) =>
      `  ${f.file}:${f.line}  [${f.ruleId}] ${f.description} — ${f.preview}`,
  );
  return [
    `Secret scan found ${findings.length} potential secret(s):`,
    ...lines,
    '',
    'Handoffs must reference secrets by NAME only ("set STRIPE_KEY in your .env"),',
    'never by value. Remove the value, or append "baton-allow-secret" to the line',
    'if this is a confirmed false positive.',
  ].join('\n');
}
