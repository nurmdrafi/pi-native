# Harness Telemetry Improvements Plan

**Status:** Planning only — no implementation without approval.
**Date:** 2026-11-17
**Source:** `logs/pi-sessions-2026-11-10.csv` (7-day session telemetry) + code inspection.

## 1. Summary

Four workstreams derived from the telemetry, sequenced by ROI and dependency:

| # | Workstream | Problem | Root cause | Fix class |
|---|---|---|---|---|
| W1 | Reliability | R11 never fires (0 blocks despite a 6-failure session) | per-turn streak reset | mutation-aware reset |
| W2 | Compliance | readerBypass 107 warns; severity tuning ineffective | non-enforced note + config/code desync | fail-closed block |
| W3 | Waste | pibash = 64% of tool spend | shell-based search/read habits | bash economy + enforcement |
| W4 | Latency | subagent spawn-to-first-msg 399s tail | heavy spawn path | investigate → optimize |

## 2. Key metrics (baseline)

- Tool spend total $43.79: pibash $27.93 (2670 calls, 64%), piread $7.55 (925), piedit $6.66 (522).
- Gate warns: readerBypass 107, searchReplaceFlag 42, editRegionGuard 12, reReadConsume 10.
- Gate blocks: destructiveConfirm 38 (expected safety), reReadGuard 18, loopGuard 1.
- Subagent spawn-to-first-msg: sentry-triage 399s; p50 24–49s across agents.
- Failure streaks: one session max 6 (7 calls); R11 reported 0 blocks / 0 warns.

## 3. W1 — Reliability: R11 failure-loop under-fires

### Problem
`failureLoopGuard` (R11) is configured `error` (`config.json:34`) but the CSV reports 0 blocks / 0 warns, while one session logged `maxFailureStreak=6`.

### Root cause
R11 blocks only when `turn.lg1ErrStreak >= FAILURE_LOOP_AT (5)` AND `turn.mutationSeq === turn.lg1ErrMutSeq` (`index.ts:289-299`). But `resetTurnParts` clears `lg1ErrStreak` and `lg1ErrMutSeq` (`turn-state.ts:92-93`) and runs at every `before_agent_start` (`index.ts:603`) and compaction (`index.ts:1725`). A failure streak spanning user turns therefore never reaches 5. The session-level `maxFailureStreak` (from the pi host) spans turns, so it diverges from the per-turn counter.

### Fix
Make the failure streak mutation-aware instead of turn-bound:
- Stop clearing `lg1ErrStreak` and `lg1ErrMutSeq` in `resetTurnParts`; keep `lg1ErrNoted` and the LG1 churn counters reset per turn.
- `lg1RecordResult` already resets the streak on a non-error result (`turn-state.ts:134-137`) and snapshots `lg1ErrMutSeq = mutationSeq` at streak start (`:138`), so the "no landed change" comparison stays correct across turns.
- Result: 5+ consecutive failures with no landed mutation trip R11 regardless of how many user turns intervene; a landed mutation (successful mutating bash/edit/write) still clears it.

### Tests (TDD)
1. Add a repro to `tests/gate/cases/rules/failureLoopGuard.mjs`: 6 failing bash results interleaved with `before_agent_start` (turn) events and no mutation → assert R11 blocks the next shell call. Watch it fail (current code resets the streak at each turn).
2. Negative: 4 failures, then one landed mutation, then more failures → assert no R11 block.
3. Negative: fewer than 5 failures across turns → no block.

### Verify
- Scoped gate tests pass; re-export telemetry and confirm R11 blocks > 0 for the repro session.

## 4. W2 — Compliance: readerBypass (SE2) permanent fix

### Problem
`readerBypass` fires 107 warns — agents read files via `cat`/`sed -n` in pibash instead of piread. Severity tuning (`warn`/`off`) does not change behavior, because both are non-blocking notes. Config says `SE2: "off"` (`config.json:32`) yet 107 warns fire — a desync.

### Root cause
Two coupled issues:
1. **Non-enforcement**: `readerBypassCheck` returns a note and `enforce("readerBypass", …)` (`index.ts:1107-1110`) routes it to `warnCall` for any non-`error` severity (`enforce`, `index.ts:328-344`). Notes teach but do not stop.
2. **Config/code desync**: the `enforce` call site has no `ruleEnabled` guard, so `"off"` still emits a warn — the config surface lies about this rule.

### Permanent solution (structural, not severity tuning)
1. **Fail-closed block**: set `SE2` to `error` so read-position `cat`/`sed -n` in pibash is blocked with a reason naming the piread equivalent (offset/limit for ranges, hits for search+context, outline for symbols). Mirrors P1/P2/P3, which block native read/bash/write to force the native tools.
2. **Close capability parity**: confirm every blocked pattern maps to a piread call (offset/limit ≈ head/tail/sed range; hits ≈ `cat file | grep`; outline ≈ symbol reads). Fix any gap so the block reason is always actionable.
3. **Prevent migration**: extend the block (or add a sibling) to `head`/`tail` file-reads with pipeline-safe exclusions (never block `cmd | head` or `head` on process output). Reconcile with `VC` (view-command credit) so only true file-reads are blocked.
4. **Reconcile the desync**: add the missing `ruleEnabled` guard so `"off"` genuinely silences for every rule; audit other `off`-severity rules reached without a guard for the same class of bug.

