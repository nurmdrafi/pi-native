# piread Compaction: Every Method Tried, Outputs, and the Verdict

Research note, 2026-10-28.

> **Status: resolved + property-locked.** Head-tail with line-exact structured
> omissions (single-base attribution) + the gate's backward-anchored coverage
> walk is the shipped approach. A 300-case reconstructive sweep
> (`rust-tools/piread/src/compress.rs`, `reconstructs_the_window_exactly`)
> pins it. Successor record to `research/gate-elision-deadzone.md` (C2+C3);
> that doc's §5.5 C4 downgrade is no longer needed.

Question: is there a better option than head/tail for `piread`, and can
`pibash`'s compaction be applied to it? Scope: the elision strategy only —
the omission-marker grammar (`[... omitted D chars / N lines ...]`) is shared
by both tools and unchanged throughout.

## 1. Methods tried, in order, with outputs

| # | Method | Where / when | Output |
|---|--------|--------------|--------|
| 1 | Silent hard cap (truncate, no marker) | pre-native built-ins | Unmarked absence: the model cannot distinguish elided from absent; silent anchor corruption class. Rejected. |
| 2 | Tail-keep 2000 ln / 50 KB + spill to temp file | `pibash` raw pipeline tier-1 (`truncate.rs`) | Keeps errors (end of output) but loses the head — wrong for reads, where the window head is what was asked for. Kept for bash only. |
| 3 | Head-tail, success/failure asymmetric (success 2/3 head, failure 2/3 tail), command-kind aware (Test/Build/Git/Search/Log/Generic) | `pibash` tier-2 (`compress.rs`, `head_tail`) | ~2 KB ceiling for any output size; bench: bash 10k lines 173 B native vs 10,129 B built-in (−98.3%). Success semantics do not exist for file reads. |
| 4 | ErrorPriority: actionable lines kept verbatim, non-actionable repetition collapsed | `pibash` strategy (`compress.rs`) | Best token economy on repetitive output; no line-exact publication (bash output is never an edit anchor). The one idea portable to piread — deferred, no measured need. |
| 5 | Head-tail 2/3 : 1/3 + omission marker + `[Showing lines …]` continuation notice | `piread` (`compress.rs`, shipped 2026-10-27) | Bench: read ~1000 ln 1,945 B vs 41,275 B (−95.3%); ~1922 ln −96.0%. Reads and shell output converge on the same ~2 KB ceiling. |
| 6 | C3: structured `omissions[]` (start/end/chars/lines) + gate marker-walk with count-fence | `gate-elision-deadzone.md` C2+C3, 2026-10-27 | Machine-distinguishable absence, but attribution drifted ±1–2 lines: recorded gap 43–46 when the truly elided lines were 44–47 (evidence: 2026-10-27 session `01a17e5e`, `details.compaction.omissions` vs git ground truth). Caused one false Anchor Guard block (gap over-covered a rendered line) and a dead-ended re-read remedy (span certified as covered). Root cause: `start_line` derived from `str::lines()` (drops a trailing kept-empty line) while `omitted_lines` derived from `kept` counters — two counting bases. |
| 7 | Single-base attribution `max(kept, rendered)` + TS backward anchor (`winEnd`) | 2026-10-28 fix | Drift class closed: the gap begins after the last line any bytes of which rendered; the gate's walk maps the final run onto the read window's end and honors structured ranges only when they agree. +4 lock-in tests (2 Rust skew cases, 2 TS anchor cases). |
| 8 | Reconstructive property sweep: 300 deterministic compactions (6 shape classes — blank-heavy, long-line, unicode, repetitive, mixed, plain — × 10 sizes × 5 budgets) | 2026-10-28, `reconstructs_the_window_exactly` | Proves: head run is a true prefix of the window; tail run a true suffix (shrunk past trailing blanks); every unrendered line is inside the structured gap or an invisible boundary blank; span width = marker count; byte budget holds. During construction it pinned two real subtleties: (a) the single-over-budget-line case publishes a virtual continuation gap (`start_line = 2` on a 1-line window) — the walk-parity convention; (b) tail-side trailing kept-empty lines are invisible after `join` — the tail twin of the head bug. |

## 2. External prior art (Tavily, 2026-10-28)

- **Pydantic AI harness — Tool Output Limits.** `TruncationStrategy` =
  `head` / `tail` / `head_tail` (default), `keep_tail_lines` (reserve whole
  tail lines), band actions with `Spill(then=truncate)` tiers. Same family as
  ours; no line-exact elision map anywhere in their docs.
  https://pydantic.dev/docs/ai/harness/tool-output-limits
- **Claude Code issue #85488** — read-state lost across auto-compaction →
  "File has not been read yet". Closed, not planned; reporter measured it in
  340 of 5,096 transcripts. Lesson (matching our architecture): read-state
  lives in tool-side bookkeeping validated against disk, never in
  model-visible context. https://github.com/anthropics/claude-code/issues/85488
- **Anthropic context editing.** Cleared tool results are replaced by
  placeholder text marking removal. Doctrine our markers implement, but
  line-addressable. No external system found that publishes structured,
  line-exact elision ranges.

## 3. Audit arsenal run against the method (2026-10-28)

- `diff-fuzz` 120 iterations: 0 failures. Full suites (parity, gate, unit):
  green throughout.
- **Cross-layer differential audit**
  (`tests/parity/piread-compaction-walk.test.mjs`): runs the real
  `bin/piread` (PI_READ_COMPRESS=1) over six fixture shapes × three window
  shapes, feeds the live envelope to the gate's `renderedCoverageFromBlocks`,
  and demands: walk gaps === structured spans, spans+gaps tile the window
  with no hole or overlap, marker count === omission count, head line
  renders. Single-layer tests were structurally blind to what it caught:
- **Finding, resolved (no-gap contract): trailing-empty-line windows.** A
  window whose last line is empty had that line popped by `split_lines` as
  a terminator phantom while the raw read path counts it in line numbering
  — one line neither rendered nor gapped. Fix: `compact` keeps the
  body-final empty line in its accounting (rendered by the tail or inside
  the gap); head+gap+tail now tiles every window exactly, including
  trailing blanks (Rust pin + JS differential pin, both exact).
- **Reusable session audit** (`tests/tools/audit/session-blocks.mjs`,
  `npm run audit:session`): parses any session JSONL directly (in-flight
  sessions included — the pidx gap) and reports chaining stats, the block
  ledger with gate families, remedy-recovery outcomes, and re-derives the
  compaction contract for every recorded `piread` result. On this session's
  own pre-fix data it auto-detected both historical drifts (SKILL.md gap
  25–149 vs structured 24–148; pre-push SKILL.md 44–47 vs 43–46) with zero
  manual jq.

## 4. Verdict

Head-tail + line-exact structured omissions + backward-anchored gate walk
(methods 5+7, locked by 8, gaps closed by the no-pop accounting) is the best available approach for `piread`:
nothing in prior art is line-exact, and the alternatives fail the contract —
silent caps and LLM summarization of elided regions (non-deterministic,
breaks edit certification) are rejected; tail-only kills head anchors;
pibash's success-asymmetry has no read analogue. The remaining lever, if
repetitive files ever show measured pain: port ErrorPriority run-collapsing
into `piread` using the same omission grammar (a collapsed run is just
another gap span; zero gate-side changes).
