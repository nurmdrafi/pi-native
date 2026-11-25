# Architecture Review — Agent Behaviour vs Permission Gates, Tool Calls, Internal Mechanisms

Audit date: 2026-11-18. Window: 2026-11-04..18, 195 sessions, 10,625 tool calls.
Template: `research/universal-audit.md`. Method: parent facts sweep + 3 parallel
read-only session-auditor children (permission response, call economy + read
mechanism, commit/loop/error discipline). Ledger tool:
`tests/tools/audit/session-blocks.mjs --json` (per-session outputs:
`/tmp/behave-audit/*.json`, compact: `/tmp/behave-audit/ledger.ndjson`).

Related prior audit (same day, system side): `docs/audit/permission-gates/`
— gate internals, yolo, subagent gating. This review covers the other side of
the contract: agent conduct measured against those mechanisms.

## 1. The contract being audited

Three layers, each with a defined authority:

1. **Rules (declarative)** — `SYSTEM.md` (call economy, file lookup, recovery)
   and `AGENTS.md` (safety: denial final, no reroute/disguise; commit shape;
   loop escape). These state the *judgment* expected of the agent.
2. **Mechanisms (enforcing)** — the permission-gate extension families:
   permission (H2 destructive confirm, control plane), token economy (re-read,
   re-run, token), anchor guard, commitlint (HARD floor), loop guard, hygiene
   (SE1/SE2), caps (H1/H1b). Fail-closed; warns ride real results.
3. **Observation (measuring)** — `session-blocks.mjs` classifies every
   isError result by gate label into a family ledger, adds a heuristic
   recovery flag (same tool + 60-char target key succeeding within 3
   results), a chaining profile (batch histogram, parallel share), and a
   compaction-contract re-derivation per structured piread omission.

The audit question: where the mechanism fired, did the agent's *next move*
match the rule? Blocks measure the mechanism; only transcripts measure
judgment. The recovery flag is not a compliance signal (a compliant
continue-at-offset call changes the key; a denial-final stop shows
"unrecovered"), which is why Wave 1 children sampled raw JSONL.

## 2. Verified measurement architecture (parent sweep)

- Window ledger totals: 213 blocks — permission 172 (170 Destructive,
  2 Control plane), re-read 26, commitlint 11, loop 3, token 1, anchor 0.
  Matches the independent anchor-audit run (169 permission on its 194-session
  window; the 3 extra here are the window's later sessions).
- Recovery flag: 182/213 unrecovered — dominated by permission 153/172, whose
  compliant response (stop/ask or a *different* call) does not match the
  recovery key by construction.
- Non-gate errors kept separate: 345 (command failures, hook rejections) — the
  ledger's gate/error split prevents ordinary failures from masquerading
  as gate events. Post-audit correction: 41 of the 345 are Hygiene-family
  gate events misfiled by the label set (risk 4 below, AB-1).
- Chaining: median parallel share 28.6% of batches; distribution per child
  report.
- Compaction contract: 141 findings flagged across the window — mechanism
  side classified in the economy child's report.
- Per-day block counts: 11-05:28, 11-07:60, 11-08:36, 11-09:11, 11-10:3,
  11-12:3, 11-14:7, 11-15:39, 11-17:19, 11-18:7 (sessions/day: 16, 52, 22,
  22, 3, 2, 8, 4, 36, 25, 5). The gate-hardening fixes landed 2026-11-18
  (checklist Phases 0-7 all ticked); post-fix same-day sample is 5 sessions —
  too thin to certify the "<20% of 186/day baseline" definition-of-done.

## 3. Layer interactions (observed)

- **H2 Destructive dominates friction** (170/213 = 80%): the confirm ladder
  fires on rm/dd/curl/node -e/python -c/write-then-execute shapes — the
  composition jobs the prior audit flagged as the friction source (its §2.3).
  Wave-1 sampling confirmed chained re-blocks after already-compliant
  retries (5 in sample: wc/printf/node -e read payloads) — A6/A7 residue
  verified, not just suspected.
- **Control-plane guard works**: 2 blocks on edits into the gate tree —
  Phase 4 (A2) observed enforcing on real sessions, not just tests.
- **Read mechanism drift is real but rare per session**: 141 compaction
  findings vs only 10 compaction records all-time (anchor-audit) — the
  findings concentrate in a few long sessions with structured omissions.
- **Commitlint is the only HARD floor** and shows the best remediation rate
  (6/11 recovered by key match) — message rewrite with a stable `-F <file>`
  prefix is the compliant one-shot remedy.
- **Anchor guard: zero in-window** — all-time 118 blocks / 0 with an
  intervening compaction (anchor-audit Q1), so anchor-vs-compaction is a
  non-interaction in current data.

## 4. Boundaries and coupling

- Judgment rules and gate messages are loosely coupled by design: gate
  messages carry recipes (Phase 3, A4/A8) and the agent is expected to follow
  them rather than improvise — audit verifies that linkage.
- The measurement layer reuses the gate's own coverage walk
  (`read-coverage.ts`) — a defect there would hide as an audit blind spot,
  which is why compaction findings are re-derived, not trusted.
- Subagent sessions are gated identically (prior audit §1); Wave-1 children
  ran read-only under the same families, and their own gate events land in
  this window's ledger.

## 5. Risks carried into the audit report

1. Post-fix regression data is thin (5 sessions on 11-18); a follow-up sweep
   after ≥3 workdays is required before claiming the friction fix held.
2. The recovery heuristic can neither prove compliance nor violation — all
   judgment claims in the report trace to transcript excerpts, never to the
   flag alone.
3. The one confirmed evasion (piwrite-denied path rerouted via `cat > path
   <<EOF`, session 3d79dd5d, 11-08) is NOT closed by permission-gates Phase
   6: the WB binding arms only for VCS-tracked/session-covered targets, so
   new untracked out-of-cwd files stay free. impl-p3 reproduced it live
   (2026-11-18) and added two RED regression cases; subagent-scoped bash
   write confinement is in application under gate-maintenance approval.
4. The measurement layer's gate/error split drops the Hygiene family
   entirely (no label, no FAMILIES row): 41 in-window Hygiene events sat in
   the error bucket and the initial economy read concluded "0 hygiene
   blocks". Every ledger-derived gate count before that fix is a floor, not
   a total.
