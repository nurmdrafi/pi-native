//! Optional head-tail compaction for `piread` output.
//!
//! Why this exists: `piread` mirrors the built-in `read`, whose contract is a
//! plain head truncation (2000 lines / 50 KB). For a large file that still
//! ships ~9 KB of raw text into the model context, because the first 2000 lines
//! are all it ever sends — the *tail* (where a summary or final state usually
//! lives) is never seen and the head is emitted in full. `pibash` already
//! solves the same problem with `compress.rs`; this is the read-sized subset of
//! that design.
//!
//! Contract:
//! - **ON by default, with an off switch.** Compaction reshapes only the
//!   model-visible text, so parity with the built-in `read` is one variable
//!   away: `PI_READ_COMPRESS=0|false|off` restores byte-identical output, which
//!   the parity suite (`tests/piread-parity.test.mjs`) and `piedit`'s exact
//!   matching depend on.
//! - **Deterministic.** No clock, no run id, no iteration order: the same input
//!   always yields byte-identical output. Safe to cache and to diff.
//! - **Lossless elsewhere.** Only the model-visible `content` is compacted; the
//!   caller still knows `totalLines`/`totalBytes` from the existing truncation
//!   metadata, and a caller that needs the full text can re-read with a widened
//!   offset/limit window.
//! - **Idempotent.** A body that already carries the omission marker is never
//!   re-compacted (re-compaction would drop kept content and rewrite the count,
//!   breaking determinism).
//! - **Marker-compatible with `pibash`.** Same tag and wording, so one grep
//!   recognizes a compacted result from either tool.
//!
//! Budget: the same 40 lines / 2 KB that the permission-gate H1 cap enforces
//! (`extensions/permission-gate/bash-cap.ts`, mirrored in `pibash`'s
//! `compress.rs`). Compacting to that budget means H1 passes the result
//! straight through instead of re-cutting it, so the bytes we save are bytes
//! the model never pays for.

/// Model-visible read budget, from the shared bounds table (`read.window`):
/// 100 lines / 8 KB. It sits inside the permission-gate H1b read cap
/// (300 lines / 8 KB `bash.read`), so a whole window passes straight through
/// and a gap is only marked past it — a marker over <=60 lines costs the model
/// a whole re-read turn to close (measured: 482 gap-aimed follow-up reads in
/// 1756 calls over one day of transcripts).
pub const COMPRESS_MAX_LINES: usize = crate::bounds::READ_WINDOW_LINES as usize;
pub const COMPRESS_MAX_BYTES: usize = crate::bounds::READ_WINDOW_BYTES as usize;

/// Marker inserted where content was dropped. Same prefix as pibash's
/// `OMISSION_TAG`, so either tool's output is recognizable.
pub const OMISSION_TAG: &str = "[... omitted ";

/// Byte length of `s` (Rust `str` is already valid UTF-8).
fn js_byte_length(s: &str) -> usize {
    s.len()
}

