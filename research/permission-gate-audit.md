# Permission-Gate Audit — rule set vs tool surface vs documented workflow

Scope: 20 rule keys and 8 hook points from `extensions/permission-gate/config.ts` (as summarised
in task ground truth GT1), audited against the tool surface in GT2 and the owner's documented
workflow in GT3. Statements are tagged `[material]` when they rest on the provided ground truth
or the fetched web extracts, and `[uncited]` when they are model knowledge. The TS modules
themselves were not read in this session — see Gaps.

---

## 1. Rule-by-rule verdicts

| Key | Rule | Verdict | Why (one line) |
|---|---|---|---|
| AG | editAnchorGuard | valid | Byte-exact `oldText` requirement plus in-session read certification; the strongest correctness guard in the set `[material]`. |
| R1 | reReadGuard | valid, boundary fuzzy | Blocks re-reads of already-in-context spans; differs from R1b only by the "already seen" key, which the material never pins `[material]`. |
| R1b | largeReadGuard | valid | Fires on a <100-line window over an "unsearched path"; the predicate's source (session index vs pidx state) is undisclosed `[material]`. |
| R1c | locateFirst | valid | Enforces rg-before-read; overlaps SS1/SS3 by design (different tool classes), so layering is intentional, not contradiction `[material]`. |
| P1 | nativeReadFirst | valid, partly redundant | In native paths it duplicates R1c; its only distinct job is the codemode re-application done by P3 `[material]`. |
| P2 | nativeBashFirst | valid, partly redundant | Same shape as P1 for bash `[material]`. |
| P3 | nativeToolsInScripts | valid but weak | Word-boundary regex over script text is textual matching; defeated by concatenation, `eval`, interpolation, or aliasing `[material]` + §4. |
| P4 | codemodeScriptGuard | valid, strongest | Parse-checks scripts pre-execution — the only parse-level member of the family `[material]`. |
| H1 | outputCap (40 lines / 2048 B) | valid, interaction risk | Duplicates the harness-side ≈40-line/2KB result cap, so the double-trim ordering matters and is undocumented `[material]`. |
| H1b | readOutputCap | valid, conflicting | Cap of 40 lines is below R1b's required 100-line window, so a rule-legal read is necessarily truncated `[material]`. |
| H2 | destructiveConfirm (300 s) | misaligned by default | AGENTS.md states a precondition ("ask before"), H2 implements a 300 s timer; expiry semantics unstated `[material]`. |
| R9 | commitMessageLint | valid | Enforces ≤72-char body lines, matching the documented commit convention exactly `[material]`. |
| R10 | rerunGuard (10 min) | valid, low value, frictional | Identity key for "identical re-run" undisclosed; benefit is agent-loop hygiene, cost is blocking idempotent status probes `[material]`. |
| RB | reblockEscalation (2 min) | valid | Fast feedback loop; depends on R10's identity key `[material]`. |
| TC1 | toolchainPnpm | dormant | No pnpm appears anywhere in the documented toolchain; the rule can only fire if a pnpm lockfile appears `[material]`. |
| TC2 | toolchainNode | valid | `.nvmrc` pinning; matches the pinned-interpreter rule `[material]`. |
| SS1 | searchScope | valid | Blocks bare recursive search — "scope every search" `[material]`. |
| SS2 | searchMidPipe | valid, depth unknown | Blocks `grep` mid-pipe; whether it parses the pipeline or regex-matches is unspecified `[material]`. |
| SS3 | findFirst | valid | fd-before-find on a different binary from SS1 `[material]`. |
| PB1 | searchPortability | valid | Enforces the macOS+Linux subset `[material]`. |
| VM | violationMemory (5 sessions / 30 d) | valid, threshold questionable | Recall lag: a violation repeated across 5 sessions is only recalled in the 6th `[material]`; store location unstated. |
| AT1 | adoptionTelemetry | valid, privacy-unreviewed | What leaves the machine, and how it nests with OS, is not described `[material]`. |
| CN | cadenceNudge (200 turns / 150k ctx) | misaligned | Session counters reset on compaction, and the 150k trigger races the compaction that would fix it — ordering vs the `session_compact` hook is undocumented `[material]`. |
| OS | outputScrub | valid, scope unknown | On by default; the secret/path classes it scrubs are not described `[material]`. |

