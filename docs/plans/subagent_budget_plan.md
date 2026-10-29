# Plan: Subagent Budgets — wall-clock, turns, cost, clean stop

Status: implemented. Default ceilings approved: 1800 s / 60 turns / $3.00;
hand-off on breach (no auto-resume). Open question 2 resolved accordingly.

## Problem

A subagent has no ceiling. The parent spawns a child pi in a tmux pane and
polls its session file for completion (`extensions/subagents/index.ts:1502`);
nothing stops a child that loops, retries forever, or burns cost. Provider
auto-retry exhaustion is the only backstop and it never triggers on a
well-formed but runaway loop.

## Goals

1. Every subagent runs under a finite budget: wall-clock seconds, assistant
   turns, and cumulative USD cost.
2. Budget breach stops the child cleanly and surfaces an actionable failure
   to the orchestrator, same shape as auto-retry exhaustion
   (`extensions/subagents/index.ts:578-586`).
3. Default-deny posture for budgets too: undeclared budget → global default
   ceiling applies, never "unlimited" (lesson from the tools-allowlist gap,
   `extensions/subagents/index.ts:833-835`).

## Non-goals

- Enforcing budgets for detached subagents after the parent session ends
  (documented limitation; the pane outlives the watcher).
- Parent-session budgets (separate concern, needs pi-core support).
- Rate limiting or parallelism caps (spawn-queue already sequences).

## Design

### Budget declaration

- Per-role frontmatter in `agents/*.md`, beside `tools:`:

  ```yaml
  budget:
    wallClockSec: 900
    turns: 50
    costUsd: 2.0
  ```

- Global defaults in `extensions/subagents/config.json` under
  `budgetDefaults` (any subset; unset dimension = no ceiling from that
  dimension, but at least one dimension must resolve finite — else the
  global default applies wholesale).
- Per-spawn override via the spawn tool's params, clamped to the role's
  ceiling (a spawn may lower a budget, never raise it).

### Metering

- The poll loop in `watchSubagent` already wakes periodically; extend each
  poll to read the child session file incrementally from the last byte
  offset (no whole-file re-read per poll).
- Per assistant turn: usage.input/output/cacheRead/cacheWrite and cost —
  the same fields `summarizeSessionStats` sums
  (`extensions/subagents/session.ts:574-600`). Turn count = number of
  assistant messages.
- Cost is provider-reported only; no local price tables.

### Stop path

On any dimension breach, in order:

1. Graceful: `tmux send-keys -t <pane> C-c`. pi formats SIGINT exit 130 as
   an ordinary failure (`tests/subagents/runner.ts:2453`), so the child's
   session log stays valid.
2. Grace period (config `budgetGraceSec`, default 30 s), still polling.
3. Escalate: `tmux kill-pane -t <pane>`.
4. Mark the session record `budget_exceeded` with the breached dimension
   and value; the watcher emits the failure message with retry guidance
   ("re-spawn with a higher budget" / "resume the subagent").

tmux is already mandatory for spawning (`extensions/subagents/tmux.ts:68`),
so there is exactly one stop path to implement.

### Persistence

- Add resolved budget to the loadout snapshot sidecar written at spawn
  (`extensions/subagents/index.ts:1382`) so a resumed subagent keeps its
  original budget; consumed amounts re-meter from the session file.

## Tests (failure paths first)

1. Each dimension breach triggers the stop path (wall-clock, turns, cost).
2. Grace-period expiry escalates to kill-pane.
3. Spawn param attempting to raise a budget is clamped (or rejected).
4. Malformed budget config fails fast at load (pattern of
   `tests/subagents/runner.ts:730`, `:762`).
5. Resumed subagent inherits the snapshotted budget.
6. Detached subagent: no watcher, no enforcement, no crash — skipped.
7. Poll abort on /reload cancels pending timers (existing
   `POLL_ABORT_KEY` mechanism, `extensions/subagents/index.ts:70-94`).

## Verification

- Scoped: `tests/subagents/` suite + typecheck. No new build step.
- Manual: spawn a subagent with `turns: 2` and watch the stop path fire.

## Open questions (need answers before implementation)

1. Default ceiling values: proposal `wallClockSec: 1800`, `turns: 60`,
   `costUsd: 3.0` — acceptable?
2. On budget breach, auto-resume once with the same budget, or always hand
   the decision to the orchestrator? Proposal: always hand off.