/// Split into lines, dropping the trailing phantom segment for content that
/// ends in a newline - the same counting rule the read pipeline uses.
fn split_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// Longest prefix of `s` that fits `max_bytes`, cut on a character boundary
/// so the result is always valid UTF-8.
fn truncate_string_to_bytes_from_start(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// `PI_READ_COMPRESS` — compaction switch, **on by default**.
///
/// Unset keeps the default: oversized reads are head-tail compacted, so the
/// model pays for a bounded window instead of the full 2000-line / 50 KB cap.
/// `0` / `false` / `off` restores byte-for-byte parity with the built-in
/// `read`, which the parity suite and `piedit`'s exact matching rely on; the
/// tests set it explicitly rather than depending on the ambient default.
#[must_use]
pub fn compression_enabled() -> bool {
    parse_compression_switch(std::env::var("PI_READ_COMPRESS").ok().as_deref())
}

/// Pure switch logic, so the tests never mutate process-global env state
/// (Rust tests run in parallel and a `set_var` in one races every other).
#[must_use]
fn parse_compression_switch(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None => true,
        Some(v) => {
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
    }
}

#[must_use]
pub fn omission_marker(omitted_chars: usize, omitted_lines: usize) -> String {
    if omitted_lines > 0 {
        format!("{OMISSION_TAG}{omitted_chars} chars / {omitted_lines} lines ...]")
    } else {
        format!("{OMISSION_TAG}{omitted_chars} chars ...]")
    }
}

/// True when the text carries a real compaction cut: the marker is a whole line
/// of its own (that is the only shape `compact` ever emits).
///
/// A bare substring test is wrong — any document that *quotes* the marker (our
/// own architecture doc does) would be exempted from compaction and ship
/// uncompressed. The marker is bracketed and always stands alone.
#[must_use]
pub fn has_omission_marker(text: &str) -> bool {
    text.lines().any(|line| {
        let t = line.trim();
        t.starts_with(OMISSION_TAG) && t.ends_with(']')
    })
}

/// A compaction result: the visible text plus what was dropped.
#[derive(Debug)]
pub struct Compacted {
    pub content: String,
    /// `"none"` | `"head-tail"`.
    pub strategy: &'static str,
    pub original_chars: usize,
    pub visible_chars: usize,
    pub omitted_chars: usize,
    /// True when a single over-budget line was cut rather than whole lines.
    pub partial: bool,
    /// Whole-line cuts: each entry names the body lines (1-based,
    /// window-relative — the caller maps them onto absolute file lines)
    /// replaced by an omission marker, with the same chars/lines counts the
    /// marker states. The permission gate's marker-regex fallback MUST agree
    /// with this list (both paths are cross-checked by tests). Derive the
    /// base from `max(kept, rendered)` — the last line any bytes of which
    /// rendered: `kept` alone misses a byte-partial head line, `rendered`
    /// alone misses a trailing kept-empty line that `join` drops
    /// (`reconstructs_the_window_exactly` sweeps every shape class).
    pub omissions: Vec<Omission>,
}

/// One whole-line compaction cut: body lines `start_line..=end_line`
/// (1-based, window-relative) replaced by `[... omitted chars / lines ...]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Omission {
    pub start_line: usize,
    pub end_line: usize,
    pub chars: usize,
    pub lines: usize,
}

