# 🪃 Baton

**Pass-me-along AI coding.** Relay one project across several people's AI coding
subscriptions — Claude Code today, OpenCode tonight, Codex tomorrow morning —
without losing the plot between sessions.

> **State travels. Credentials never do.**

## The problem

Your group is building something with AI coding agents. Each of you has your own
subscription with its own limits — 5-hour windows, weekly caps, credit pools.
When your allowance runs dry mid-feature, today's "handoff" is a Discord message:

> *"uhh, I got the auth working I think? repo's pushed"*

The next person spends an hour rediscovering the plan, the conventions, the
dead ends you already hit. The agent context that made you productive died with
your session.

## What Baton does

Baton turns that into a clean relay:

```
alice (Claude Code)          bob (OpenCode)            carol (Codex)
      │                           │                          │
  baton pass ──── git ────▶ baton pickup … baton pass ─▶ baton pickup
      │                           │                          │
  5 min wrap-up               resumes in ~5 min          resumes in ~5 min
```

- **`baton pass`** — distills the session into a structured handoff
  (`.baton/HANDOFF.md` + task ledger), runs safety gates (tests pass, no
  secrets, clean tree), tags the pass, and releases the lock. One command.
- **`baton pickup`** — pulls, verifies the chain of custody, locks the baton to
  you, injects context into *your* agent (CLAUDE.md, AGENTS.md, or a
  copy-paste prompt), and prints a 10-line digest: branch, build state, next
  task, landmines. One command.
- **Git is the only infrastructure.** No server, no accounts, no new access
  control — if you can push to the repo, you can relay.

## Quick start

```bash
npm install -g baton-relay        # or: npx baton-relay

cd your-project                   # any git repo
baton init --test-cmd "npm test"  # scaffolds .baton/, installs secret-scan hook
git push

baton claim                       # take the baton, start working
# ... code with your agent ...
baton pass                        # wrap up: fills gates, tags, releases
```

Next person, on their machine:

```bash
git pull
baton pickup --agent claude-code  # or opencode | codex | generic
# paste the printed first-prompt into your agent — you're caught up
```

Add teammates to `.baton/config.json` (handle + git emails) so passes are
attributable.

## What's in `.baton/`

| File | What it is |
|---|---|
| `HANDOFF.md` | The current handoff narrative — regenerated each pass |
| `tasks.json` | Machine-readable task ledger (ids, statuses, deps) |
| `project.md` | Stable context: goals, stack, conventions, commands |
| `decisions.md` | Append-only log of decisions ("chose SQLite because…") |
| `state.json` | Who holds the baton, pass count, policies |
| `sessions/` | Archived handoffs from previous sessions |
| `hooks/` | The committed secret-scan pre-commit hook |

## Commands

| Command | What it does |
|---|---|
| `baton init` | Scaffold `.baton/`, seed `.gitignore`, install the secret-scan hook |
| `baton status` | Who holds it, branch state, open tasks |
| `baton claim` | Take the baton (refuses if someone holds a fresh lock) |
| `baton pass` | Validate handoff → run gates → tag → release → push |
| `baton pickup` | Pull → verify custody → claim → bootstrap your agent → digest |
| `baton steal` | Take a **stale** baton (12h+ default) — loudly audited |
| `baton log` | The pass history (chain of custody) |
| `baton task list/add/set` | Manage the task ledger by hand |
| `baton scan` | Scan `.baton/` for secrets on demand |

## Working with agents

`baton init` ships a **baton-pass skill** (`skills/baton-pass/SKILL.md`).
Tell your agent "pass the baton" and it distills the session into the handoff
format itself — statuses updated, decisions logged, rubric followed. `baton
pass` then validates the result; incomplete or secret-bearing handoffs are
rejected, so a lazy summary can't slip through.

On pickup, the adapter for your agent injects a pointer block into its native
context file (`CLAUDE.md` for Claude Code, `AGENTS.md` for OpenCode/Codex) so
every future session in that clone starts baton-aware.

Not in an agent session? `baton pass --auto` (experimental) invokes your agent
CLI headlessly (`claude -p`, `opencode run`, `codex exec`) to fill the handoff
template from the repo's recent history, then continues the pass. It refuses to
run from *inside* an agent session — the agent that did the work writes a
better handoff than a cold one — and falls back to the manual template if the
CLI isn't available.

## Security model (the short version)

- **No credential ever travels.** Baton never reads, stores, or proxies LLM
  provider keys, tokens, or sessions. Sharing those violates provider ToS and
  is the explicit non-goal this tool exists to avoid.
- **Secrets can't ride along.** A committed, dependency-free pre-commit hook
  plus a pass-time scan block AWS/GitHub/OpenAI/Anthropic/Stripe/private-key
  patterns (and generic `secret = "…"` assignments) in `.baton/` files.
  Handoffs reference secrets by *name only* — "set STRIPE_KEY in your .env".
- **Tamper-evident custody.** Every pass is an annotated git tag
  (`baton/pass/N`, signed if you have signing configured). `baton pickup`
  verifies the chain and refuses broken ones; `baton log` walks it.
- **Handoffs are data, not instructions.** The pickup prompt explicitly frames
  prior users' text as content to evaluate — a guardrail against prompt
  injection by a compromised participant. Relay with people you trust.

## Why not just share one account?

Because it violates Anthropic's, OpenAI's, and Google's ToS; it destroys
auditability (whose prompt caused the incident?); and one member's compromised
laptop burns everyone's access. Baton exists so the relay works *without* it.

## Limits & roadmap

- The MVP lock is **advisory**: two simultaneous claims race on a git push, and
  the loser gets a clear "held by alice" message within seconds. Fine for
  2–6 person relays; an atomic claim server (+ Discord notifications + web
  dashboard) is the planned v2.
- Adapters today: Claude Code, OpenCode, Codex, generic. More welcome.

## Development

```bash
npm install
npm test            # vitest — includes full two-machine relay integration tests
npm run typecheck
npm run build
```

MIT licensed. PRs welcome — except anything that touches provider credentials,
which will be closed on sight (see CONTRIBUTING.md).
