# Architecture Review — Permission Gate System

## 1. Shape
Event-sourced veto on the harness `tool_call`/`tool_result` seam, one composition
root (extensions/permission-gate/index.ts, 1949 ln), flat rule modules under rules/,
one severity resolver (loader.ts), one shipped config. Natives (pibash/piread/
piedit/piwrite) are plain tool registrations; the gate matches them BY NAME.
Built-ins and natives are treated identically per tool family (index.ts:22-24,
619, 718-724, 895-900).

Strengths:
- Single enforcement point — every rule decision flows through enforce()
  (index.ts:310-347); no per-tool gate forks; P1/P2/P3 route built-ins to natives
  through the same severity config, so yolo/off opens both lanes symmetrically.
- Fail-closed defaults: default severity = error; malformed config keeps rules on
  (loader.ts:261-278); tool_call handler exceptions block (guarded, :351-374);
  malformed tool arguments block (:623, :723, :889, :1014).
- Observability without leakage: gate-decisions.ndjson (sha-16, no raw payloads,
  :147-163); caps spill to private files with pruning.
- Test architecture: 307 cases, one file per rule key, scenes for interplay and
  security, 92-fixture eval corpus, harness HOME isolation.

## 2. Weaknesses
- **One key holds the boundary.** Every human-approval path (H2 ladder, protected
  paths, WC, subagent lane) gates on `ruleEnabled("destructiveConfirm")` — a single
  shipped "off" disarms all of them (A1). Architecture fix: split the floor from
  the switch — HARD_RULES should contain the safety floor; config only tunes above it.
- **Control plane inside the policed zone.** The gate polices the agent but lives
  in the agent-writable tree with no self-protection (A2). The policed party can
  rewrite the policeman for every future process. Fix direction: hash-pinned or
  outside-tree config, or a maintenance-mode affirmative.
- **No load-failure watchdog.** The fail-closed story ends at the extension
  boundary: if the extension never loads, nothing blocks (A3). A core-side or
  spawn-side canary (expect the gate in resolved extensions) closes the hole.
- **Regex tripwire acknowledged, not compensated.** "TRIPWIRE, NOT A BOUNDARY"
  (destructive.ts:63-73) is honest; but the compensating control (confirm ladder)
  is the thing shipped off (A1). The tripwire's false positives (A6) then push
  traffic into genuinely unjudged lanes (heredoc, A7) — worst of both worlds.
- **Warns are dead letters.** 15+ rules ship warn-only; warns ride results and
  change nothing (A8). A warn without escalation or ledger is annotation, not
  control. Same-session counters (Phase 3) turn warns into a teaching gradient.
- **Message design ignores the job shape.** SE2/SS messages name a tool, not a
  recipe for the compositional need that caused the violation (A4) — measured as
  5-7x same-session relapse. Block reasons are the gate's only teaching channel;
  they must carry the compliant composition, not just the prohibition.
- **Subagent parity is good, briefs are missing.** Children load the same gate
  (verified live: 08-43 child sessions gated), diverge only tighter (auto-deny
  lane). But nothing pre-teaches children the rules — they re-pay the discovery
  tax per wave (A14). Preamble injection is the cheap fix.
- **Deny-by-default is convention.** Tool loadouts default UNRESTRICTED when
  `tools:` is absent (subagents/index.ts:1750-1751) — the docs' claim holds only
  because shipped agents declare tools. Mechanism should match the claim.

## 3. Dependency direction — correct
Rules depend on nothing harness-specific beyond loader constants; index.ts depends
on rules; natives depend on neither (registry-side coupling only, announceNativeTool
for subagent propagation). Generated bounds (bounds.gen.ts) drift-tested. No cycles
observed.

## 4. Complexity of recommended work
S: Phases 0, 1, 5. M: 2, 4, 6. L: 3 (composition lane policy). Full detail in
IMPLEMENTATION_PLAN.md.