/// Head-tail compaction with a head-heavy split (reads are paged top-down, so
/// the head is what the reader asked for and the tail is what confirms it).
///
/// Returns the input unchanged when it already fits the budget, or when it
/// already carries an omission marker.
#[must_use]
pub fn compact(text: &str, max_lines: usize, max_bytes: usize) -> Compacted {
    let original_chars = text.chars().count();
    let verbatim = |t: &str| Compacted {
        content: t.to_string(),
        strategy: "none",
        original_chars,
        visible_chars: original_chars,
        omitted_chars: 0,
        partial: false,
        omissions: Vec::new(),
    };

    if fits(text, max_lines, max_bytes) || has_omission_marker(text) {
        return verbatim(text);
    }

    // The trailing read-continuation notice is metadata, not body: exclude it
    // from line counting and slicing so it can be re-attached exactly once at
    // the end (otherwise the tail slice becomes the notice itself, and it
    // lands twice in the output).
    let (body, notice) = match content_tail_notice(text) {
        Some((body, notice)) => (body.to_string(), Some(notice.to_string())),
        None => (text.to_string(), None),
    };
    // No-gap accounting (2026-10-28): the raw read path's line numbering
    // counts a body-final "\n" as a real (empty) line — compaction must
    // account it too (rendered by the tail, or inside the gap), or one
    // line is neither rendered nor gapped. split_lines pops it as a
    // terminator phantom; keep it here so head+gap+tail tiles the window
    // exactly. `fits` keeps pop semantics on purpose: a verbatim window is
    // fully rendered, so no gap is possible there.
    let lines: Vec<&str> = if body.is_empty() {
        Vec::new()
    } else {
        body.split('\n').collect()
    };
    let total_lines = lines.len();
    // `omitted_chars` is computed as `original_chars - (head + tail)`, and
    // head/tail are sliced from the body — so `original_chars` must be the
    // body's char count too. Measuring it over the full input (notice
    // included) silently counted the re-attached notice as "kept" content and
    // under-reported what was dropped.
    let original_chars = body.chars().count();

    // 2/3 head : 1/3 tail. Three lines are reserved for the marker and its two
    // blank separators so the TOTAL line count stays inside `max_lines`.
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * 2 / 3;
    let tail_lines_budget = content_lines - head_lines_budget;
    // The trailing read-continuation notice is re-attached verbatim at the
    // end, together with the "\n\n" that separates it from the body, so its
    // bytes must come out of the budget up front — otherwise the assembled
    // output overshoots `max_bytes` by roughly the notice length.
    let notice_reserve = notice
        .as_deref()
        .map_or(0, |n| js_byte_length(n) + 2);
    let head_bytes_budget = (max_bytes * 2 / 3).saturating_sub(notice_reserve);
    let tail_bytes_budget = max_bytes.saturating_sub(max_bytes * 2 / 3);

    let head = take_head(&lines, head_lines_budget, head_bytes_budget);
    // The marker's own size depends on the omitted count, which depends on how
    // much the tail keeps — so reserve for the marker BEFORE slicing the tail,
    // or a long omission count can push the total back over budget.
    let marker_reserve = omission_marker(original_chars, total_lines).len() + 4;
    let tail_bytes_budget = tail_bytes_budget.saturating_sub(marker_reserve);
    let mut tail = take_tail(&lines, tail_lines_budget, tail_bytes_budget);

    // A single line longer than the whole budget is served by the head alone:
    // a head+tail slice of one over-budget line is not useful (there is no
    // "tail of line 1" for a reader) and can exceed the byte budget.
    if tail.kept == 0 && tail.text.is_empty() && head.partial {
        tail = Slice { text: String::new(), kept: 0, partial: false };
    }
    // Whole-line tail only when it does not overlap the head.
    if head.kept > 0 && tail.kept > 0 && head.kept + tail.kept > total_lines {
        let overlap = head.kept + tail.kept - total_lines;
        if overlap >= tail.kept {
            tail = Slice { text: String::new(), kept: 0, partial: false };
        }
    }

    let kept_lines = head.kept + tail.kept;
    if kept_lines >= total_lines && !head.partial && !tail.partial {
        return verbatim(text); // nothing dropped after alignment
    }

    let omitted_lines = total_lines.saturating_sub(kept_lines);
    let omitted_chars = original_chars
        .saturating_sub(head.text.chars().count() + tail.text.chars().count());
    let marker = omission_marker(omitted_chars, omitted_lines);
    // Structured gap: one base for both boundaries — the last line any
    // bytes of which rendered. `kept` alone undercounts a byte-partial head
    // line (its prefix renders with kept 0); `str::lines()` alone
    // undercounts a trailing kept-empty line (`join` drops it, 2026-10-27
    // session drift: the gap opened one line early and closed one early,
    // marking a truly elided line as covered). max(kept, rendered) is that
    // last-rendered line in both shapes.
    let head_base = head.kept.max(head.text.lines().count());
    let omissions = if omitted_lines > 0 {
        vec![Omission {
            start_line: head_base + 1,
            end_line: head_base + omitted_lines,
            chars: omitted_chars,
            lines: omitted_lines,
        }]
    } else {
        Vec::new()
    };
    // The trailing read-continuation notice ("[Showing lines 1-2000 of 6001...]")
    // is the only place the reader learns the file continues. Compaction works on
    // the already-truncated body, so a bare head|marker|tail would end the output
    // with a mid-slice line and hide that fact. Keep the notice last, always.
    let content = match (tail.text.is_empty(), notice) {
        (true, Some(notice)) => format!("{}\n\n{marker}\n\n{notice}", head.text),
        (true, None) => format!("{}\n\n{marker}", head.text),
        (false, Some(notice)) => {
            format!("{}\n\n{marker}\n\n{}\n\n{notice}", head.text, tail.text)
        }
        (false, None) => format!("{}\n\n{marker}\n\n{}", head.text, tail.text),
    };
    Compacted {
        visible_chars: content.chars().count(),
        content,
        strategy: "head-tail",
        original_chars,
        omitted_chars,
        omissions,
        partial: head.partial || tail.partial,
    }
}

