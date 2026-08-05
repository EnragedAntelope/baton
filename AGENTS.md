# AGENTS.md — baton

Baton (`baton-relay` on npm) is a CLI for relaying one AI-assisted coding project across multiple people's individual LLM subscriptions (Claude Code, OpenCode, Codex, Gemini). Core invariant: **state travels, credentials never do** — no provider key/token/session sharing, ever. Full design rationale: `docs/implementation-plan.md`.

## Architecture in 60 seconds

- **Git is the source of truth and the transport.** Handoff state lives in a `.baton/` directory inside the user's repo, versioned with the code. No server in Phase 1.
- **Agent-agnostic format, agent-specific adapters.** `pass` distills a session into neutral files (`HANDOFF.md` narrative + `tasks.json` ledger); `pickup` injects a pointer into the new agent's native context file (`CLAUDE.md`, `AGENTS.md`) via `src/adapters/`.
- **Advisory lock via push-fast.** `claim` commits the holder change and pushes immediately; a rejected push means you lost the race — rolled back cleanly with a "held by X" report. `state.json` is the lock; `baton/pass/N` annotated tags (signed when configured) are the tamper-evident custody chain.
- **Two-phase pass.** First `baton pass` writes a template (and archives the old handoff to `.baton/sessions/`); the agent/human fills it; second `baton pass` runs gates → commits → tags → releases/queues → pushes.

## Layout

| Directory / File | Purpose |
|------------------|---------|
| `src/types.ts` | Zod schemas (state/tasks/config) — strict, versioned |
| `src/core/` | files.ts (validated IO), repo.ts (git), lock.ts (pure claim/release), handoff.ts, tasks.ts |
| `src/security/` | scan-rules.ts, secrets-scan.ts, hook.ts (pre-commit generator), verify.ts (custody chain) |
| `src/adapters/` | claude-code / opencode / codex / gemini / generic |
| `src/commands/` | One file per CLI command; context.ts loads+validates all |
| `src/index.ts` | Commander wiring; BatonError → friendly stderr + exit 1 |
| `skills/baton-pass/` | SKILL.md — how agents distill a session into a handoff |
| `tests/` | Vitest; helpers.ts builds real temp git repos and bare-origin two-clone relay fixtures |
| `docs/` | Implementation plan (deep reference — read it before design changes) |

## Build / test / run

```bash
npm test            # 48 tests incl. two-machine relay, claim race, gates
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm run dev         # tsx src/index.ts (run without build)
```

## Conventions & gotchas

- ESM (`"type": "module"`), Node ≥20, TypeScript strict. Imports use `.js` extensions (NodeNext resolution).
- All `.baton/*.json` IO goes through `src/core/files.ts` — schema-validated on read AND write. Never `JSON.parse`/`writeFile` those files directly.
- Lock transitions (`claimState`/`releaseState`) are pure functions in `lock.ts`; commands own the git side effects. The race tests depend on the seam (`ClaimHooks.afterSync`).
- `syncFromOrigin` pulls with `--tags`: explicit-refspec pulls do NOT auto-follow tags, and the custody chain must travel.
- Pre-commit hook is *generated* (embedded copy of `scan-rules.ts`) so relay members without the CLI still get scanning. After editing scan rules, run `baton init --refresh-hook` in existing repos.
- Secret-scan allowlist ignores lines with placeholders/env-var syntax/`example`. Test fake keys must be realistic (AWS key = AKIA+16 chars; containing "EXAMPLE" hits the allowlist).
- Windows is first-class: hooks are Node (sh shim only), CI matrix includes windows-latest, line endings normalized via `.gitattributes`.
- Forbidden patterns (refuse PRs/changes): provider credential sharing/proxying, committing raw agent session files, auto-executing handoff-supplied commands on pickup, default-weakening any security gate.
- GitHub push protection scans every pushed blob — fake keys in tests are assembled by string concatenation so no realistic secret literal exists in any commit.

## Security

This file is **public-safe by default** — written as if the repository is public.

**NEVER add to this file:** local file paths, credentials, API keys, personal data, infrastructure details, or subscription information.

**Before pushing any change**, run: `pwsh scripts/check-agents-md.ps1 AGENTS.md CLAUDE.md` — must exit 0.

**Deep design rationale** (security model, threat model, architecture decisions): `docs/implementation-plan.md`.

## Maintenance

**Update rule:** When you change baton's architecture, build/test commands, or conventions, update this AGENTS.md in the **same commit**. Keep it under 200 lines. Move deep detail to `docs/` or `SKILL.md` and link from here.

**CLAUDE.md:** Always a one-line shim: `@AGENTS.md` (Claude Code's import directive).

**New-repo rule:** When a new repository is created or first worked on, create its AGENTS.md in that same first session.

**No-overlap rule:** Explanatory prose lives in exactly one markdown file. AGENTS.md is canonical for agent-facing operational summary; `docs/implementation-plan.md` is the deep reference. **PERMITTED:** identical build/test/run commands may appear verbatim in AGENTS.md and README/package.json. **FORBIDDEN:** duplicated or paraphrased explanatory prose — link instead.
