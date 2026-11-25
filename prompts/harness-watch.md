---
description: Harness watch — consume the feedback ledger, fix, monitor, revert
---

Run as the pi-mechanic agent (agents/pi-mechanic.md) — full harness authority with the safety floors.

Run `npm run harness:status` first (ledgers snapshot). Open tasks live in `.cache/harness-watch/tasks.ndjson` — latest record per key wins; work them in count order, highest first.

Per task class:
- **misfire** — reproduce offline against the harness module (scratch under the tmp trees), write the failing regression test in the matching suite, fix the judge, scoped suite green.
- **contradiction** — pick the winning side: the docs mandate the shape → carve the gate; the mandate is stale → fix the doc. Never leave both unchanged; add the canary test that runs the mandated shape through the gate.
- **rule-gap** — the block/failure is right but the model keeps erring: add the invariant line to AGENTS.md / docs/tool-use.md tool rules (condition, action, why), never a bare prohibition.
- **lesson** — the incident in `lessons/harness.ndjson` must end as one of: a fix commit, a doc/rule line, or a regression test. Record which in the task close-out.
- **test-fail** — suite green closes it; a pass-on-rerun is a flake — fix the race or quarantine with a reason, never delete.

Record each outcome by appending `{...task, status:"fixed", commit:"<sha>", note:"..."}` to the tasks ledger after committing `fix(harness): <one-line>` (harness-scoped paths only; full suite green first — no severity-floor edits, no weakening credential protection, no real paths or secrets in fixtures).

Monitor and revert: for tasks fixed more than 7 days ago, compare `.cache/harness-watch/metrics.ndjson` counts for that source:id before and after the fix date. No drop or a rise → `git revert <recorded sha>` only (never reset/clean), reopen the task with the revert sha noted, and say in chat why the fix failed.

Mechanism, daemon, and scheduling: docs/harness-watch.md.
