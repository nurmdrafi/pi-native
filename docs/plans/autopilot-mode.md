# Autopilot mode — proposal (from career-ops session 2026-11-17/18)

Status: PROPOSAL, not approved for implementation. Source session drove a 52-task
two-feature remediation to completion autonomously; every design point below is
grounded in an incident that actually happened there.

## 1. Safety envelope
- Command classes: (a) always-allowed — in-scope file edits, test runs, fast-forward
  pushes to configured remotes; (b) PARKED — force-push, resets, rm outside workspace,
  installs, system paths, deploys, secrets: queued for `/autopilot review`, the wave
  continues; (c) reroute-preferred — safe equivalent exists (amend-after-push becomes a
  follow-up commit).
- Yolo mode never widens class (b).
- Budget ceilings per effort (turns / cost / wall) with auto-stop and parked-state report.

## 2. Native effort ledger
- Auto rows on spawn / deliver / verify / commit; crash reconcile on wake.
- Replaces the manual plan.md + status.jsonl discipline the session had to maintain.

## 3. Orchestration hardening (each = one observed failure)
- Write-locks MUST release on child delivery — machinery-enforced (session lost ~100
  minutes to five spawns queued behind a delivered child's ghost scope).
- Queue health: wedge detector (queued > N minutes with no live owner) → auto-cancel +
  respawn narrow, or parent-absorb.
- Cancel/restart control available in the parent loadout.
- Durable artifact handoff: children write deliverables to files and return pointer +
  bounded summary — inline results truncate (~2K chars observed) and lost content twice.
- Prefer one worker taking a whole task chain over queue-chaining spawns behind broad
  directory write-scopes.
- Auto-stagger concurrent children; 429 backoff.

## 4. Verification engine
- Per-task machine gate: command + expected exit, run with pipefail semantics (a
  `suite | tail` pipe masked exit codes and let two commits land red).
- Red → no commit, auto-revert the slice, one retry, then park.
- Amend only unpushed commits (guard).

## 5. Decision policy
- Recorded pre-delegation: "pick the option closest to the source finding, document the
  choice in the commit" — or park decisions for the user. Every pick cited.

## 6. Implementation slices
- S1: `/autopilot` mode flag + command classifier.
- S2: native effort ledger + reconcile.
- M3: lock-release-on-delivery + queue health + cancel.
- M4: durable artifact handoff convention.
- M5: verification gate runner.
- L6: user-queue + live effort dashboard.

Acceptance tests replay this session's incidents: queue wedge, result truncation,
amend-after-push, pipe-masked red suite, ghost-lock residue.