Rules that cannot fire as documented: TC1 (dormant, not dead). Rules that fire but add nothing
new: P1/P2 outside codemode. Rules that can contradict: H1b vs R1b (see §4).

---

## 2. Tool × parameter coverage matrix

| Tool | Param | Covered by | Gap |
|---|---|---|---|
| pibash | command | P2, P3, SS1, SS2, SS3, PB1, H1, R10, RB, H2 | String-level matching only; parse-level checks exist solely in P4 `[material]`. |
| pibash | timeout | **none** | An arbitrarily long timeout defeats any pacing or cap expectation `[material]`. |
| piread | path | R1b, R1c | Protected-path ladder not applied to reads `[material]`. |
| piread | offset, limit | R1b, H1b | Window/cap conflict (§4) `[material]`. |
| piedit | path | AG + normPath + symlink-resolved protected targets → H2 | Fully covered — the only path parameter routed through the ladder `[material]`. |
| piedit | edits[] | AG | Byte-exact anchors are a sound secondary control `[material]`. |
| pidx | out | **none** | Arbitrary file-write target, outside the H2 ladder `[material]`. |
| pidx | state, sessionsDir | **none** | Arbitrary read/write targets; VM persistence probably rides here unguarded `[material]`. |
| pidx | max | **none** | Volume control unguarded `[material]`. |
| pidx | force | **none** | State-mutating escape hatch with no confirmation `[material]`. |
| pidx | stdout | **none** | Pointer-only output bypasses H1's body cap by construction `[material]`. |
| write | path | **none** | Asymmetric with `piedit`: no normPath, no symlink resolution, no H2 ladder `[material]`. |
| write | content | H1 (post-hoc) | Cap only; no secret or injection scan `[material]`. |
| subagent | agent | **none** | Which agent is spawned is unchecked `[material]`. |
| subagent | task | **none** | Task text is a child-agent instruction channel — prompt-injection surface `[material]` + Checkmarx. |
| subagent | cwd | **none** | Child runs in an arbitrary working directory; no repo scoping `[material]`. |
| subagent | model | **none** | Tier/cost control unguarded `[material]`. |
| subagent | name | RB/VM only via collision | Namespace reuse could impersonate an earlier subagent `[material]`. |
| subagent_message | message | **none** | Same instruction-injection surface as `task`, still open after spawn `[material]`. |
| subagents_list | — | — | Read-only; acceptable `[material]`. |

Ranked by exploitability: (1) `write.path`, which is the same parameter type `piedit` guards and
so is an accidental asymmetry; (2) `pidx out/state/force`; (3) `subagent cwd/task/message`;
(4) `pibash timeout`.

---

## 3. Workflow alignment

- **R1c / SS1 / SS3 vs "rg-first".** Aligned in intent. Three independent regexes implementing one
  documented rule is a drift hazard: a fix to one will not propagate `[material]`.
- **H2 vs "ask before destructive".** AGENTS.md asserts a precondition; H2 implements a 300 s
  confirm. If expiry defaults to allow, the rule is silently weaker than documented. GT1 says
  fail-closed only for missing/malformed *config*, not for confirm expiry `[material]`.
  The documented list also names package install, sudo, secrets, and git operations; the material
  shows H2 covering protected paths and destructive commands only `[material]`.
- **R9 vs "commit body ≤72".** Exact match `[material]`. Residual question: whether it inspects
  only `pibash` git invocations or also heredoc-composed commit messages `[material]`.
- **CN thresholds.** 200 turns / 150k ctx tokens. 150k is plausibly below a typical compaction
  trigger for a 200k window `[uncited]`, so the nudge and compaction can race; the material does
  not order CN against the `session_compact` hook `[material]`.
- **VM window.** 5 distinct sessions over 30 days is a slow teacher for a per-turn guardrail; RB's
  2-minute escalation is the only fast path `[material]`.

---

## 4. Output alignment (H1 / H1b / OS)

- **Double-trim.** H1 caps tool results at 40 lines / 2048 bytes; the harness independently caps
  results at ≈40 lines / 2KB (GT2). Two caps at the same thresholds means one of two silent
  behaviours: H1 never meaningfully fires (harness already trimmed) or H1's corrective text is
  itself truncated by the harness `[material]`. Which one is undetermined; the fix is a single
  source of truth plus an explicit rule that H1 text is exempt from the harness cap.