/// Split a trailing read-continuation notice off the body.
///
/// The renderer ends a truncated read with a blank line and a
/// `[Showing lines A-B of C.` notice. Compaction must not bury it mid-output.
fn content_tail_notice(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim_end_matches('\n');
    let idx = trimmed.rfind("\n\n[Showing lines ")?;
    let rest = &trimmed[..idx];
    if rest.is_empty() {
        return None;
    }
    Some((rest, &trimmed[idx + 2..]))
}

fn fits(text: &str, max_lines: usize, max_bytes: usize) -> bool {
    split_lines(text).len() <= max_lines && js_byte_length(text) <= max_bytes
}

struct Slice {
    text: String,
    kept: usize,
    partial: bool,
}

/// First `max_lines` lines / `max_bytes` bytes, on a UTF-8 boundary.
fn take_head(lines: &[&str], max_lines: usize, max_bytes: usize) -> Slice {
    let mut kept = 0usize;
    let mut bytes = 0usize;
    let mut out: Vec<&str> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        if kept >= max_lines {
            break;
        }
        let line_bytes = js_byte_length(line) + usize::from(idx != 0);
        if bytes + line_bytes > max_bytes {
            if kept == 0 {
                return Slice {
                    text: truncate_string_to_bytes_from_start(line, max_bytes),
                    kept: 0,
                    partial: true,
                };
            }
            break;
        }
        out.push(line);
        bytes += line_bytes;
        kept += 1;
    }
    Slice {
        text: out.join("\n"),
        kept,
        partial: false,
    }
}

