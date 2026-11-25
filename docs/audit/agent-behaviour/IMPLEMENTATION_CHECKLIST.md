# Implementation Checklist — Agent Behaviour Audit Follow-ups

Phase = IMPLEMENTATION_PLAN.md phases. Tick only after its test passes.

## Phase 1 — Ledger sees every gate family (AB-1)
- [x] Failing test: Hygiene isError fixture → blocks:1, family hygiene
- [x] gate-labels.mjs carries Hygiene label; FAMILIES row added
- [x] Window ledger re-run; corrected totals published (hygiene 42, blocks 266, errors 309 — ledger-v2-totals.md)
- [x] Do-done baseline re-stated to include hygiene events (ledger-v2-totals.md Notes)

## Phase 2 — Compaction invariant (AB-2)
- [x] 141-finding corpus frozen as fixtures (23-row representative: 15 drift + 8 controls)
- [x] Failing test: rendered gaps == structured omissions on corpus (15 rows red pre-patch)
- [x] Diverging side fixed (walker anchorEnd: JOIN_DROP_BUDGET=2 + tail-notice gate, read-coverage.ts:560-574); corpus green 2/2
- [x] Scoped tests green (read-coverage unit + compaction-walk parity + locate-selfserve: 20/20)

## Phase 3 — Reroute lane (AB-3)
- [x] Regression fixture: piwrite-denied path + `cat > path <<EOF` blocks
- [x] Binding extended if fixture red — subagent-scoped bash write-confinement guard (index.ts post-A9, blockCall-wrapped); both cases green; typecheck clean; live re-probe child dispatched
- [x] Live gated probe run; harness lesson recorded (lessons/harness.ndjson, 3d79dd5d entry)

## Phase 4 — Regression sweep (AB-10)
- [ ] Sweep scheduled ≥3 workdays post-2026-11-18
- [ ] Blocks/day vs re-stated baseline reported; do-done certified or refuted

## Phase 5 — Reader-route + batching (AB-4/AB-5)
- [x] T5.1 escalation case — GREEN on existing A8 counter (ESCALATE_AT=3, index.ts:343); case pins the contract, no rule change needed
- [x] T5.2 pipeline-trim exemption — already true (headTailReadsFile single-file shape only); case pins it green
- [x] T5.3 TE1 batching-warn rule — implemented (index.ts TE1 handler + state, loader RULE_IDS, config TE1 warn+docs); both cases green; case batch-order corrected to real harness semantics
- [ ] Re-sweep of top-10 heavy sessions shows hygiene count up, ps up

## Phase 6 — Commit route (AB-6)
- [ ] Decision recorded (bless inline -m+gate, or enforce msgfile)
- [ ] Documentation/mechanism updated
- [ ] Next-20-commit route audit ≥90% adherence

## Definition of done
- [x] Phases 1-3 tests green (runner 430/430 exit 0; corpus 2/2; units+parity 20/20; typecheck 0 errors)
- [x] Corrected ledger published (docs/audit/agent-behaviour/ledger-v2-totals.md); commit pending user decision
- [x] Harness lessons recorded for AB-1 (misfiling) and AB-3 (probe outcome PASS: both routes blocked live)
- [ ] Phase 4 sweep report appended (due >= 2026-11-21)
- Note: 2 pre-existing test failures at HEAD (gate layer child-phase, g11 yolo diagnostics in piwrite-confinement.test.mjs) — prior-audit Phase 0 residue, out of this effort's scope; doc:check also carries 10 pre-existing findings