- **H1b vs R1b.** R1b requires a ≥100-line window on an unsearched path; H1b caps at 40 lines.
  A read that satisfies R1b is guaranteed to be cut by H1b, producing a partial file the model
  may then re-read — which is partly what R1 exists to prevent `[material]`.
- **OS.** `outputScrub` runs on by default with an undescribed class list; its interaction with
  AT1 (telemetry) decides whether scrubbed or raw content leaves the machine `[material]`.

---

## 5. Security comparison against published guidance

**Layering.** The rule set is genuine defence in depth — block → escalate → confirm → lint — and
that composition is the structure the Checkmarx agent-security overview recommends, which frames
risk across identity/permission sprawl, unsafe tool invocation, and memory or context poisoning,
and insists controls cover the operational context and integrations, not just the model.

> "Unsafe tool invocation / tool misuse: Agents may invoke incorrect tools, pass unsafe inputs,
> or execute unintended operations" — Checkmarx.

Mapped here: unsafe invocation → SS1/SS2/SS3/PB1; unsafe inputs → AG, P4; unintended operations →
H2. The uncovered part of Checkmarx's taxonomy is **permission sprawl**: `subagent` spawns children
with arbitrary `cwd` and `model` and no scope rule, which is exactly the "accumulate identities and
excessive access rights" pattern.

**Memory and context poisoning.** Checkmarx: "Attackers can inject malicious information into an
agent's memory or context, influencing future decisions." The relevant surfaces here are
`subagent.task` / `subagent_message` and the persisted violation memory (VM). VM is a durable
context store with no described integrity check `[material]`.

> "Hidden instructions inside content an agent reads can redirect a trusted Skill" — Backslash.

That is the same channel as `subagent_message` and as file content pulled in by `piread`; Backslash
also notes review scope is "what the Skill can reach, not only whether it looks malicious", which
is the argument for scope rules on path parameters rather than content heuristics.

**Parse vs prefix matching.** P3 word-boundary regexes are prefix/text matching. Only P4 parses.
Backslash's point that "process-level endpoint telemetry records that a command ran, but not which
Skill, agent or MCP server caused it" is the observability counterpart: AT1 without per-tool
attribution cannot answer "who caused this command".

**Symlink / TOCTOU — direct confirmation of the flagged gap.** The Endor Labs write-up on the Brig
sandbox (GHSA-wp6x-29qx-fpr7, ENDOR-VUL-2026-1809) describes precisely the failure shape found in §2:

> "brig guarded the working directory carefully, [but] handed the project folder to the underlying
> runtime as a raw path, without checking where it actually pointed. Because the agent already has
> read-write access to that project folder, it can swap one of the subfolders for a shortcut (a
> symlink)... escape the sandbox."

This confirms the class for `write.path` and `pidx out`: validation of the path string without
resolution of what it points to. Note the crucial asymmetry here — `piedit` *does* resolve symlinks
for protected targets (GT1), so the codebase already contains the correct implementation and the gap
is that `write` and `pidx` do not share it. Endor also makes the point that isolation strength was
irrelevant: "strongest mode runs the agent in a microVM... and that isolation was never the problem."
Capability scoping at the parameter, not the sandbox, is what failed.

**Correction to earlier draft.** `arxiv.org/html/2602.01655v1` is **ProjDevBench, a benchmark paper,
not a security analysis**. No traversal sub-pattern taxonomy can be attributed to it; the earlier
path-normalisation recommendation now rests only on the Endor material.

**CVE citation.** `codeant.ai/vulnerability-database/cve-2026-62677/copy` returned navigation
boilerplate only. It is cited at title level only — as a placeholder for "permission logic that
diverges between copied code paths" — and carries no evidentiary weight. The divergence argument
stands independently on the `write` vs `piedit` asymmetry in §2.

**Sandbox escape generally.** No rule in the set constrains filesystem *reads* outside a scope;
R1b and R1c are efficiency guards, not confidentiality controls. Against Checkmarx's "including
their integrations with APIs", note there is no rule at all for network egress via `pibash`.

---

## 6. Prioritised recommendations

1. Route `write(path)` through the same `normPath` + symlink resolution + H2 ladder that `piedit`
   uses. This closes the Endor-class gap with code that already exists.
