# The Compaction Dead-Zone: Read Elision vs Edit Certification

Research note, 2026-10-27.

> **Status: implemented 2026-10-27 (C2+C3).** `omissions[]` now ships in
> `details.compaction` (compress.rs/envelope.rs/pipeline.rs), the gate
> records gap spans (`read-coverage.ts`) and appends the sanctioned sub-window
> remedy (anchor-guard.ts), SYSTEM.md's Re-reads rule is instruction-only, and
> `permission-gate`/`piread-parity`/`read-coverage` suites carry the lock-ins
> (§5.4). C4 remains a later option per §5.5.

Scope: one design flaw in the permission-gate — the gap between what a
compacted `piread` result puts in context and what the Anchor Guard (AG) accepts as an edit anchor.
Research only; no code, SYSTEM.md, or tests were changed. All paths are relative to `/Users/nur/.pi/agent`
unless absolute. Session cites are 1-based JSONL line numbers in
`sessions/--Users-nur-Barikoi-dropx-merchant--/2026-10-26T12-26-36-935Z_01a1782d-4c07-7786-a229-257cb772f87a.jsonl`.

## 1. The flaw, as verified in the evidence session

An anchor line can be simultaneously **un-editable** (AG refuses it) and **"un-re-readable"**
(a SYSTEM.md rule tells the model never to re-read it). The model resolves this only by ignoring one
rule. Timeline (line numbers re-verified against the JSONL; the task brief's 97/99 are actually 94/96
— L99's `omitted 1500 chars / 45 lines` belongs to a different read, window 195–274):

| Session line | Event |
|---|---|
| 94 | Assistant calls `piread {offset:140, limit:40}` (window 140–179) and `{offset:95, limit:30}` on `__tests__/redux/features/order/orderApi.test.ts` (280 lines). |
| 96 | Result of 140–179, head-tail compacted by piread: printed 140–163, marker `[... omitted 153 chars / 5 lines ...]` (**file lines 164–168 never entered the transcript**), printed 169–179, tail notice `[100 more lines ... offset 180]`. |
| 211 | Six parallel `piedit` calls; one `edits[2].oldText` = `} catch (error: any) {`, which lives on line 164. |
| 212 | Block: `Anchor Guard (Unread): ... edits[2] targets lines 164–164, not in certified context — read lines 164–164 with the piread tool (piread {offset:164, limit:1}) first.` |
| 218 | Remedy reads issued (`{offset:162, limit:4}`); **allowed** by R1 (the gap is not "covered"). |
| 221–222 | Retry edit passes (`Successfully replaced 5 block(s)`). |

Session-wide friction: 8 AG-Unread blocks against 62 successful edit results (~13 per 100); 1 provably
elision-caused (line 164), the rest ordinary-unread or uniqueness blocks (e.g. L215).

## 2. Mechanism: three components, one marker

1. **piread compaction.** `PI_READ_COMPRESS` is on by default; reads over 40 lines / 2 KB are reduced
   to head+tail plus `[... omitted N chars / M lines ...]` (docs/native-tools.md:16, :67). The omitted
   bytes are dropped **before** the result is recorded — the transcript (L96) contains only head+tail.
   Diagnostics ride in `details.compaction {strategy, originalChars, visibleChars, omittedChars,
   partial}` (extensions/piread/index.ts:190–199), which never reaches the model — and carries **no
   line ranges**.
2. **Gate coverage model.** `renderedSpansFromBlocks` (extensions/permission-gate/read-coverage.ts:248–266)
   parses that exact marker regex, treats it as a gap of the stated line count, and certifies only the
   rendered runs: "Only the rendered runs entered context, so only they may certify." R1 blocks a read
   only when its window is **fully covered** (read-coverage.ts:1–4), so a sub-window read of an elided
   gap is always allowed — tested at tests/permission-gate.test.mjs:639–646 and :4166–4226 (backlog §9,
   added 2026-10-25, one day before this incident).
3. **Anchor Guard.** AG first proves the anchor byte-exact-unique against the **current file on disk**
   (anchor-guard.ts:175–196 — that is how it can report "targets lines 164–164"), then applies the S5 M2
   region-read requirement: no certified coverage → block with a `piread {offset, limit}` remedy
   (anchor-guard.ts:260–295). The block comment names the design intent: anchors with no coverage
   "came from assumption or bash output (the luck-match silent-corruption class)".

**The contradiction.** SYSTEM.md:13 (Re-reads) says: "Display elision (`[... omitted ...]`) means the
bytes ARE in context — never re-read for those. A `piread` window is different: only the lines it
actually printed are certified, so a gap in a printed window is a real gap, not elision." In a
piread-native harness every `[... omitted ...]` marker a model meets **is** piread compaction (the
built-in read is hard-blocked), so the first sentence is the one that fires: the model treats the
marker as bytes-in-context, skips the remedy read, edits, gets blocked, and the remedy now instructs
the exact action the rule just forbade. The two sentences share one trigger pattern with two opposite
meanings — the doc-level deadlock. (The audit already flagged the cousin conflict H1b: a 40-line cap
below R1b's required 100-line window — research/permission-gate-audit.md:24.)

## 3. Prior art (web)

- **Claude Code — read-state vs compaction.** Issue #85488: after auto-compaction, `Edit`/`Write` fail
  with `File has not been read yet` on files read earlier in the same session and unchanged on disk.
  Reporter measured it in 340 of 5,096 transcripts (0.077/transcript) and calls it "the most common
  recoverable tool error". Two remedies proposed: carry read-state across compaction with an
  mtime/size check at write time, or transparently re-read small files instead of erroring. Closed as
  not planned. Lesson: this collision exists in production agents, and both remedies keep read-state
  in **tool-side bookkeeping validated against disk**, never in model-visible context.
  https://github.com/anthropics/claude-code/issues/85488
- **Claude Code — rules not surviving compaction.** Issue #7533: read-the-whole-file instructions lose
  priority after compaction. Lesson: prose rules degrade under compaction; a gate block with an
  actionable remedy is the durable channel, so the exception belongs in the remedy text, not only prose.
  https://github.com/anthropics/claude-code/issues/7533
- **Anthropic context editing.** Cleared tool results are replaced by "placeholder text indicating to
  Claude that it was removed". Lesson: absence must be marked as absence and be distinguishable from
  presence. Our flaw is one marker meaning "present but hidden" (doc) and "absent" (gate).
  https://platform.claude.com/docs/en/build-with-claude/context-editing
- **Aider.** No read-before-edit certification at all: SEARCH/REPLACE blocks are validated by exact
  match against the file on disk at apply time; a non-matching block is rejected and the model re-emits
  (see the recurring failure class in #3651). Lesson: the disk-match pole — anchors from any source are
  safe iff they match disk. Our AG already disk-matches first; certification is the repo's chosen extra
  discipline (S5 M2), so Aider's pole is available but was deliberately rejected here.
  https://github.com/Aider-AI/aider/issues/3651
- **SWE-agent.** Windowed viewer (100-line window, "(N more lines above)" notices); edit commands are
  bound to the currently shown window, and failed edits are validated and retried with the would-be
  result shown (secondary deep-dive write-up). Lesson: binding edit anchors to what is actually shown
  makes certification trivially match display. https://dev.to/ (SWE-agent deep dive; secondary)
- **SWE-Edit (arXiv:2604.26102).** Viewer subagent extracts decision-relevant snippets on demand;
  Editor subagent decouples edit generation. Cost −7.7%, edit success +0.9% on SWE-bench. Lesson:
  on-demand snippet extraction (our remedy read) is a proven pattern, not a hack.
  https://arxiv.org/abs/2604.26102
- Secondary, unverified against a primary changelog: Claude Code reportedly re-reads up to five
  recently-touched files after compaction (proactive re-certification). https://www.ai-toolbox.co/

## 4. Candidates

Evaluation axes: correctness = still blocks genuinely stale/uncertified anchors; friction = extra
blocked calls per 100 edits; consistency = removes the doc-vs-gate contradiction; cost = work in this
repo (permission-gate extension + piread native daemon/envelope); compaction risk = interaction with
elision and with harness context compaction.

### C1 — Certify elided spans (treat the omission as covered)
Change `renderedSpansFromBlocks` (or bypass it) to certify the whole requested window, gap included.
- Correctness: **fails**. Certifies bytes the model never received; re-opens the exact 2026-10-18
  blind spot the `midFile` fixture documents (tests/permission-gate.test.mjs:449–460: a 13 KB read
  passed the 24 KB floor, compaction hid 11.5 KB, model "treated it as read").
- Friction: 0. Consistency: makes SYSTEM.md's first sentence true by fiat.
- Cost: trivial. Compaction risk: **high** — once the gap is "covered", R1 blocks the remedy sub-read
  (piread-parity.test.mjs:524–530 locks that fully-covered windows block), so an anchor that then
  mismatches on disk has no recovery path. Reject.

### C2 — Sanctioned sub-window remedy (doc + remedy text only)
Keep gate behavior identical; fix the rule so the remedy read is explicitly legal.
- Correctness: unchanged (strongest — AG keeps S5 M2 intact). Friction: unchanged (~1 round-trip per
  dead-zone edit; measured ≈1.4/100 edits in the evidence session; Claude Code analog 0.077/transcript).
- Consistency: fully resolves the deadlock — one meaning for the marker, remedy sanctioned by rule.
- Cost: SYSTEM.md text + one sentence in the AG remedy string. Compaction risk: none.

### C3 — Structured coverage map (piread emits omitted spans; gate consumes them)
Extend `details.compaction` with per-omission line ranges `{startLine, endLine, chars, lines}`
(compress.rs already computes them for the marker text); `renderedSpansFromBlocks` prefers the
structured list and keeps the marker regex as fallback for the builtin/one-shot path.
- Correctness: unchanged; makes under-certification **machine-enforced** instead of display-format
  parsed (robust to marker wording drift, PI_READ_LINE_CAP interplay). Friction: unchanged alone.
- Cost: moderate — Rust side + envelope plumbing + gate consumer + tests. Compaction risk: low;
  structured data rides in details, never model-visible content.

### C4 — Freshness-verified downgrade for anchors inside a recorded omission
When AG has located the anchor byte-exact-unique on disk **and** the anchor's lines fall inside a
recorded omission span of a read whose stat/hash chain still holds → pass (optionally with a warning)
instead of blocking.
- Correctness: genuinely stale anchors still block (they fail the disk match at anchor-guard.ts:175
  before certification is even consulted). But it waives "the model saw these bytes" for the class S5 M2
  exists to catch — anchors that necessarily came from rg/sed/memory. Contradicts a documented design
  decision; would need an explicit S5 M2 amendment.
- Friction: eliminates the dead-zone class. Cost: highest (needs C3 first). Compaction risk: medium.

## 5. Recommendation: C2 + C3 (machine-distinguishable absence, sanctioned remedy)

### 5.1 SYSTEM.md:13 — replace the two elision sentences
Delete: "Display elision (`[... omitted ...]`) means the bytes ARE in context — never re-read for
those. A `piread` window is different: only the lines it actually printed are certified, so a gap in a
printed window is a real gap, not elision."
Insert: "An `[... omitted N chars / M lines ...]` marker inside a piread result is a compaction gap:
those bytes were never delivered and are uncertified — do not anchor edits in a gap. To edit inside
one, read that sub-window first (the Anchor Guard remedy names it); R1 never blocks reads of
uncertified lines, so a remedy read is not a re-read violation. Lines are in context only when piread
printed them or your own edits replaced them."

### 5.2 Gate changes
- anchor-guard.ts:285–295 (region-miss remedy): append to the reason —
  `; the target falls in a compaction gap — this sub-window read is permitted (uncertified lines are never re-reads).`
  No predicate change.
- read-coverage.ts `renderedSpansFromBlocks`: accept an optional structured `omissions` list (from
  `details.compaction`); use it when present, else the existing regex (kept as fallback). Under-certifies
  identically — the two paths must agree (test below).

### 5.3 piread change
compress.rs: emit per-omission `{startLine, endLine, chars, lines}` into the existing envelope
`details.compaction.omissions[]` (extensions/piread/index.ts:190–199). Model-visible content unchanged.

### 5.4 Validation plan
1. tests/permission-gate.test.mjs (AG side of §9 — currently only the R1 side is tested, :4166–4226):
   - compacted-read fixture (reuse the §9 text builder) + edit anchored on a gap line → blocked, reason
     matches `/read lines \d+–\d+ .*permitted/`;
   - full cycle: compacted read → blocked edit → sub-read of the gap → same edit passes;
   - twin of :4214: edit anchored in the rendered head still passes;
   - multi-edit call with one head anchor + one gap anchor → single block naming only the gap lines;
     one remedy read unblocks the whole call.
2. tests/piread-parity.test.mjs: parity runs with `PI_READ_COMPRESS=0` (:48–49), so add a separate
   compaction-on case on a >40-line fixture asserting (a) marker present, (b) structured
   `omissions[]` equals the spans parsed by the regex fallback path, (c) the existing R1 duplicate-read
   lock (:524–530) still blocks re-reads of *rendered* lines while a gap sub-read passes.
3. gate-bypass.test.mjs / pgate-region-off.test.mjs: structured path must not over-certify.
4. Replay: index the evidence session with pidx and confirm the L96 gap yields the same
   block-remedy-retry cycle with no new blocks.

### 5.5 C4 as a later option
If dead-zone friction proves material after C2+C3 land, C4 can be added behind config with an explicit
S5 M2 amendment note in anchor-guard.ts:260–264; it must require the C3 structured map and a valid
stat/hash chain, and must never fire when the file changed since the elided read.

## 6. Recommendation

Adopt C2+C3: fix SYSTEM.md:13 so a compaction marker has exactly one meaning — bytes never delivered,
uncertified for edits, always legal to re-read — teach the AG remedy to say so, and harden the gate by
having piread publish its omission line-ranges in `details.compaction.omissions[]` so certification
rests on structured data rather than a display-format regex. This keeps the Anchor Guard fully intact
for every genuinely stale or never-read anchor (the audit calls it "the strongest correctness guard in
the set", research/permission-gate-audit.md:15), costs the model at most one sanctioned round-trip in
the rare dead-zone case (≈1.4 per 100 edits observed; Claude Code's production analog sits at
0.077/transcript, github.com/anthropics/claude-code/issues/85488), eliminates the rule deadlock that
currently forces the model to disobey either SYSTEM.md or the gate, and matches the two strongest
lessons from prior art: keep read-state in tool-side bookkeeping validated against disk (Claude Code
#85488), and mark absence unambiguously instead of letting one symbol mean both presence and absence
(Anthropic context editing).
