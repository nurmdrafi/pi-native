# Implementation Checklist — Permission Gate Hardening

Phase = plan.md phases. Tick only after its test passes.

## Phase 0 — Re-arm approval boundary (A1)
- [ ] Failing test: destructiveConfirm confirm-path re-enabled (H2 error default)
- [ ] config.json `"H2": "error"`
- [ ] loader.ts HARD_RULES += destructiveConfirm
- [ ] destructiveConfirm.mjs case updated and green
- [ ] yolo test: H2 floored, yolo cannot silence it
- [ ] /yolo banner text corrected (A5)
- [ ] `npm run gate:eval` green

## Phase 1 — Doc/comment truth (A11)
- [ ] subagent-orchestration.md env var spelling fixed
- [ ] rg repo-wide: no PI_SUBAGENTS_EXTRA_EXTENSIONS remains
- [ ] config.json SS1/SS2 doc text matches severity
- [ ] toolchain.ts, safe-bash.ts, index.ts:1057 stale comments fixed

## Phase 2 — Judge accuracy (A6/A7/A13)
- [ ] Failing test: `node -e "1+1"` allowed, `node -e "fs.rmSync"` confirmed
- [ ] INTERP_BODY_DESTRUCTIVE applied to inline -e/-c bodies
- [ ] Failing test: `python3 - <<EOF ... rmtree ... EOF` confirmed
- [ ] Heredoc interpreter bodies judged line-by-line
- [ ] osascript -e added to INTERP_INLINE
- [ ] Write-then-execute signal implemented + tested
- [ ] security-fixture corpus extended (bash-block.txt additions)

## Phase 3 — Teach + escalate + composition (A4/A8/A15)
- [ ] Failing test: SE2/SS2/SS3 messages carry composition recipe
- [ ] jq single-operand read whitelist under size bound + test
- [ ] Destructive-block message carries ask-route recipe (affirmative phrasing) + test
- [ ] Mutation-need recipe names piedit/piwrite, never heredoc rewrites
- [ ] Same-session warn counter; N=3 promotion to block + test
- [ ] Dash-path hint in SS messages
- [ ] reader-bypass-escalation.mjs green

## Phase 4 — Control-plane protection (A2/A3)
- [ ] Failing test: piwrite to config.json blocked without affirmative
- [ ] Gate-file write/edit/redirect guard implemented
- [ ] session_start config/loader hash drift warning + test
- [ ] Spawn without gate in resolved extensions → hard fail + test
- [ ] security-canary scene extended, green

## Phase 5 — Subagent briefs (A14)
- [ ] Spawn preamble carries gate composition recipe + no-destructive policy
- [ ] Manual verification: one scout child session with <2 gate events

## Phase 6 — Binding parity + approval hardening (A9/A12)
- [ ] Failing test: `echo x > tracked.md` confirm-checked
- [ ] REDIRECT/TEE WB-equivalent binding
- [ ] APPROVAL_RE negation-safe + test
- [ ] Remembered approval keyed on (cmd, stat) + test
- [ ] Post-write realpath re-check + test
- [ ] security-toctou scene green

## Phase 7 — Deny-by-default loadout (A10)
- [ ] Failing test: agent definition without `tools:` → empty allowlist
- [ ] Failing test: `tools: all` → unrestricted + spawn warning
- [ ] Mechanism flip in subagents/index.ts:1750-1751
- [ ] Migration scan: bundled/global/project agents missing `tools:` fixed
- [ ] Fork-clone unrestricted contract documented

## Definition of done
All tests green (`npm run gate:eval`, tests/gate suite); CHANGELOG entry;
harness lessons recorded; no new warn/error gate events in a follow-up workday
sample < 20% of 2026-11-18 baseline (186).
