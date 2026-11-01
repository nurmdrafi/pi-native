# Pending review — subagent improvement stretch

Status: **RESOLVED** — stretch reviewed APPROVED (`review-final-2`); follow-ups applied (`fix-drain`, `worker-followups`); final uncommitted delta re-reviewed APPROVED (`/tmp/review-main.md`). Resolution record at the bottom.

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

Resolution record (2026-11-01):

1. Gate regression found post-marker: `tests/subagents/scope-locks.test.ts:354` failed
   deterministically on re-run devices — `watchSubagent` awaited `pollForExit` bare,
   so an abort mid-tmux-round-trip settled only on the next ~1s poll tick, past
   the 700ms window (green on the fast originating host). Fixed via
   `raceAbortSignal()` in `index.ts`.
2. Item 5 applied: `InboxRecord.synthesized` widened to `cancelled_by_parent`;
   boundary cast dropped at `index.ts`.
3. Item 6 applied: `past p90 (Nm)` flag, spawn-ack `typical for` baseline line,
   duplicate warn note documented in `extensions/subagents/README.md` and
   `docs/subagents.md`; stale "30 s grace" corrected to 10 s (budget.ts:35).
4. Adjacent device-drift fix (user-reported): dashboard UI is a gitignored
   `dashboard/dist` build — `scripts/bootstrap.sh` and `scripts/after-pull.sh`
   now build it; `dashboard/package-lock.json` committed for pin parity.

Final gate: `test:subagents` 3319/3319, fail 0; typecheck clean; no `build`
script exists in this repo (leg skipped, not failed). Review archive on the
resolving device: `/tmp/review-final-2.md` (stretch), `/tmp/review-main.md`.
Local wave ledger: `.cache/waves.ndjson`.
