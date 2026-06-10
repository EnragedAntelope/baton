# CLAUDE.md — Baton

Baton relays one AI-assisted coding project across multiple people's individual
LLM subscriptions. Core invariant: **state travels, credentials never do** —
no provider key/token/session sharing, ever, in any form. The full design
rationale lives in `docs/implementation-plan.md`.

## Architecture in 60 seconds

- **Git is the source of truth and the transport.** Handoff state lives in a
  `.baton/` directory inside the *user's* repo, versioned with the code.
  No server in Phase 1.
- **Agent-agnostic format, agent-specific adapters.** `pass` distills a session
  into neutral files (`HANDOFF.md` narrative + `tasks.json` ledger); `pickup`
  injects a pointer into the new agent's native context file (`CLAUDE.md`,
  `AGENTS.md`) via `src/adapters/`.
- **Advisory lock via push-fast.** `claim` commits the holder change and pushes
  immediately; a rejected push means you lost the race — rolled back cleanly
  with a "held by X" report. `state.json` is the lock; `baton/pass/N` annotated
  tags (signed when configured) are the tamper-evident custody chain.
- **Two-phase pass.** First `baton pass` writes a template (and archives the
  old handoff to `.baton/sessions/`); the agent/human fills it; second
  `baton pass` runs gates → commits → tags → releases/queues → pushes.

## Layout

```
src/types.ts          zod schemas (state/tasks/config) — strict, versioned
src/core/             files.ts (validated IO), repo.ts (git), lock.ts (pure
                      claim/release transitions), handoff.ts, tasks.ts
src/security/         scan-rules.ts (serializable gitleaks-style rules),
                      secrets-scan.ts, hook.ts (generates the standalone
                      pre-commit script committed into .baton/hooks/),
                      verify.ts (custody chain checks)
src/adapters/         claude-code / opencode / codex / generic
src/commands/         one file per CLI command; context.ts loads+validates all
src/index.ts          commander wiring; BatonError → friendly stderr + exit 1
skills/baton-pass/    SKILL.md — how agents distill a session into a handoff
tests/                vitest; helpers.ts builds real temp git repos and a
                      bare-origin two-clone relay fixture (no mocked git)
```

## Conventions & gotchas

- ESM (`"type": "module"`), Node ≥20, TypeScript strict. Imports use `.js`
  extensions (NodeNext resolution).
- All `.baton/*.json` IO goes through `src/core/files.ts` — schema-validated on
  read AND write. Never `JSON.parse`/`writeFile` those files directly.
- Lock transitions (`claimState`/`releaseState`) are pure functions in
  `lock.ts`; commands own the git side effects. Keep it that way — the race
  tests depend on the seam (`ClaimHooks.afterSync`).
- `syncFromOrigin` pulls with `--tags`: explicit-refspec pulls do NOT
  auto-follow tags, and the custody chain must travel. Don't "simplify" this.
- The pre-commit hook is *generated* (embedded copy of `scan-rules.ts`) so
  relay members without the CLI still get scanning. After editing scan rules,
  the hook template in `hook.ts` picks them up automatically (it serializes
  `SCAN_RULES` at init) — but existing repos need `baton init --refresh-hook`.
- Secret-scan allowlist intentionally ignores lines with placeholders/env-var
  syntax/`example` — handoffs SHOULD say "set FOO_KEY in your .env". Test fake
  keys must be realistic (an AWS key is exactly AKIA+16 chars; containing
  "EXAMPLE" hits the allowlist).
- Windows is a first-class target: hooks are Node (sh shim only), CI matrix
  includes windows-latest, line endings normalized via `.gitattributes`.
  This dev machine sets `safe.bareRepository=explicit` — don't run git
  *inside* bare test repos; use `ls-remote` from a clone instead.
- Forbidden patterns (refuse PRs/changes): provider credential
  sharing/proxying, committing raw agent session files, auto-executing
  handoff-supplied commands on pickup, default-weakening any security gate.

## Verification

```bash
npm test            # 40 tests incl. two-machine relay, claim race, gates
npm run typecheck
npm run build && node dist/index.js --help
```

## Status

### Done (Phase 1 — MVP, git-only)

1. ✅ Schemas + fixtures (`types.ts`, round-trip tests)
2. ✅ `init` (scaffold, .gitignore seeding, hook install) + `status`
3. ✅ `claim` / `pass` / `pickup` with generic adapter; race + relay
   integration tests across two clones and a bare origin
4. ✅ Secret scan + policy gates (planted AWS key blocks both commit and pass;
   test gate runs `commands.test` from config.json; `--skip-tests` recorded)
5. ✅ baton-pass skill (`skills/baton-pass/SKILL.md`) + Claude Code/OpenCode/
   Codex adapters (pointer-block injection, idempotent)
6. ✅ `steal` (stale-only, audited in decisions.md), `log`, signed-tag verify
   on pickup (`--force` override is loud)
7. ✅ CI: GitHub Actions matrix (ubuntu/windows/macos × Node 20/22)
8. ✅ Bonus: `task list/add/set`, `scan` commands

### Remaining

- **Phase 1 spike (flagged in plan):** non-interactive agent invocation from
  `baton pass` (`claude -p`, `opencode run`) so the CLI can trigger the
  baton-pass skill itself instead of instructing the user. Currently the
  two-phase template flow covers this manually.
- **Phase 2:** coordination server — atomic claim API (Postgres/Redis lock),
  GitHub OAuth, queue + Discord webhook notifications, read-only dashboard.
- **Phase 3:** allowance-aware checkpoint nudges, Gemini adapter,
  `baton doctor`, `baton compact` (squash session archives).
- Publish to npm (`baton-relay`); set up a GitHub repo + branch protection.
- Real-world dogfood: relay this repo's own development via Baton.
