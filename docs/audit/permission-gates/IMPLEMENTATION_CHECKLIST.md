# Implementation Checklist — Permission Gate Hardening

Phase = plan.md phases. Tick only after its test passes.

## Phase 0 — Re-arm approval boundary (A1)
- [x] Failing test: destructiveConfirm confirm-path re-enabled (H2 error default)
- [x] config.json `"H2": "error"`
- [x] loader.ts HARD_RULES += destructiveConfirm
- [x] destructiveConfirm.mjs case updated and green
- [x] yolo test: H2 floored, yolo cannot silence it
- [x] /yolo banner text corrected (A5)
- [x] `npm run gate:eval` green

## Phase 1 — Doc/comment truth (A11)
- [x] subagent-orchestration.md env var spelling fixed
- [x] rg repo-wide: no PI_SUBAGENTS_EXTRA_EXTENSIONS remains
- [x] config.json SS1/SS2 doc text matches severity
- [x] toolchain.ts, safe-bash.ts, index.ts:1057 stale comments fixed

## Phase 2 — Judge accuracy (A6/A7/A13)
- [x] Failing test: `node -e "1+1"` allowed, `node -e "fs.rmSync"` confirmed
- [x] INTERP_BODY_DESTRUCTIVE applied to inline -e/-c bodies
- [x] Failing test: `python3 - <<EOF ... rmtree ... EOF` confirmed
- [x] Heredoc interpreter bodies judged line-by-line
- [x] osascript -e added to INTERP_INLINE
- [x] Write-then-execute signal implemented + tested
- [x] security-fixture corpus extended (bash-block.txt additions)

## Phase 3 — Teach + escalate + composition (A4/A8/A15)
- [x] Failing test: SE2/SS2/SS3 messages carry composition recipe
- [x] jq single-operand read whitelist under size bound + test
- [x] Destructive-block message carries ask-route recipe (affirmative phrasing) + test
- [x] Mutation-need recipe names piedit/piwrite, never heredoc rewrites
- [x] Same-session warn counter; N=3 promotion to block + test
- [x] Dash-path hint in SS messages
- [x] reader-bypass-escalation.mjs green

## Phase 4 — Control-plane protection (A2/A3)
- [x] Failing test: piwrite to config.json blocked without affirmative
- [x] Gate-file write/edit/redirect guard implemented
- [x] session_start config/loader hash drift warning + test
- [x] Spawn without gate in resolved extensions → hard fail + test
- [x] security-canary scene extended, green

## Phase 5 — Subagent briefs (A14)
- [x] Spawn preamble carries gate composition recipe + no-destructive policy
- [x] Manual verification: one scout child session with <2 gate events (2026-11-18 scout run: 1 gate event, rerouted compliantly)

## Phase 6 — Binding parity + approval hardening (A9/A12)
- [x] Failing test: `echo x > tracked.md` confirm-checked
- [x] REDIRECT/TEE WB-equivalent binding
- [x] APPROVAL_RE negation-safe + test
- [x] Remembered approval keyed on (cmd, stat) + test
- [x] Post-write realpath re-check + test
- [x] security-toctou scene green

## Phase 7 — Deny-by-default loadout (A10)
- [x] Failing test: agent definition without `tools:` → empty allowlist
- [x] Failing test: `tools: all` → unrestricted + spawn warning
- [x] Mechanism flip in subagents/index.ts:1750-1751
- [x] Migration scan: bundled/global/project agents missing `tools:` fixed
- [x] Fork-clone unrestricted contract documented

## Definition of done
All tests green (`npm run gate:eval`, tests/gate suite); CHANGELOG entry;
harness lessons recorded; no new warn/error gate events in a follow-up workday
sample < 20% of 2026-11-18 baseline (186).