### Tests (TDD)
1. `readerBypassCheck` already covers read-position cat/sed and excludes writer-cat/pipe-filter sed (`search-guard.ts:142-165`); add cases for head/tail file-reads and the `cmd | head` exclusion.
2. Gate test: a pibash `cat <file>` call is blocked (not warned) at `error`; the reason names the piread equivalent.
3. Loader test: `"off"` severity produces no warn and no block for a guarded rule (desync regression).

### Verify
- After shipping, re-export telemetry: readerBypass blocks rise then decay as agents retrain; pibash call count and spend drop (feeds W3).

## 5. W3 — Waste: pibash economy

### Problem
`pibash` is 64% of tool spend ($27.93 / 2670 calls). Drivers: search in shell (SS2/SS3/SS4 warns), reads via cat/sed (readerBypass, W2), and many small shell calls.

### Actions
1. **Enforcement feeds waste**: W2's readerBypass block directly removes the 107 read-in-shell calls.
2. **Search hygiene**: `searchReplaceFlag` (rg `-r`, 42 warns) — clarify the reason text; keep warn, revisit escalation only after measuring whether the clearer reason drops the count. `searchMidPipe` (7) and `findFirst` (1) stay warn.
3. **Instrumentation**: the per-tool spend/call telemetry already exists in the export; define a target (pibash ≤ 50% of tool spend) and re-export after each W2/W3 change to confirm movement.
4. **No new blocking**: avoid over-blocking bash (it is the universal tool); rely on W2 plus search-hygiene reasons.

### Verify
- pibash % of tool spend drops below baseline after W2; searchReplaceFlag warns drop.

## 6. W4 — Latency: subagent spawn-to-first-message

### Problem
`spawnToFirstMsgMs` is 399s for sentry-triage (p50 24–49s across agents). The spawn path is heavy: tmux sandbox + budget + scope + tool-manifest + spawn-queue (~10k lines under `extensions/subagents/`).

### Approach (investigate-first)
1. **Instrument**: timestamp each spawn stage (tmux pane create, session init, tool-manifest injection, model first-token) to isolate the 399s tail. Confirm whether it is model warm-up versus harness overhead.
2. **Hypotheses to test**: cold model init; tool-manifest injection blocking the first turn; spawn-queue serialization; tmux setup cost.
3. **Optimize** (only after isolation): pre-warm / lazy manifest / parallel init, per findings.
4. **Target**: p95 spawn-to-first-message below a threshold set after measurement (e.g. ≤ 60s).

### Verify
- Spawn-stage timestamps show which stage owns the tail; the re-exported `subagent latency` section confirms the p95 target.

## 7. Sequencing & dependencies

1. **W1 + W2 first** (small, high-confidence). W2's config-honesty fix is a prerequisite for W3's honest metrics.
2. **W3 next** — mostly enabled by W2; measurement-driven.
3. **W4 last** — needs its own investigation phase; independent of W1–W3.

## 8. Success criteria

- R11 blocks > 0 for a reproduced cross-turn failure streak (W1).
- `"off"` severity silences, and SE2 blocks read-bypasses with an actionable reason (W2).
- pibash % of tool spend drops below baseline (W3).
- Subagent spawn-to-first-message p95 under target (W4).

## 9. Non-goals

- No destructive-gate (H2) changes — its 38 blocks are expected safety behavior.
- No unrelated refactors to `extensions/subagents/` beyond the latency instrument/optimize.
- No new dependencies; reuse existing Rust/native tools and the permission gate.

## 10. Implementation status (2026-11-17)

**W1 shipped.** `resetTurnParts` no longer clears `lg1ErrStreak`/`lg1ErrMutSeq`, so
the streak crosses user turns; a non-error result or a landed mutation still clears
it. Three cases added to `tests/gate/cases/rules/failureLoopGuard.mjs` (cross-turn
block, mutation disarm, sub-threshold pass); the runner is 387/387.

**W2 shipped.** `SE2` ships `error`; the reason names all three piread calls.
`readerBypassCheck` now flags read-position `head`/`tail` with a file operand while
pipeline stages (`cmd | head`), stdin readers, `tail -f`, and `cat` writers pass.
The desync was fixed at its single choke point: `enforce` tests `ruleEnabled` before
warning, so `"off"` is silent for every rule that uses it. The remaining direct
`warnCall` (AG stale-note) is unreachable unless an anchor rule is enabled. New
regressions: `tests/gate/reader-bypass-off.test.mjs`, `tests/gate/reader-bypass-error.test.mjs`.

**W3 partial.** The SS4 reason now names the `rg -rn` symptom (substituted matches,
no line numbers) instead of the flag history. The pibash share target needs a
re-export after a week of sessions — no code claim made here.

**W4 instrument shipped, optimization blocked on a metric defect.** `launchSubagent`
stamps six stage offsets (`config`, `session`, `loadout`, `env`, `prompts`, `pane`) on
the running entry and the spawn result details, pinned by a case in
`tests/subagents/atomic-launch.test.ts`. Finding: the dashboard's `spawnToFirstMsgMs` is
the gap from a spawn call to that instance's first `subagent_message` call — the
parent's follow-up, not the child's first token — so the 399s tail does not attribute
to spawn cost at all. A corrected series (spawn call -> child session start -> first
assistant message) is the prerequisite for the p95 target; it changes an exported
dashboard column, so it is proposed rather than shipped.
