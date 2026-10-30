# Defect: budget-killed subagents vanish without delivering a result

Date: 2026-10-30. Status: diagnosed, fix not yet implemented.

## Symptom

Three worker subagents (parallel batch, budget turns=25) each stopped at
27-29 assistant turns with no result delivered to the parent: no steer
message, no `budget_exceeded` report, nothing. Their tmux panes were gone
(`tmux send-keys` → "can't find pane"). A fourth sibling that finished
within budget delivered normally.

## Evidence

- Session files of the three lost workers survive on disk, each with 24-29
  turns of usage records and tool calls ending mid-verification (last calls
  were plain reads) — the work state was never lost, only the report.
- All three exceeded the `turns` dimension (27-29 > 25); the sibling that
  delivered did not.
- The result formatter (extensions/subagents/index.ts, the
  `error === "budget_exceeded"` branch) is correct and produces a
  resume-hint message — the gap is upstream: the result is never
  constructed/delivered on the kill path.
- All three panes vanished together, suggesting the tmux surface was reaped
  as a group (session cleanup), which can race the poll loop that is
  expected to observe the child exit and build the result.

## Hypotheses (ordered)

1. The watcher's poll loop keys on the pane; a group pane reaping produces
   no observable exit event, so the loop never reaches result construction.
2. The interrupt -> grace -> kill machine kills the pane before the poll
   tick reads the child's final state, and a thrown/swallowed error inside
   the watch promise ends the loop silently.
3. Parent-side extension state loss (process restart) orphaned the
   `runningSubagents` entries.

## Fix design

Reconciliation sweep, independent of the poll loop's health: on each status
check (or a periodic timer), for every entry in `runningSubagents`:

1. Pane check: tmux pane missing -> child is dead by infrastructure.
2. Session-file check: the child's session file exists and its mtime/turn
   count has not advanced for two ticks -> child is dead or wedged.
3. Either condition: synthesize the result from the session file —
   budget breach summary if the meter exceeds a dimension, else
   "pane lost / stalled"; last assistant text and usage totals appended —
   and deliver it through the existing result path, then remove the entry.

This makes delivery idempotent and covers all three hypotheses: the result
is derived from durable state (the session file), never from the pane.

## Test plan

Integration test in tests/subagents/ (follow subagent-lifecycle.test.ts
harness): spawn a child with `turns: 2` on a task that needs more; kill its
pane out-of-band at the breach; assert the parent receives a result whose
`error` is `budget_exceeded`, `sessionFile` is set, and the summary contains
the child's last assistant text. Second case: no budget breach, pane killed
externally -> result synthesizes "pane lost".

## Operational mitigation (already in effect)

Spawn budgets for read-heavy refactor tasks must exceed verification cycles:
turns >= 40, wall clock >= 30 min. The three lost workers were killed by an
over-tight turns=25 set by the orchestrator, not by a harness fault alone.

## Addendum (same day): result routing to the repo's main agent

The reap incident also orphaned cross-worktree children: an orchestrator
session in one repo spawned children in sibling worktrees; when the
orchestrator died, its children had no live addressee, so even a perfect
kill-path result would have gone nowhere. Two changes, layered on the
reconciliation sweep above:

1. Durable per-repo result inbox. Every child knows its project root (its
cwd). On completion — normal OR synthesized by the sweep — the result is
appended to `<repo-root>/.pi/subagent-results.jsonl` (usage totals, session
file path, final message) BEFORE any in-memory delivery is attempted.
A result on disk can never be lost, whatever happens to panes, parents,
or the extension process.

2. Main-agent drain. Each repo's primary session (the live session whose
cwd equals that repo root; ties broken by earliest start time) drains the
inbox on every wake/turn start and surfaces new entries as steer text.
A child's report therefore reaches the repo's main agent even when the
spawning parent is gone. If no session for that repo is live, entries wait
in the inbox — nothing is dropped, the next agent in that repo picks them
up.

Delivery order: steer the spawning parent if alive -> else steer the repo's
main agent -> the inbox write always happens first, so both are
best-effort layers over the durable record.

Open scope decisions (need owner input before implementing):
- Inbox location: inside `<repo-root>/.pi/` (per-repo, survives everything)
  vs a central agent dir keyed by normalized repo path (one place to audit).
- Drain trigger: turn start vs wake/steer only (turn start is simpler and
catches the "agent resumed next morning" case).
- Whether a child may declare a different report-to repo than its cwd
  (cross-repo delegation), or routing is strictly cwd-derived for v1.

## Addendum 2: durable read ledger (read-tool outcomes)

Incident corollary: reaped children also lose their read work — one worker
spent 27 turns reading sources and died before editing; nothing recorded
which spans it had rendered, so any successor re-reads from zero. Extend the
durable store with a per-repo read ledger: every read-tool result appends
one line — file path, rendered span(s) (the head/tail runs, from the
compaction report's structured omissions), omitted span(s), file stat/hash
at read time, session id, timestamp — to `<repo-root>/.pi/read-ledger.jsonl`.

Honest boundary, stated to avoid over-claiming: lines rendered in ANOTHER
session are not in THIS session's context, and edit anchoring still requires
the current session to have rendered the anchor lines. The ledger is an
index of prior reads (span + file-identity + provenance), not a context
substitute. What it buys:

1. Successor discovery: a takeover agent sees exactly which spans of which
   files were already examined (and whether the file changed since, by
   stat/hash), so it re-reads only what its own context actually needs —
   discovery for free, no blind re-walking.
2. Forensics and cost audit: span-level "who read what, when, at what file
   version" — the session-level index already aggregates turns and calls;
   this adds path/span granularity, reusable for token-economy analysis.
3. Gate resume hints: after extension state loss, the coverage map for the
   CURRENT session stays authoritative and in-memory; the ledger can seed
   staleness checks (file changed since last rendered span) but must never
   certify spans for a session that did not render them.

Storage contract: append-only JSONL, one record per read result (compacted
or not), rotated by size; queried on demand (newest-first per path,
filtered by unchanged stat/hash). Open decisions: retention/rotation budget;
ledger beside the result inbox in one store with record types, or a separate
stream; whether view-command outputs that certify spans append here too,
with their provenance kind.