2. Constrain `pidx out/state/sessionsDir` to a hidden state directory; require confirmation on
   `force`; make `pidx stdout` output still pass H1's byte cap.
3. Scope `subagent cwd` to inside the repo, scan `task` and `message` for native-tool impersonation
   text, and namespace `name` per parent session.
4. Pin down H2: state confirm-expiry as deny, and extend coverage to sudo, package install,
   secrets access, and git operations per AGENTS.md.
5. Unify output limits: one authority for the 40-line/2KB figure, explicitly exempt H1 corrective
   text, and set H1b ≥ R1b's minimum window.
6. Replace P3's word-boundary regex with P4-style parsing, or demote P3 to advisory linting.
7. Give the "searched path" predicate (R1b) and the "identical re-run" key (R10/RB) a named,
   inspectable source.
8. Make CN compaction-aware (persist counters across `session_compact`) and shorten VM recall or add
   an in-session repetition counter.
9. Add per-tool attribution to AT1 so telemetry answers "which agent caused this" (Backslash).

---

## Gaps

- The audit rests on the provided ground-truth summary, not a read of the TS modules; behaviours
  described as "unstated" may be implemented but were not visible in the material.
- Unverified internals: H2 confirm-expiry default, R1b "searched path" source, R10 identity key,
  OS scrub classes, AT1 payload, VM storage location, SS2 pipeline parsing.
- Q5 coverage is partial: Checkmarx (taxonomy), Endor Labs (symlink/TOCTOU), Backslash (review
  scope and telemetry) are substantive; the CodeAnt CVE page is boilerplate; the arXiv item is not
  a security source and has been retracted from the comparison.
- Threshold claims (150k vs typical compaction triggers) are `[uncited]` model knowledge.

## Sources

