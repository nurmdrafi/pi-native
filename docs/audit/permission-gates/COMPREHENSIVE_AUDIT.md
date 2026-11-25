# Comprehensive Audit — Permission Gates, Yolo Mode, Subagent Gating, Tool-Calling Mechanism

Audit date: 2026-11-18. Scope: `extensions/permission-gate/` + rules, native pipelines
(pibash/piread/piedit/piwrite), subagents spawn path (`extensions/subagents/`), config
surfaces, and live behavioral evidence from 2026-11-18 sessions (186 gate-relevant
events). Method: 4 parallel read-only analysts (source recon, security review, yolo/
subagent trace, session behavior) + lead synthesis. Template: `research/universal-audit.md`.

## 1. Feature overview and actual execution flow

The permission-gate extension IS the permission system — pi core ships no permission
prompts of its own (no --yes/--dangerously flags; settings.json carries no permission keys).

Flow: tool registered natively (`pi.registerTool`, e.g. pibash/index.ts:551) →
gate subscribes to harness `tool_call` events and matches BY NAME — bash|pibash
(index.ts:22-24), read|piread (:718-724), edit|piedit (:619), write (:895-900) →
`enforce()` ladder (index.ts:310-347) applies per-rule severity from config →
`{block:true, reason}` vetoes before execution (fail-closed handler wrap :351-374);
warns ride the real tool result as an extra text block (:1594-1600).
Native pipelines call no gate code themselves; built-ins are steered to natives by
P1/P2/P3 (index.ts:736-743, 898-900, 1026-1028).

Rule families (full table: `extensions/permission-gate/rules/`, map loader.ts:40-160):
Hygiene (SE2 reader-bypass, SE1 error-swallow), Search (SS1-SS4, PB1 portability),
Permission Gate (H2 destructive confirm, protected paths, WC write confinement,
malformed, internal), Token Economy (P/R/RB/R10), Loop Guard, Anchor/Write binding,
Commitlint (R9, the only HARD_RULE floor), caps (H1/H1b, non-blocking).

Matching is shell-text regex over quote-aware segments, self-described
"TRIPWIRE, NOT A BOUNDARY" (destructive.ts:63-73): splitSegments (:359-434),
normalizeSegment strips wrappers to fixpoint (:460-468), CMD_POS anchoring (:47),
INTERP_INLINE for -e/-c interpreters (:192-206).

Config precedence: `PGATE_<RULE>` env > `config.json` > default-all-error;
fail-closed parse (loader.ts:261-278). `/yolo` sets module state; `ruleSeverity()`
returns "off" for every non-floor rule (loader.ts:383-385); YOLO_FLOOR =
{commitMessageLint} only (:365-367); git-family auto-approves via
segmentDestructiveExceptGit (index.ts:1137-1138). Reset at session_start (:1760) —
no session, parent or child, inherits a bypass.

Subagents: children run `--no-extensions -e <gate path>`; default extra extension =
the gate (subagents/index.ts:1861-1867, commit 93aa3de). Same config, same rules;
only divergence: H2 confirm ladder short-circuits to auto-deny when
PI_SUBAGENT_NAME is set (index.ts:516-519). Verified live: 2026-11-18T08-43 child
sessions (scout + session-auditor) were gated identically.

## 2. Overall assessment

Engineering in the small is careful (fail-closed wraps, malformed-input blocks,
quote-aware splitting, NFKC, heredoc re-emission, decision-log without raw payloads,
307 test cases). The system risk is concentrated in three structural facts:

1. The entire human-approval boundary hangs on one shipped-off config key.
2. The gate's own control plane sits in the agent-writable tree, unprotected.
3. Daily friction (186 events/day observed) comes from a mismatch between gate
   messages and the composition jobs agents actually do — this drives repeat
   violations, not sloppiness alone.

Verdict: REQUEST_CHANGES (security dimension); behaviorally: usable but teaching-
averse — blocks correct, warns don't, reroutes leak into ungated lanes.

## 3. Findings by severity

### Critical
- **A1** H2 `destructiveConfirm` ships "off" (config.json:19) — the confirm ladder
  never runs for destructive bash (index.ts:1140), protected-path writes (:631, :906),
  WC out-of-cwd confinement (:641, :922-930), and the subagent fail-closed lane
  (:516-520). With H2 off, `sudo`, `rm -rf`, `curl|sh`, `git reset --hard`, and
  piwrite to `~/.ssh/authorized_keys` execute with zero approval. (Sec F1)
- **A2** Gate control plane agent-writable: config.json + sources live in the
  agent-writable tree; piwrite to config.json is in-cwd-exempt from WC and WB is
  warn-only; edits arm on the next process, including every child (loader.ts:340).
  No self-modify check exists (stale comment index.ts:1057). (Sec F2)

### High
- **A3** Extension load failure fails open: `guarded()` fail-closes only REGISTERED
  handlers (index.ts:346-367); a broken/edited-away gate file = ungated session,
  unwarned in children (subagents/index.ts:1874-1880). (Sec F3)