/// Last `max_lines` lines / `max_bytes` bytes, scanned from the true end and
/// dropped entirely if it would overlap the head.
fn take_tail(lines: &[&str], max_lines: usize, max_bytes: usize) -> Slice {
    let total = lines.len();
    let mut kept = 0usize;
    let mut bytes = 0usize;
    let mut out: Vec<&str> = Vec::new();
    for idx in (0..total).rev() {
        if kept >= max_lines {
            break;
        }
        let line_bytes = js_byte_length(lines[idx]) + usize::from(kept != 0);
        if bytes + line_bytes > max_bytes {
            if kept == 0 {
                return Slice {
                    text: truncate_string_to_bytes_from_start(lines[idx], max_bytes),
                    kept: 0,
                    partial: true,
                };
            }
            break;
        }
        out.push(lines[idx]);
        bytes += line_bytes;
        kept += 1;
    }
    out.reverse();
    Slice {
        text: out.join("\n"),
        kept,
        partial: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn compression_is_on_by_default() {
        assert!(
            parse_compression_switch(None),
            "compaction must be on when the variable is unset"
        );
    }

    #[test]
    fn compression_can_be_disabled_for_parity() {
        for value in ["0", "false", "off", "FALSE", "Off", " 0 "] {
            assert!(
                !parse_compression_switch(Some(value)),
                "{value} should disable compaction"
            );
        }
        for value in ["1", "true", "on", "yes"] {
            assert!(
                parse_compression_switch(Some(value)),
                "{value} should enable compaction"
            );
        }
    }

    #[test]
    fn small_input_is_verbatim() {
        let text = "a\nb\nc";
        let out = compact(text, COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "none");
        assert_eq!(out.content, text);
        assert_eq!(out.omitted_chars, 0);
    }

    #[test]
    fn small_gap_is_printed_not_marked() {
        // Measured (.pi/read-ledger.jsonl): 92 of 151 gapped reads omitted
        // <= 60 lines, and 57 later reads aimed inside a prior gap. A marker
        // over such a gap trades ~60 printed lines for a whole re-read turn.
        let text = (1..=90)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "none", "90 lines fit one printed window");
        assert_eq!(out.content, text);
        assert_eq!(out.omissions.len(), 0);
    }

    #[test]
    fn past_the_budget_still_gaps() {
        // The budget is the boundary, not a suggestion: beyond it the marker
        // reappears (and H1b would head-truncate anyway).
        let text = (1..=300)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "head-tail");
        assert!(!out.omissions.is_empty());
    }

    #[test]
    fn head_tail_reports_the_omitted_span() {
        // C3: the cut must publish the gap as structured data — one
        // contiguous window-relative run whose chars/lines equal the marker
        // the model sees, so the gate's structured path and its marker-regex
        // fallback agree by construction.
        let body = numbered(120);
        let out = compact(&body, 40, 1 << 20);
        assert_eq!(out.strategy, "head-tail");
        assert_eq!(out.omissions.len(), 1);
        let o = &out.omissions[0];
        assert!(o.lines > 0);
        assert_eq!(o.end_line, o.start_line + o.lines - 1);
        assert_eq!(o.chars, out.omitted_chars);
        let marker = omission_marker(o.chars, o.lines);
        let rendered: Vec<&str> = out.content.lines().collect();
        assert!(rendered.contains(&marker.as_str()));
        // the line before the gap is the head's last rendered line; the line
        // after it is the tail's first — nothing inside the gap is rendered
        let before = format!("line {}", o.start_line - 1);
        let first_gap = format!("line {}", o.start_line);
        let last_gap = format!("line {}", o.end_line);
        let after = format!("line {}", o.end_line + 1);
        assert!(rendered.contains(&before.as_str()));
        assert!(!rendered.contains(&first_gap.as_str()));
        assert!(!rendered.contains(&last_gap.as_str()));
        assert!(rendered.contains(&after.as_str()));
    }

    #[test]
    fn omission_span_uses_kept_base_when_head_ends_on_empty_line() {
        // 2026-10-27 session drift: the head's last kept line was empty, so
        // `out.join("\n")` ends on a separator and `str::lines()` drops the
        // empty line — rendered-base attribution opened the gap one line
        // early (and closed it one early, marking a truly elided line as
        // covered). Attribution must share one base with `omitted_lines`:
        // the `kept` counters.
        let lines: Vec<String> = (1..=20)
            .map(|i| {
                if i == 9 {
                    String::new()
                } else {
                    format!("line {i}")
                }
            })
            .collect();
        let body = lines.join("\n");
        let out = compact(&body, 17, 1 << 20);
        // content budget 14: head keeps lines 1-9 (line 9 empty), tail keeps
        // the last 5 (16-20); the gap is exactly lines 10-15.
        let o = out.omissions.first().expect("one omission");
        assert_eq!(o.start_line, 10);
        assert_eq!(o.end_line, 15);
        assert_eq!(o.lines, 6);
    }

    #[test]
    fn verbatim_reports_no_omission_and_partial_cut_mirrors_the_regex_walk() {
        // Fits the budget: nothing cut, nothing reported.
        let small = compact(&numbered(10), 40, 1 << 20);
        assert_eq!(small.strategy, "none");
        assert!(small.omissions.is_empty());
        // A single over-budget line: head and tail render its prefix, but the
        // marker counts the line itself as omitted — the structured path must
        // state the same gap the marker-regex walk would compute (first
        // unrendered line, then the marker's line count).
        let long = compact(&"x".repeat(5000), 40, 2048);
        assert!(long.partial);
        assert_eq!(long.omissions.len(), 1);
        assert_eq!(long.omissions[0].lines, 1);
        assert_eq!(long.omissions[0].start_line, 2);
    }

    #[test]
    fn byte_budget_holds_with_trailing_read_notice() {
        // Regression: a truncated read ends with a "[Showing lines ...]"
        // notice. `compact` splits that notice off and re-attaches it after
        // the head/marker/tail slices, but never reserved its bytes — so the
        // result overshot COMPRESS_MAX_BYTES by roughly the notice length.
        let body = (1..=867)
            .map(|i| format!("line {i:04} {}", "x".repeat(48)))
            .collect::<Vec<_>>()
            .join("\n");
        let notice = "[Showing lines 1-867 of 6001 (50.0KB limit). Use offset=868 to continue.]";
        let text = format!("{body}\n\n{notice}");
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "head-tail");
        assert!(out.content.ends_with(notice), "notice must stay last: {}", out.content);
        assert!(
            js_byte_length(&out.content) <= COMPRESS_MAX_BYTES,
            "byte budget exceeded: {} > {COMPRESS_MAX_BYTES}",
            js_byte_length(&out.content)
        );
    }

    #[test]
    fn accounting_describes_the_body_not_the_notice() {
        // `original_chars` / `omitted_chars` are measured over the body, with
        // the trailing read notice split off; `visible_chars` counts the whole
        // assembled output, notice included. So `original_chars - visible_chars`
        // is NOT `omitted_chars` — it is `omitted_chars` plus the marker and the
        // separator/notice bytes that compaction adds back. Pin the invariant
        // that actually holds, so nobody "fixes" the apparent mismatch.
        let body = (1..=867)
            .map(|i| format!("line {i:04} {}", "x".repeat(48)))
            .collect::<Vec<_>>()
            .join("\n");
        let notice = "[Showing lines 1-867 of 6001 (50.0KB limit). Use offset=868 to continue.]";
        let text = format!("{body}\n\n{notice}");
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);

        assert_eq!(
            out.original_chars,
            js_byte_length(&body),
            "original_chars must exclude the trailing notice"
        );
        assert_eq!(out.visible_chars, js_byte_length(&out.content));
        assert!(
            out.omitted_chars > out.original_chars - out.visible_chars,
            "added marker/notice bytes make omitted_chars exceed the naive delta"
        );
    }

    #[test]
    fn large_input_is_compacted_within_budget() {
        let text = numbered(3000);
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "head-tail");
        assert!(out.content.contains(OMISSION_TAG), "marker missing: {}", &out.content);
        assert!(
            out.content.split('\n').count() <= COMPRESS_MAX_LINES,
            "line budget exceeded: {}",
            out.content.split('\n').count()
        );
        assert!(
            js_byte_length(&out.content) <= COMPRESS_MAX_BYTES,
            "byte budget exceeded: {}",
            js_byte_length(&out.content)
        );
        // Head and tail both survive.
        assert!(out.content.starts_with("line 1"));
        assert!(out.content.trim_end().ends_with("line 3000"));
        assert!(out.omitted_chars > 0);
    }

    #[test]
    fn compaction_is_deterministic() {
        let text = numbered(500);
        let a = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        let b = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(a.content, b.content);
        assert_eq!(a.omitted_chars, b.omitted_chars);
    }

    #[test]
    fn already_compacted_input_is_not_recompacted() {
        let text = numbered(3000);
        let once = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        let twice = compact(once.content.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(twice.strategy, "none", "re-compaction must be a no-op");
        assert_eq!(twice.content, once.content);
    }

    #[test]
    fn a_document_that_merely_quotes_the_marker_is_still_compacted() {
        // docs/rust-tools-architecture.md documents the marker string, so a
        // bare `contains(OMISSION_TAG)` test exempted it from compaction and it
        // shipped ~29 KB into context. Only a marker on its own line is a cut.
        let mut lines = numbered(3000);
        lines.push_str("\n- marker docs: `[... omitted N chars / M lines ...]`");
        let out = compact(lines.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "head-tail", "quoted marker must not exempt");
        assert!(out.omitted_chars > 0);
    }

    #[test]
    fn a_marker_inside_a_sentence_is_not_a_cut() {
        let line = "prefix [... omitted 10 chars / 2 lines ...] suffix";
        assert!(!has_omission_marker(line));
        assert!(has_omission_marker("[... omitted 10 chars / 2 lines ...]"));
        assert!(has_omission_marker(
            "line a\n\n[... omitted 10 chars / 2 lines ...]\n\nline b"
        ));
    }

    #[test]
    fn utf8_boundaries_survive_a_single_huge_line() {
        let text = "é".repeat(5000);
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        // Must still be valid UTF-8 (String guarantees it) and bounded.
        assert!(js_byte_length(&out.content) <= COMPRESS_MAX_BYTES);
        assert!(std::str::from_utf8(out.content.as_bytes()).is_ok());
    }

    #[test]
    fn empty_input_is_verbatim() {
        let out = compact("", COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.content, "");
        assert_eq!(out.strategy, "none");
    }

    #[test]
    fn exactly_at_the_budget_is_verbatim() {
        let text = numbered(COMPRESS_MAX_LINES);
        let out = compact(text.as_str(), COMPRESS_MAX_LINES, COMPRESS_MAX_BYTES);
        assert_eq!(out.strategy, "none");
        assert_eq!(out.content, text);
    }

    // 2026-10-28 exhaustive sweep: every compaction shape must reassemble
    // the window with no drift. Each rendered run is a true prefix/suffix of
    // the original lines; every unrendered line is either inside the
    // structured gap or an empty line invisible at a run boundary; the
    // marker matches the span; the budgets hold. This is the lock-in for
    // the whole attribution-drift class (the session bug: gap boundaries off
    // by one when the head cut landed on an empty line).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn shape_line(rng: &mut Rng, class: u64, i: usize) -> String {
        match class {
            0 => format!("line {i}"),
            1 => {
                if rng.below(3) == 0 {
                    String::new()
                } else {
                    format!("row {i}")
                }
            }
            2 => format!("{} {i}", "x".repeat(60 + (rng.below(8) as usize) * 90)),
            3 => format!("café — ligne {i} — €{} →", rng.below(100)),
            4 => format!("repeat {}", i / 7),
            _ => match rng.below(5) {
                0 => String::new(),
                1 => format!("long {i} {}", "y".repeat(300)),
                _ => format!("mix {i} é €"),
            },
        }
    }

    #[test]
    fn trailing_empty_window_line_is_fully_accounted() {
        // No-gap contract (2026-10-28): a window whose last line is empty
        // has that line counted by the raw read path's numbering, so
        // compaction must account it too — either rendered (tail keeps it,
        // content ends with the blank) or inside the gap. The old behavior
        // popped it as a terminator phantom: one line neither rendered nor
        // gapped (found by the cross-layer differential audit).
        let lines: Vec<String> = (1..=120)
            .map(|i| if i % 4 == 0 { String::new() } else { format!("row {i}") })
            .collect();
        let body = lines.join("\n"); // ends with '\n' (line 120 is empty)
        let out = compact(&body, 40, 2000);
        assert_eq!(out.strategy, "head-tail");
        let o = &out.omissions[0];
        // head 24 + gap 83 + tail 13 = 120: every line accounted.
        assert_eq!((o.start_line, o.end_line, o.lines), (25, 107, 83));
        // tail keeps 108..=120 — the trailing blank renders as the final
        // (empty) line, so the delivered content ends with the newline.
        assert!(out.content.ends_with('\n'));
        assert_eq!(out.content.lines().next_back(), Some("row 119"));
    }

    fn all_lines(s: &str) -> Vec<&str> {
        if s.is_empty() {
            Vec::new()
        } else {
            s.split('\n').collect()
        }
    }

    #[test]
    fn reconstructs_the_window_exactly() {
        let budgets: [(usize, usize); 5] = [
            (10, 1 << 20),
            (17, 400),
            (25, 800),
            (40, 300),
            (COMPRESS_MAX_LINES, 2_000),
        ];
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut cases = 0usize;
        for &class in &[0u64, 1, 2, 3, 4, 5] {
            for n in [1usize, 2, 3, 7, 9, 20, 21, 41, 120, 300] {
                let body: Vec<String> =
                    (0..n).map(|i| shape_line(&mut rng, class, i)).collect();
                let body = body.join("\n");
                for &(max_lines, max_bytes) in &budgets {
                    cases += 1;
                    let out = compact(&body, max_lines, max_bytes);
                    let tag = format!("class {class} n {n} budget {max_lines}/{max_bytes}");
                    assert!(
                        js_byte_length(&out.content) <= max_bytes,
                        "byte budget blown ({tag})"
                    );
                    if out.omissions.is_empty() {
                        assert!(!has_omission_marker(&out.content), "marker without span ({tag})");
                        continue;
                    }
                    assert_eq!(out.omissions.len(), 1, "one cut ({tag})");
                    let o = &out.omissions[0];
                    let window: Vec<&str> = all_lines(&body);
                    assert_eq!(
                        o.end_line - o.start_line + 1,
                        o.lines,
                        "span width ({tag})"
                    );
                    if out.partial {
                        // Pinned convention (verbatim walk-parity test): a
                        // single over-budget line renders prefixes and the
                        // gap is the virtual continuation line past the
                        // window — self-consistent, counts only.
                        continue;
                    }
                    assert!(
                        o.start_line >= 1 && o.end_line <= window.len(),
                        "span inside window ({tag})"
                    );
                    let marker = omission_marker(o.chars, o.lines);
                    let rendered: Vec<&str> = all_lines(&out.content);
                    assert!(rendered.contains(&marker.as_str()), "marker rendered ({tag})");
                    let mi = rendered
                        .iter()
                        .position(|l| *l == marker)
                        .expect("marker index");
                    // content = head.text + "\n\n" + marker + "\n\n" + tail.text
                    let mut head_seg: Vec<&str> = rendered[..mi].to_vec();
                    if head_seg.last() == Some(&"") {
                        head_seg.pop(); // the one structural separator
                    }
                    let mut tail_seg: Vec<&str> = rendered[mi + 1..].to_vec();
                    if tail_seg.first() == Some(&"") {
                        tail_seg.remove(0);
                    }
                    assert_eq!(
                        head_seg.join("\n"),
                        window[..head_seg.len()].join("\n"),
                        "head run is a true prefix ({tag})"
                    );
                    let t = tail_seg.len();
                    // No-pop accounting: the tail keeps trailing empty lines
                    // verbatim, so it is an exact suffix — no shrinking.
                    assert_eq!(
                        tail_seg.join("\n"),
                        window[window.len() - t..].join("\n"),
                        "tail run is a true suffix ({tag}): got {:?} want {:?}",
                        tail_seg,
                        &window[window.len() - t..]
                    );
                    // every unrendered line is inside the gap, or an empty
                    // line invisible at a run boundary
                    for (idx, l) in window.iter().enumerate() {
                        let n1 = idx + 1; // 1-based
                        let rendered_line = n1 <= head_seg.len()
                            || n1 > window.len() - t;
                        let in_gap =
                            n1 >= o.start_line && n1 <= o.end_line;
                        if !rendered_line && !in_gap {
                            assert!(
                                l.is_empty(),
                                "line {n1} neither rendered nor gapped ({tag}): \
                                 win {:?} head {:?} tail {:?} omit {:?}",
                                window,
                                head_seg,
                                tail_seg,
                                o
                            );
                        }
                    }
                }
            }
        }
        assert!(cases >= 250, "sweep covered {cases} compactions");
    }
}
