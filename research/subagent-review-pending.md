# Pending review — subagent improvement stretch

Status: **PENDING** review (marked at commit time; reviewer may still be in flight on the originating device).

Gate state at marker: `test:subagents` 3319/3319, fail 0; typecheck clean; no `build` script exists in this repo (leg skipped, not failed).

Scope to review: commits `9468063..HEAD` — review nits `9468063`, control verbs `8f98b35`, injection artifact refs `1008d91`, baselines + duplicate-spawn `d1125e5`, plus the docs commit carrying this marker. The earlier stretch (`d9d8c8a`..`ebf723b`) was already review-4 APPROVED.

Re-run from any device — spawn a read-only reviewer with this focus list:

1. Control-verb races: `cancelledAt` vs pane-loss auto-restart and racing loss-synthesis; queued-cancel slot parity + reservation release; scope-lock release strictly via the delivery funnel (no hand-release).
2. Baseline math: nearest-rank p90; `<3` usable rows → no baseline; trailing `-N` agent-name strip; cost-segment omission; one stat-cached `readRecentResults(…, 20)` per spawn.
3. Duplicate-spawn heuristic: task-vs-summary matching (containment ≥40 normalized chars / Jaccard ≥0.8) — false-positive cost on legitimate re-spawns; warn-only.
4. Injection artifact refs: `[id <id> @ <path>]` rendered inside the 1200-char cap and ≤2-of-20 picking; `historyPath` wiring at the `index.ts` caller.
5. Known follow-up to judge (should-fix vs follow-up): widen `InboxRecord.synthesized` to remove the `persistResultRecord` boundary cast (documented in-code near `8f98b35`).
6. Docs claims vs code: control-verbs / live-metrics sections in `docs/subagents.md` and `extensions/subagents/README.md`; executor-doctrine edits under `agents/`.

Accepted, do not flag: 3 pre-existing file-level test marks (fake-tmux isolation hang predating this stretch); live metrics intentionally lack files-touched / last-write-age (descoped).

In-flight at marker time: reviewer wave `review-final` (its incremental draft: `/tmp/review-final.md` on the originating device only). Local wave ledger: `.cache/waves.ndjson`.
