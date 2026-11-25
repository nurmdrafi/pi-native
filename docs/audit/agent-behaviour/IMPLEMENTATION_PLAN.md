# Implementation Plan — Agent Behaviour Audit Follow-ups

Derived from COMPREHENSIVE_AUDIT.md findings AB-1..AB-10. Audit-only
constraint lifted for these tasks; each phase lands test-first per repo TDD
rules. Order: measurement before mechanism before behaviour tuning — every
later metric depends on AB-1.

## Phase 1 — Make the ledger see every gate family (AB-1, P1)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T1.1 | Failing test: session-blocks on a fixture session with a Hygiene isError result reports blocks:1, family hygiene | P1 | AB-1 |
| T1.2 | Add Hygiene label to `tests/gate/gate-labels.mjs` and FAMILIES row in `tests/tools/audit/session-blocks.mjs` | P1 | AB-1 |
| T1.3 | Re-run window ledger; publish corrected family totals (expect +41 hygiene, errors 345→~300) | P1 | AB-1 |
| T1.4 | Re-state the permission-gates do-done baseline to include hygiene events | P1 | AB-1, AB-10 |

Validation: T1.1 red→green; this audit's own session file reports blocks: 2.

## Phase 2 — Compaction renderer/structured invariant (AB-2, P1)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T2.1 | Freeze the 141-finding corpus as fixtures (session, file, rendered vs structured ranges) | P1 | AB-2 |
| T2.2 | Failing test: rendered coverage gaps == structured omissions on the corpus | P1 | AB-2 |
| T2.3 | Fix the diverging side (renderer tiling or structured derivation) until corpus green | P1 | AB-2 |

Validation: corpus re-run reports 0 findings; `npm test` scoped to
read-coverage consumers.

## Phase 3 — Close and prove the shell-write reroute lane (AB-3, P1)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T3.1 | Regression fixture: piwrite-denied path followed by `cat > path <<EOF` must block (3d79dd5d shape) | P1 | AB-3 |
| T3.2 | If T3.1 red: extend REDIRECT/TEE WB-equivalent binding to heredoc write targets | P1 | AB-3 |
| T3.3 | One live gated probe in a scratch session; record harness lesson either way | P1 | AB-3 |

Validation: fixture green in `npm run gate:eval`.

## Phase 4 — Follow-up regression sweep design (AB-10, P2)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T4.1 | Schedule the Phase-1-fixed sweep for ≥3 workdays post-2026-11-18 | P2 | AB-10 |
| T4.2 | Report blocks/day (incl. hygiene) vs re-stated baseline; certify or refute the <20% do-done | P2 | AB-10 |

Validation: sweep report committed under docs/audit/agent-behaviour/.

## Phase 5 — Reader-route and batching tuning (AB-4, AB-5, P2)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T5.1 | Failing test: N-th command-position reader pattern in a session escalates warn→block per A8 counter pattern | P2 | AB-4 |
| T5.2 | Rule text: exempt pipeline trims (`| head`, `| tail`) explicitly; keep file-open reads gated | P2 | AB-4 |
| T5.3 | Failing test: 5 consecutive single-call turns in one session → token-economy warn with batching recipe | P2 | AB-5 |

Validation: re-sweep top-10 heavy sessions; hygiene-block count up, ps up.

## Phase 6 — Commit route alignment (AB-6, P2)

| Task | Title | Priority | Findings |
|------|-------|----------|----------|
| T6.1 | Decide: update SYSTEM.md "Commit calls" to bless inline `-m` + commitlint gate, or add mechanical msgfile enforcement | P2 | AB-6 |
| T6.2 | Apply the chosen side; audit next 20 commit sessions for route adherence | P2 | AB-6 |

Validation: route audit shows ≥90% adherence to the documented route.

## Out of scope (recorded, no action)

- AB-7 (loop discipline held), AB-8 (single steer, unresolved), AB-9 (H2
  friction is prior-audit A4/A6/A7 territory, already scheduled there).
