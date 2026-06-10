# Contributing to Baton

Thanks for helping! A few ground rules keep this project what it is.

## The hard line: no credential features

Baton's core design decision is **state travels, credentials never do**.
PRs that add any form of LLM provider credential sharing, proxying, pooling,
session-token transport, or "bring your friend's API key" convenience — even
behind a flag — will be closed without discussion. This is a ToS, security,
and auditability boundary, not a missing feature.

Related forbidden patterns:

- Committing raw agent session files into `.baton/` (they leak env dumps).
- Auto-executing commands sourced from handoff files on pickup.
- Weakening the secret scan to "warn only" by default.

## What's welcome

- New agent adapters (`src/adapters/`) — follow the pointer-block pattern.
- Better secret-scan rules (`src/security/scan-rules.ts`) with tests for both
  detection *and* the name-only/placeholder allowlist.
- Cross-platform fixes. CI runs Windows, macOS, and Linux; all must stay green.
- v2 groundwork (claim server, notifications) — open an issue first.

## Workflow

```bash
npm install
npm test          # full suite, includes two-machine relay integration tests
npm run typecheck
```

- Tests accompany every behavior change. Integration tests use real temp git
  repos (see `tests/helpers.ts`) — no mocked git.
- Keep `dist/` out of commits; it's built on publish.
- Conventional, descriptive commit messages; one logical change per commit.
