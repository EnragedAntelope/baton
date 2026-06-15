import { spawn } from 'node:child_process';
import { AgentName } from '../types.js';
import { BatonError } from './files.js';

/**
 * Headless invocation of the holder's coding agent so
 * "baton pass --auto" can have the agent fill the handoff template itself.
 *
 * Reliability varies by agent and version (this was the spike flagged in the
 * implementation plan), so every path degrades to the manual template flow.
 * The prompt always travels via stdin: agent CLIs on Windows are .cmd shims
 * that need a shell, and shell-quoting a multi-line prompt is how injection
 * bugs are born. Argument lists stay fixed literals.
 */
export interface AgentCommand {
  command: string;
  args: string[];
}

export function buildAgentCommand(agent: AgentName): AgentCommand | null {
  switch (agent) {
    case 'claude-code':
      // -p reads the prompt from stdin; acceptEdits lets it write .baton files.
      return { command: 'claude', args: ['-p', '--permission-mode', 'acceptEdits'] };
    case 'opencode':
      return { command: 'opencode', args: ['run'] };
    case 'codex':
      // "-" = read prompt from stdin; workspace-write so it can edit .baton/.
      return { command: 'codex', args: ['exec', '--sandbox', 'workspace-write', '-'] };
    case 'gemini':
      // gemini -p reads the prompt from stdin.
      return { command: 'gemini', args: ['-p'] };
    case 'antigravity':
      // antigravity is the rebrand of gemini-cli; same -p stdin semantics.
      return { command: 'antigravity', args: ['-p'] };
    case 'generic':
      return null;
  }
}

/**
 * Detect that baton is already running INSIDE an agent session. Spawning a
 * second, cold agent from within one is never what the user wants — the
 * session that did the work should write the handoff itself.
 */
export function detectAgentSession(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.OPENCODE || env.OPENCODE_SERVER) return 'opencode';
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return 'codex';
  if (env.GEMINI_CLI_SESSION) return 'gemini';
  return null;
}

export interface InvokeOptions {
  timeoutMs?: number;
}

export interface InvokeResult {
  ok: boolean;
  detail: string;
}

export function invokeAgent(
  cmd: AgentCommand,
  prompt: string,
  cwd: string,
  options?: number | InvokeOptions,
): Promise<InvokeResult> {
  const opts: InvokeOptions =
    typeof options === 'number' ? { timeoutMs: options } : options ?? {};
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    // shell:true on Windows resolves .cmd shims; safe because args are fixed
    // literals and the prompt goes through stdin, never the command line.
    const child = spawn(cmd.command, cmd.args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    // Timeout using Promise.race (more reliable than spawn's built-in timeout —
    // we explicitly kill on timeout so orphans can't outlive the invocation).
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new BatonError(`Agent invocation timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    // Swallow stdin stream errors (EPIPE/ENOENT): the 'error'/'close' handlers
    // below already report the failure; an unhandled stream error would crash.
    child.stdin.on('error', () => {});

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        ok: false,
        detail: `could not start "${cmd.command}": ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      if (code !== 0) {
        // Surface stderr when available — it often carries the actionable error.
        const failureOutput = stderr.trim() || stdout;
        const tail = failureOutput.split('\n').slice(-10).join('\n').trim();
        resolve({
          ok: false,
          detail: `"${cmd.command}" exited with ${code}${tail ? `\n${tail}` : ''}`,
        });
        return;
      }

      // Validate output: must be non-empty and contain markdown-like content.
      const output = stdout.trim();
      if (!output || output.length === 0) {
        resolve({ ok: false, detail: 'Agent returned empty output' });
        return;
      }
      const hasMarkdown = /[#*\-]/.test(output);
      if (!hasMarkdown) {
        resolve({ ok: false, detail: 'Agent returned invalid output (non-text or binary garbage)' });
        return;
      }

      const tail = output.split('\n').slice(-10).join('\n').trim();
      resolve({ ok: true, detail: tail });
    });

    child.stdin.end(prompt);
  });
}

/** The prompt given to a headless agent to complete the handoff template. */
export function buildFillPrompt(): string {
  return `You are completing a Baton relay handoff non-interactively. Baton relays this
project between people; the next person resumes from .baton/ files alone.

Do exactly this, modifying ONLY files inside .baton/:

1. Read .baton/HANDOFF.md — a template containing "_(fill me in)_" placeholders.
   Keep its "# Handoff — …" header line EXACTLY as it is.
2. Reconstruct the recent session from the repository: git log since the last
   baton/pass/* tag (or the last few commits), the current branch and status,
   and .baton/tasks.json. Read .baton/project.md for stable context.
3. Rewrite .baton/HANDOFF.md replacing EVERY placeholder with real, specific
   content per its section headings. In "Branch & build state", run the test
   command from .baton/config.json (commands.test) if one is set and report
   real numbers.
4. Update .baton/tasks.json: correct the status of tasks the recent commits
   completed or progressed ("todo" | "in-progress" | "blocked" | "done" |
   "dropped"), update "updatedAt" (ISO 8601), keep the JSON schema-valid.
5. NEVER write a secret value (API keys, tokens, passwords) into any .baton/
   file. Reference secrets by name only, e.g. "needs STRIPE_KEY in your .env".

Do not commit, push, or run any baton command — the CLI takes over after you.`;
}
