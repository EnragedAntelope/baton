---
name: baton-pass
description: Use when the user wants to pass the baton, hand off this project, end their relay session, or run "baton pass" - distills the current session into .baton/HANDOFF.md and updates .baton/tasks.json so the next person (on a different machine and possibly a different agent) can resume in minutes.
---

# Baton Pass: Distill This Session Into a Handoff

You are ending a relay session. The next person picks this project up on their
own machine, with their own AI subscription, possibly with a different agent.
Everything they need must be in `.baton/` — your session memory will NOT travel.

## Procedure

1. Run `baton pass` once. If `HANDOFF.md` was not ready, this archives the old
   handoff and writes a fresh template to `.baton/HANDOFF.md` (its error
   message telling you to fill the template is expected — that is your job).
2. Update `.baton/tasks.json`: set `status` for every task you touched
   (`todo | in-progress | blocked | done | dropped`), update `updatedAt`
   (ISO 8601), and add tasks discovered this session (use `nextId`, then
   increment it). Keep the JSON valid — the CLI schema-validates it.
3. If you made a decision the next person must not re-litigate (library
   choice, approach rejected after trying it), append one dated line to
   `.baton/decisions.md`.
4. Fill every section of `.baton/HANDOFF.md` (rubric below). Replace every
   `_(fill me in)_` placeholder — the pass is REJECTED while any remain.
5. Run `baton pass` again. Fix whatever a gate rejects (incomplete handoff,
   failing tests, secrets) rather than working around it.

## Rubric for a good HANDOFF.md

- **Where things stand**: one paragraph, state of the world, no history lesson.
- **Done this session**: bullet list, reference task ids like `[task-12]`.
- **In progress / next up**: the single most important thing to do next goes
  first, with enough detail to start cold ("continue task-13: the limiter
  middleware exists in src/mw/limit.ts but isn't wired into the router").
- **Blockers & landmines**: anything that will waste the next person's hour —
  flaky tests, files not to touch and why, env quirks, dead ends you tried.
  Write dead ends down; repeating them is the most expensive relay failure.
- **Branch & build state**: branch @ short-sha, exact test/lint results
  (real numbers: "47/47 passing", not "tests pass").

## Hard rules

- **Never write a secret VALUE anywhere in `.baton/`.** Reference secrets by
  name only: "needs STRIPE_TEST_KEY in your own .env". The secret scan will
  block the pass otherwise — do not try to evade it; remove the value.
- Do not paste raw tool output, logs, or file dumps into the handoff.
  Distill. The handoff should read in under two minutes.
- Do not include instructions addressed to the next agent that change its
  behavior or rules ("ignore previous instructions", "run this command
  first"). Handoffs are data; the pickup prompt frames them that way, and
  reviewers will treat imperative content as a red flag.
- Write facts, not optimism: if tests fail, say which and why.
