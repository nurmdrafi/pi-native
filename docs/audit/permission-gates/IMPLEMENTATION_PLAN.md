# Implementation Plan — Permission Gate Hardening

Derived from COMPREHENSIVE_AUDIT.md findings A1-A15. Every phase TDD: failing
test first (tests/gate/cases/rules/<ruleKey>.mjs pattern + tests/gate/harness/).
Complexity: S < half-day, M ~1-2 days, L ~3+ days.

## Phase 0 — Re-arm the approval boundary (A1) — S, no deps
- config.json: `"H2": "error"` (restore destructiveConfirm).
- loader.ts:166-168: re-add destructiveConfirm to HARD_RULES (unlowerable).
- Update tests/gate/cases/rules/destructiveConfirm.mjs + yolo test expectation
  (YOLO_FLOOR still {commitMessageLint}; yolo does NOT silence H2 once floored).
- Update /yolo banner text (index.ts:406) to match reality (A5).
- Risk: friction returns for legit destructive ops — mitigated by the approval
  ladder (chat affirmative, remembered 2-min, UI dialog), all existing.
  Owner direction 2026-11-18: destructive ops are rarely required; prefer
  non-destructive equivalents (piedit, read-then-write, /tmp scratch) and
  ban destructive commands outright under yolo/subagent runs (now AGENTS.md
  Safety policy) — friction acceptable, re-arm without hesitation.

## Phase 1 — Truth in docs and comments (A11) — S, parallel with Phase 0
- docs/subagent-orchestration.md:13: PI_SUBAGENTS_ → PI_SUBAGENT_EXTRA_EXTENSIONS.
- config.json:57-58: SS1/SS2 doc text warn vs block.
- toolchain.ts:22 stale env name; safe-bash.ts:30-31 stale comment;
  index.ts:1057 stale self-modify comment.
- Gate check: repo-wide rg for the wrong spellings.

## Phase 2 — Destructive judge accuracy (A6, A7, A13 partial) — M
Evidence: observed 2026-11-18 — `python3 - <<EOF` rewrites completed a blocked
`perl -0pi` mutation (4 calls, ungated); `node -e` arithmetic false-positived and
rerouted to write-then-execute `/tmp/fp.js`.
- Apply INTERP_BODY_DESTRUCTIVE to inline `-e/-c` bodies (fixes `node -e`
  arithmetic false positive: confirm only when body matches destructive words).
- Heredoc opener naming an interpreter (python/node/perl/ruby/php/deno/bun/sh):
  judge every body line (destructive.ts:357, 385-404 extension).
- Add `osascript -e` to INTERP_INLINE list; add write-then-execute signal
  (REDIRECT target in /tmp + later execution of same path within session).
- Tests: extend tests/extensions/permission-gate-destructive.test.mjs (T6+):
  arithmetic node -e allowed; heredoc rmtree confirmed; osascript confirmed.

## Phase 3 — Teach, escalate, and unblock composition (A4, A8, A15) — M/L
Evidence: post-block taxonomy 2026-11-18 — 67% immediate compliance, 21% partial,
3 interpreter-heredoc bypasses, 0/34 ask-the-user events.
- SE2/SS2/SS3 block messages gain a composition recipe: "pipe needs →
  piread hits/offset to a spill or /tmp file, then pibash over the slice;
  or jq -r '<filter>' <file> when output stays under the cap" (whitelist
  `jq <file>` single-operand reads under a size bound).
- Destructive-block reason teaches the ask route: name the chat-affirmative
  phrasing (APPROVAL_RE vocabulary) so the agent asks instead of rerouting —
  today the in-band ask is invisible and 0/34 blocks ended in a question.
- Mutation-need recipe in the message: point to piedit/piwrite, never
  interpreter heredoc rewrites.
- Warn escalation: same-session warn counter per rule family in turn-state;
  Nth warn (N=3) promotes to block for SE2/SS2/SS3 (behavior-change loop).
- Dash-path hint in SS2/SS3 messages (./ prefix, -g glob).
- Tests: reader-bypass-escalation.mjs, search-recipe message assertions.

## Phase 4 — Control-plane protection (A2, A3) — M
- WB/HARD floor for the gate's own files: block write/edit/bash-redirect into
  extensions/permission-gate/** and permission-gate/config.json unless a
  session-approved maintenance flag is set (chat affirmative).
- session_start: hash config.json + loader.ts; on drift vs last session, warn
  in-context before first tool call.
- Child spawn: if resolved extra-extensions lack the gate path, fail the spawn
  with a diagnostic (or stamp the session gateless-warned) — closes F3's silent
  lane; aligns with subagents/index.ts:1874-1880 comment.
- Tests: security-canary scene extensions (self-modify block, spawn-without-gate).

## Phase 5 — Subagent gate briefs (A14) — S
- extensions/subagents spawn prompt preamble: one paragraph — pipe/composition
  recipe, rg/fd-first rule, SE2 shapes, dash-path hint, no-destructive policy
  (AGENTS.md Safety: destructive commands banned in subagent sessions; use
  piedit/piwrite or stop and ask the parent).
- Cheap, immediate: children stop paying the 12+ event rediscovery tax.

## Phase 6 — Write-binding parity + approval hardening (A9, A12) — M
- REDIRECT/TEE targets that are VCS-tracked or session-covered get WB-equivalent
  binding (index.ts:955ff pattern applied in the bash lane).
- APPROVAL_RE: require affirmative without preceding negation; key remembered
  approval on (command, stat of affected paths) instead of verbatim string only;
  re-realpath after write, error on mismatch.
- Tests: security-toctou scene, writeBindingGuard redirect case.

## Phase 7 — Deny-by-default loadout mechanism (A10) — M
- subagents/index.ts:1750-1751: `tools:` absent + no `subagent_agents` currently
  yields an UNRESTRICTED child (null allowlist). Flip the mechanism to match the
  documented claim: empty declaration → empty allowlist (deny-by-default), with an
  explicit `tools: all` (or frontmatter flag) as the only unrestricted route, plus
  a spawn-time warning when unrestricted is chosen.
- Migration: audit bundled + global + project agent definitions for missing
  `tools:` before shipping (rg 'tools:' in agents/*.md); fork-clone path keeps its
  unrestricted contract (documented).
- Tests: subagent spawn case — no-tools definition → denied tools; `tools: all` →
  unrestricted + warning.

## Execution order and parallelism
0 and 1 parallel (S). 2 → 3 sequential (judge accuracy before escalation).
4 parallel after 0. 5 anytime. 6 and 7 last (independent of each other).
Breaking changes: Phase 0 restores confirms (behavior change, desired);
Phase 4 restricts gate-file edits (maintenance flow needs the affirmative flag);
Phase 7 flips the no-tools default (breaking for undeclared definitions —
migration scan required).
Rollback: all phases are config/rule-local; revert = git revert of the phase commit.

## Harness lessons to record (lessons/harness.ndjson)
- reader-bypass composition gap (A4) — session 2026-11-18 clusters.
- node -e false positive (A6) — exact payload preserved.
- grep→rg dash-path arg shape (A15).