1. [AI Agent Security: Risks, Controls and Best Practices](https://checkmarx.com/learn/ai-security/ai-agent-security-risks-controls-and-best-practices) — risk taxonomy (permission sprawl, unsafe tool invocation, memory/context poisoning) used to map rule coverage.
2. [Project Mount: symlink traversal in Brig](https://www.endorlabs.com/learn/project-mount-symlink-traversal-in-brig-how-a-sandbox-reaches-host-directories-it-was-never-given) — GHSA-wp6x-29qx-fpr7 / ENDOR-VUL-2026-1809: raw-path handoff without resolution; confirms the `write.path` / `pidx.out` class.
3. [What a security review of an AI agent skill should cover](https://www.backslash.security/learning/what-a-security-review-of-an-ai-agent-skill-should-cover) — reach-based review scope, hidden-instruction injection, per-tool telemetry attribution.
4. [CVE-2026-62677](https://codeant.ai/vulnerability-database/cve-2026-62677/copy) — title-level citation only; page content was navigation boilerplate.
5. [ProjDevBench (arXiv 2602.01655v1)](https://arxiv.org/html/2602.01655v1) — benchmark paper, **not** a security analysis; retracted from the comparison.
6. `extensions/permission-gate/config.ts` per task ground truth GT1 — rule keys, defaults, precedence, hook list.
7. Task ground truth GT2 — tool parameter surface and harness result cap.
8. Task ground truth GT3 (AGENTS.md) — documented workflow.

---

## Adjustment plan (workflow-first)

**Objective.** Make the gate cost zero turns on justified reads, block only what the documented
workflow already forbids, and close the two path-parameter holes — without touching a rule that is
already correct.

**Hard constraints, restated operationally.** (i) No blocker may fire on a pattern the workflow
permits; (ii) no rule may convert one justified read into N iterations; (iii) locate-before-read
survives intact; (iv) a justified full read is exactly one call; (v) conditional, cheapest-first
evaluation; (vi) every inference below is tagged — `[measured]`, `[material]`, or `[inferred]`.

**Standing caveat.** Session evidence from the last 3 days is being compiled separately and will be
cross-checked against every `[inferred]` tag before implementation. Any change whose friction
estimate is contradicted by that evidence is dropped, not defended.

---

### 7.0 Design principle: the predicate ladder

Every read rule must be evaluated as one ordered ladder, cheapest check first, first-match wins,
and the **allow** outcome must be reachable — a ladder with no allow path inevitably produces
false positives:

```
1. path in session read-set AND span already returned   -> R1 allow  (no block, no warning)
2. path seeded by rg/fd/pidx this session                -> R1b allow (any window, incl. limit=0/full)
3. requested window >= 100 lines OR limit unset (full)   -> R1b allow
4. file line-count < 100 (stat only, no read)             -> R1b allow (whole file in one pass)
5. an edit is pending on this path (AG certification)     -> R1b allow (full read is the safe move)
6. otherwise                                             -> R1b block + corrective rg suggestion
```

Clause-by-clause workflow mapping — each must hold for the change to ship:

| Ladder step | Workflow clause it matches 100% |
|---|---|
| 2 | "rg-first, then read" — the seed *is* the rg call `[material]` |
| 3 | "windowed reads" — ≥100-line window is the documented norm `[material]` |
| 4 | "locate before read" is satisfied by whole-file containment; nothing to locate `[inferred]` |
| 5 | TDD + edit-certification: AG requires the anchor be read in-session `[material]` |
| 6 | "windowed reads on an unsearched path" — the only genuinely blockable case `[material]` |

Steps 1–5 are allowances, so they cannot violate constraint (i). Only step 6 blocks, and it blocks
exactly the case the workflow names. This is the central argument of the whole plan: **R1b's
blocking surface should shrink to the one documented case and nothing else.**

---

### 8. (a) Friction-removal changes

Each row: current behaviour, exact new condition, workflow clause, switch key, fail-closed story,
and evidence status.

**F1 — R1b full-read escape hatch** *(highest value; resolves the owner's stated friction)*

- Current: block when window <100 lines on a "searched path is absent". No allow path other than
  the 100-line window `[material]`.
- New condition: allow if **any** of — path already seeded by rg/fd/pidx this session; `limit`
  unset (implicit full read); `stat(path).lines < 100`; a `piedit` on that path was called or is
  pending in the same tool batch. Block only when all four are false and the window is <100.
- Rationale against constraint (ii): a 60-line file currently costs 2 blocks + 2 retries or a
  100-line read of a 60-line file; step 4 makes it one call `[inferred]` — the line count is
  obtainable without reading content, so the check is O(1) extra work.

**F2 — R1 re-read exemption for continuation windows**

- Current: any re-read of an in-context span is blocked `[material]`. Line numbers shift after an
  edit, decertifying earlier spans — the current design already names this in the Anchor Guard
  rule, but R1 is described as span-keyed `[material]`.
- New condition: allow a re-read when the requested range is (a) non-overlapping with the
  in-context set and (b) adjacent to it (continues a paging sequence), or (c) the file's mtime or
  size changed since the last read. Block only fully-covered re-reads.
- Why this is not a loosening: the rule's own purpose (avoid paying for bytes already in context)
  is preserved exactly for the fully-covered case `[inferred]`.

**F3 — H1b cap raised to R1b's minimum window** *(must land with or before F1)*

- Current: H1b caps read output at 40 lines / 2048 bytes; R1b demands ≥100 lines `[material]`.
  A legal read is therefore always truncated, which reinstates multi-iteration paging — the exact
  cost constraint (ii) forbids.
- New condition: `minLines = max(currentH1bLines, R1b.minWindow)` = 100 lines; bytes raised
  proportionally (100 lines of a typical source file ≈ 4–6 KB `[inferred]`). Apply only to
  `piread` results, never to `pibash` (H1 keeps its 40/2048 for shell output).
- Sequencing note: F3 without F1 still leaves step 3 truncated; **F1 and F3 ship in one change**.

**F4 — H1 de-duplication against the harness cap** *(removes the double-trim)*

- Current: H1 (40 lines / 2048 B) equals the harness-side cap (≈40 lines / 2KB), so one of them is
  always a no-op and corrective text may be truncated by the other `[material]`.
- New condition: H1 reads its thresholds from the harness's declared cap (single source of truth);
  H1's own corrective/blocked text is explicitly exempt from the harness trim.
- Zero friction risk: this only removes a truncation of the gate's own messaging `[inferred]`.

**F5 — R1b's "searched path" predicate made explicit and cheap** *(enabler for F1)*

- Current: predicate source unstated `[material]`.
- New condition: a session-scoped set of paths, populated by SS1/SS3/`pibash` rg/fd calls and by
  `pidx`. Populated on the *command*, not on parse output, so it costs one set-insert `[inferred]`.

**F6 — R10 rerunGuard allowlist for read-only probes** *(optional; lowest priority)*

- Current: identical command within 10 min blocks `[material]`. Blocks idempotent status checks.
- New condition: allow re-run when the command matches a read-only allowlist (`git status`,
  `git diff`, `ls`, `cat`) — or simply exempt commands in the SS-family's own suggested vocabulary.
- Flagged as low confidence: the friction may be illusory. Cross-check session evidence first.

Fail-closed-by-default, for every row above: each new key defaults to the **current behaviour**
(`fullReadEscape=false`, `rereadContinuation=false`, `readCapFollowsWindow=false`, …). Turning a
key on is a deliberate act; a malformed config falls back to defaults, which are the rules as they
ship today. That satisfies "fail-closed on missing/malformed config" `[material]` while making
every change reversible at runtime.

---

### 9. (b) Speed optimizations

**S1 — Keep R1c locate-first as the sole front-door check.** No change. Locate-before-read is
preserved exactly as the owner requires (constraint iii); the plan removes *consequences* of a
missed locate, not the locate requirement.

**S2 — Publish an explicit full-read justification predicate.** The predicate is the ladder's
steps 2–5, named as one function (`shouldAllowFullRead(toolInput, sessionState)`), so that:
(a) the model can predict it from the prompt text; (b) a test can enumerate its truth table;
(c) the corrective message can name *which* step would have allowed the read. Corrective text
should read, e.g., "seed with `rg -n 'pattern' path` first, or pass `limit` unset to read the
whole file in one pass" — an instruction the workflow already endorses `[inferred]`.

**S3 — Evaluate in cost order, stat before read.** Steps 3 and 4 need only the requested window
size and `stat` line count — no content read — so the ladder is O(1) in file bytes `[inferred]`.

**S4 — Batch awareness.** The workflow says batch independent calls `[material]`. When one tool
batch contains both a `pibash` rg call and a `piread` on the same path, the ladder must evaluate
against the batch's *intended* seed set, not only already-completed calls — otherwise a correctly
batched turn is blocked `[inferred]`. This is a false-positive source worth explicit handling.

**S5 — Do not add a second read rule.** P1's read-family work in native paths duplicates R1c
`[material]`. Leave P1 installed but make the ladder the single authority; adding another
read-gate is the failure mode constraint (ii) warns about.

---

### 10. (c) Security fixes, sequenced first (zero workflow friction)

These touch path parameters the workflow never exercises riskily, so they can ship ahead of the
friction changes:

**X1 — `write(path)` shares `piedit`'s ladder.** Reuse the existing `normPath` + protected-target
symlink resolution + H2 confirm, verbatim, by factoring the current `piedit` path check into one
function both call. This is the Endor-class gap closed with code already in the repo `[material]`.
Friction: none for normal repo-relative writes; only a protected target or symlink-to-protected
target prompts — which the owner's own "ask before destructive" clause already requires `[material]`.

**X2 — `pidx out/state/sessionsDir` constrained.** Resolve each, require containment inside the
configured state dir (or the repo root), and route protected targets through H2. `force` gains a
confirm. `stdout` output remains subject to H1.
Friction: zero for `pidx` used as documented (pointer-only extraction into its own state dir)
`[material]`.

**X3 — `pibash timeout` ceiling.** Cap the timeout at a configured maximum; exceeding it gets the
existing malformed-input corrective path rather than a hard failure.
Friction: none observed; a very long timeout is not a documented workflow pattern `[material]`.

Sequencing argument: X1–X3 have no read-path involvement, so they cannot cause the false-positive
class the owner is worried about. Shipping them first banks the security win before any read-gate
surgery lands.

---

### 11. (d) Do-NOT-change list

Correctly aligned today — the implementer should not touch these, and any diff that does is a
review failure:

| Key | Why it must stay as-is |
|---|---|
| AG editAnchorGuard | Byte-exact anchors are pure correctness; F2's mtime exemption must not weaken it `[material]`. |
| R1c locateFirst | This *is* constraint (iii); the plan's entire premise `[material]`. |
| SS1 searchScope | Matches "scope every search"; also feeds F5's seed set `[material]`. |
| SS2 searchMidPipe | Blocks the grep-mid-pipe habit the workflow forbids `[material]`. |
| SS3 findFirst | fd-before-find; same reason `[material]`. |
| PB1 searchPortability | macOS+Linux subset is a documented rule `[material]`. |
| P4 codemodeScriptGuard | The only parse-level check; reference implementation `[material]`. |
| R9 commitMessageLint | Exact match to the ≤72-char body rule `[material]`. |
| H2 destructiveConfirm | Alignment question is expiry semantics only — do not alter the trigger set while X1 reuses it `[material]`. |
| TC2 toolchainNode | `.nvmrc` pinning matches the pinned-interpreter rule `[material]`. |
| H1 bash-side cap | Unchanged for `pibash`; only the `piread` side moves (F3) `[material]`. |

---

### 12. (e) Per-change verification

| Change | Proves no false positive | New regression fixture |
|---|---|---|
| F1 | existing large-read fixture in `gate:eval`; rerun whole eval suite, assert no new blocks on the documented-workflow transcript set | `fullread-escape.spec`: 40/80/99/100/101-line files × {rg-seeded, unseeded, limit-unset, edit-pending} → 3×4 allow matrix, only unseeded+<100 blocks |
| F2 | re-read eval cases already present | `reread-continuation.spec`: adjacent contiguous window allowed; fully-covered window blocked; mtime-changed window allowed |
| F3 | `piread` cap fixture | `cap-window-parity.spec`: R1b.minWindow ≤ H1b.lines asserted as an invariant (fails today) |
| F4 | output-cap eval cases | `double-trim.spec`: corrective text survives the harness trim verbatim |
| F5 | search fixtures | `seed-set.spec`: rg populates the set; a set-inserts-on-command test |
| F6 | rerun eval cases | `rerun-readonly.spec`: `git status` ×2 allowed; identical `piedit` payload blocked |
| X1 | none needed for workflow paths; add negative cases | `write-path-ladder.spec`: symlink-to-`~/.ssh` prompts exactly like `piedit`; plain repo write silent |
| X2 | `pidx` eval cases | `pidx-scope.spec`: `out` outside state dir rejected; `force` requires confirm |
| X3 | bash fixtures | `timeout-ceiling.spec`: over-cap timeout returns corrective text, not an error |

Gate for the whole batch: `npm run check` plus a full `gate:eval` run with **zero** new blocks on
the documented-workflow transcript corpus. A single new block on that corpus fails the batch — that
is the operational meaning of constraint (i).

---

### 13. (f) Rollout order and rollback

1. **X1–X3** (security, no read-path effect) — verify, land. Rollback: revert the shared-ladder
   call sites; `piedit` behaviour is untouched because the factoring is a pure extraction `[inferred]`.
2. **F3 + F1 together** (the read-path pair) — behind `PGATE_READ_FULL_ESCAPE` and
   `PGATE_READ_CAP_FOLLOWS_WINDOW`, both defaulting off. Enable in a two-step canary: F3 first,
   measure paging count, then F1.
3. **F5** (seed-set) — may precede F1 if F1 is enabled via the same entry point; default off.
4. **F2** (re-read continuation) — default off; enable only if session evidence shows blocked
   continuation windows.
5. **F4** (single-source cap) — default on is safe; it only affects gate text. Roll back by pinning
   literal thresholds.
6. **F6** (rerun allowlist) — last and optional; skip entirely if evidence shows no friction.

Rollback is per-key and needs no deploy: setting a key to its default-off value restores today's
behaviour exactly. Because defaults reproduce current rules, a mid-rollout abort is always safe
`[inferred]`.

---

### 14. Inferences requiring confirmation before implementation

- `[inferred]` Line count is obtainable via `stat` without a content read — true for the harness's
  Rust tools by construction, not verified from source here.
- `[inferred]` `piedit`'s protected-path check is factorable as a shared function — depends on
  module boundaries not visible in the ground truth.
- `[inferred]` Batch-level seed evaluation is achievable in the `tool_call` hook; hook ordering
  within a batch is undocumented `[material]`.
- `[inferred]` A 100-line `piread` result is ~4–6 KB; byte cap must be chosen from measurement.
- `[inferred]` R1 actually blocks shifted-line re-reads post-edit — the material names the shift
  risk in the Anchor Guard text but does not state R1's keying.

All six are cross-check targets for the separately-compiled session evidence. None of them
justifies shipping a change before that check.