- **A4** Compositional reader gap drives repeat violations: SE2 blocks sed/cat/head/
  tail read shapes, but piread cannot pipe or feed jq/awk/sort pipelines. 32
  reader-bypass errors + 22 warns in one day; same sessions re-offend 5-7x —
  the block message names the single-shot alternative, not the composition recipe.
  Post-block taxonomy (34 blocks): 67% immediate compliant switch, 21% partial
  (rg kept `| head` shape), 3 true bypasses via ungated python3-heredoc mutation,
  1 write-then-execute reroute, 0 ask-the-user events — the agent never takes the
  ask-instead path AGENTS.md Safety prescribes; the H2 confirm ladder (its in-band
  ask route) is shipped off (A1).
  Layer: harness-gap (70%) + agent habit + instruction override under need. (Behav C1)
- **A5** Yolo floor = {commitMessageLint} only; `/yolo` banner claims "destructive/
  protected confirm stays" (index.ts:406) — false while H2 is off the floor.
  (Sec F4; yolo trace)

### Medium
- **A6** `node -e` inline body not inspected → pure arithmetic blocked as
  destructive (observed 2026-11-18 04-20: `node -e "const m=((0.21+(-0.05))/2)..."`
  → "mutates files"). False positives erode trust and reroute work into the
  ungated heredoc lane (python3 - <<EOF rewrites observed passing in 08-06).
  (Behav C2, Sec F6)
- **A7** Heredoc-fed interpreter bodies escape INTERP_BODY_DESTRUCTIVE (applied only
  to inline -e/-c forms; INTERP_INLINE requires the flag token) — destructive.ts:287-289
  vs 357. (Sec F6)
- **A8** Warns are not enforcement and don't teach: rg-first 16, fd-first 6,
  reader-bypass 22 warn-rides/day with zero observable behavior change; WB
  writeBindingGuard ships warn-only (silent-overwrite class proceeds). (Sec Q4, Behav C3)
- **A9** Bash-lane redirect/tee overwrites of tracked files bypass WB entirely
  (binding applies only to write/edit tools, index.ts:955ff; redirect only checked
  vs protected prefixes destructive.ts:295-301). (Sec F8)
- **A10** Deny-by-default tool loadout is convention, not mechanism: absent `tools:`
  in an agent definition → UNRESTRICTED child (subagents/index.ts:1750-1751).
- **A11** `PI_SUBAGENT_EXTRA_EXTENSIONS` (singular) replaces the gate default;
  docs/subagent-orchestration.md:13 spells it `PI_SUBAGENTS_...` (plural) — following
  the doc does nothing. Also: SS1/SS2 docs say "blocks", ship "warn" (config.json:57-58);
  toolchain.ts:22 cites a `PGATE_TOOLCHAIN` env no code reads; safe-bash.ts:30-31
  stale "worker lane does not run the gate" comment.
- **A12** APPROVAL_RE matches "do NOT proceed" (approves on negation); 2-minute
  verbatim approval is string-keyed while the filesystem can change (TOCTOU);
  realpath at check-time vs write-time resolution. (Sec F5, F9)

### Low
- **A13** Quote/ANSI-C evasions (`r"m`, `$'\x72\x6d'`), `osascript -e`, and
  write-then-execute of just-written /tmp scripts pass the regex tripwire by design.- **A14** Children inherit gates but not gate-briefs: wave-1 children burned 12+
  events rediscovering SE2/SS2/SS3 rules their briefs never mentioned.
- **A15** Dash-leading session-dir paths defeat rg/grep as args (treated as flags);
  the SS2 message doesn't teach `./` prefix or `-g` glob. (Observed 08-32, 3 attempts.)

## 4. Performance
Gate cost is per-tool-call regex over command text — microseconds; no measurable
latency contribution. Real costs: (a) wasted calls (186 events/day, ~1 turn each);
(b) H1/H1b caps + spill files ($TMPDIR/pgate-spill, 0700, 24h prune ≤50) — sound;
(c) pibash Rust compression metadata forwarded so the gate skips double-capping
(pibash/index.ts:458-462, index.ts:1339-1343) — good design.

## 5. What to fix, in one line each
Re-arm H2 (A1) → protect the gate's own files (A2) → load-failure watchdog (A3) →
SE2 composition recipe + warn escalation (A4/A8) → inline-body inspection (A6/A7) →
doc/comment fixes (A5/A11) → briefs for children (A14) → deny-by-default loadout
mechanism (A10) → binding parity + approval hardening (A9/A12). Details and order:
IMPLEMENTATION_PLAN.md.

## 6. Generated documents
- docs/audit/permission-gates/COMPREHENSIVE_AUDIT.md (this file)
- docs/audit/permission-gates/IMPLEMENTATION_PLAN.md
- docs/audit/permission-gates/IMPLEMENTATION_CHECKLIST.md
- docs/audit/permission-gates/ARCHITECTURE_REVIEW.md

Confidence: A1-A11, A13-A15 verified against source (11/11 spot-checks match);
A12 (TOCTOU/approval-window) is static-reasoning confidence only — see unverified areas.

## 7. Unverified areas
- TOCTOU F9 exploitability not demonstrated dynamically (static reasoning only).
- Exact per-event recovery latency (timestamp shapes vary across record types;
  qualitative immediate-retry confirmed instead).
- pi-core internals beyond the extension API surface (pi is an external npm binary).
- 07-06..08-14 warn events beyond sampled patterns (counts complete, snippets sampled).

Evidence files (session-local, not committed): /tmp/audit/{gate-source,gate-security,
yolo-subagents,gate-behavior}.md, /tmp/joined.tsv, /tmp/timeline.tsv.
