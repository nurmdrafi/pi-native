//! Streaming read pipeline — byte-for-byte parity with the pi built-in `read`
//! tool's text path (`dist/core/tools/read.js` + `truncate.js`).
//!
//! Semantics pinned by the harness oracle suite (`tests/piread-parity.test.mjs`)
//! and, for the note literals below, by a one-time dump of the built-in tool.
//!
//! Memory contract: buffers at most `MAX_BYTES` of decoded output plus the
//! selection's first line (needed for the firstLineExceedsLimit path); the
//! rest of the file is scanned (newline counting, binary sniff) without
//! buffering, so a 1 GiB read costs O(cap) memory like the built-in's caps,
//! without materializing the whole file.

use std::fs::File;
use std::io::{BufRead, BufReader};

use crate::envelope::{ErrorKind, LocateWire, OmissionWire, Truncation, TruncationKind};
use crate::ToolError;

/// Built-in caps (`truncate.ts`): DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES.
pub const MAX_LINES: u64 = 2000;
pub const MAX_BYTES: u64 = 50 * 1024;
/// Binary detection window: NUL in the first 8 KiB marks the file binary.
const BINARY_SNIFF: i64 = 8 * 1024;

#[derive(Debug)]
pub struct PipelineOutput {
    /// Final rendered text (content + any continuation note), byte-identical
    /// to the built-in's `content[0].text`.
    pub content: String,
    /// `details.truncation` — present only in the built-in's truncation
    /// branches (firstLineExceedsLimit / truncated).
    pub truncation: Option<Truncation>,
    /// NUL detected in the first 8 KiB (envelope extra; content unchanged).
    pub binary: bool,
    /// Raw file size in bytes.
    pub total_bytes: u64,
    /// Head-tail compaction diagnostics, present only when the body was
    /// compacted. Carried in the envelope's `compaction` field instead of
    /// being printed: a stderr line surfaces in hosts that relay tool stderr,
    /// where `piread: compacted (...)` reads as noise, not information.
    pub compaction: Option<CompactionWire<'static>>,
    /// Fused locate+read report, present only for `--hits` reads; `None`
    /// leaves the envelope byte-identical to the default mode.
    pub locate: Option<LocateWire>,
}

pub use crate::envelope::CompactionWire;

/// `read_text` plus the model-visible head-tail compaction.
///
/// This is the entry point the CLI and `--serve` use. Compaction is **on by
/// default** (`PI_READ_COMPRESS=0|false|off` restores byte parity) and only
/// reshapes the model-visible text: `truncation` metadata is preserved, so the
/// permission gate still learns the true line count and the reader still sees
/// the `[Showing lines A-B of C ...]` continuation notice.
///
/// A body that already fits the budget is returned untouched, so small reads
/// are byte-identical to the built-in in either mode.
pub fn read_text_compacted(
    resolved: &str,
    raw_path: &str,
    offset: Option<u64>,
    limit: Option<u64>,
    line_cap: Option<u64>,
) -> Result<PipelineOutput, ToolError> {
    let mut out = read_text(resolved, raw_path, offset, limit, line_cap)?;
    if !crate::compress::compression_enabled() {
        return Ok(out);
    }
    let compacted = crate::compress::compact(
        &out.content,
        crate::compress::COMPRESS_MAX_LINES,
        crate::compress::COMPRESS_MAX_BYTES,
    );
    if compacted.omitted_chars > 0 {
        // Structured, not printed: the notice travels in the JSON envelope so
        // it stays available for debugging without ever reaching a stream a
        // host might relay into the conversation. `omissions` carries
        // absolute 1-based file lines (C3): compact() reports window-relative
        // lines, and only this call site knows the window's start.
        let window_start = usize::try_from(offset.unwrap_or(1)).unwrap_or(1) - 1;
        out.compaction = Some(CompactionWire {
            strategy: compacted.strategy,
            original_chars: compacted.original_chars,
            visible_chars: compacted.visible_chars,
            omitted_chars: compacted.omitted_chars,
            omissions: compacted
                .omissions
                .iter()
                .map(|o| OmissionWire {
                    start_line: window_start + o.start_line,
                    end_line: window_start + o.end_line,
                    chars: o.chars,
                    lines: o.lines,
                })
                .collect(),
            partial: compacted.partial,
        });
    }
    out.content = compacted.content;
    Ok(out)
}

/// Full pipeline: open `resolved`, apply 1-based `offset` (≥1) / `limit` (≥1),
/// truncate, render notes. `raw_path` is the caller-supplied path used inside
/// the sed fallback note, exactly like the built-in.
///
/// Compaction is NOT applied here — see `read_text_compacted`, which the CLI
/// and the daemon call. Keeping this function pure is what lets the parity
/// suite pin byte-identical output against the built-in read.
pub fn read_text(
    resolved: &str,
    raw_path: &str,
    offset: Option<u64>,
    limit: Option<u64>,
    line_cap: Option<u64>,
) -> Result<PipelineOutput, ToolError> {
    let file = File::open(resolved).map_err(|e| open_error(e, resolved))?;
    let mut segs = Segmenter::new(BufReader::with_capacity(64 * 1024, file));

    // 0-based segment index of the first selected line (JS: max(0, offset-1);
    // the CLI guarantees offset ≥ 1, saturate for u64::MAX inputs).
    let start_line = offset.map_or(0, |o| o.saturating_sub(1));
    let sel_end = limit.map(|l| start_line.saturating_add(l));

    let mut truncator = HeadTruncator::new(MAX_LINES, MAX_BYTES);
    let mut seg_index: u64 = 0; // segments consumed file-wide (== JS allLines.length)
    let mut sel_segments: u64 = 0;
    let mut sel_decoded_bytes: u64 = 0; // byteLength of the joined selection (decoded!)
    let mut last_sel_empty = false; // selection's last segment is "" (string ends with \n)
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    while segs.next(&mut buf)? {
        seg_index = seg_index.saturating_add(1);
        if seg_index > start_line && sel_end.is_none_or(|e| seg_index <= e) {
            // Fast path: a saturated head buffer accepts no further lines, so
            // decoding and pushing are no-ops. The accounting below is what
            // must survive: `sep + line.len()` is `sep + buf.len()` because the
            // scanner already stripped the newline, and `lines_seen` is read
            // only inside `push`.
            if line_cap.is_none() && truncator.saturated() {
                let sep = u64::from(sel_segments > 0);
                sel_decoded_bytes = sel_decoded_bytes.saturating_add(sep + buf.len() as u64);
                sel_segments = sel_segments.saturating_add(1);
                last_sel_empty = buf.is_empty();
                continue;
            }
            let raw = String::from_utf8_lossy(&buf);
            // Optional per-line cap (PI_READ_LINE_CAP). Off by default: with
            // `line_cap == None` this is a borrow, so the common path is
            // byte-identical to the built-in. Only lines OVER the cap are
            // touched; whitespace and normal lines are never altered (edit's
            // exact matching depends on fidelity).
            let capped: std::borrow::Cow<str> = match line_cap {
                // A cut point existing IS the over-the-cap test: one pass to the
                // (n+1)th char, then one pass over the remainder for the dropped
                // count. The fits case borrows, so it never allocates.
                Some(c) => match raw.char_indices().nth(c as usize) {
                    Some((cut, _)) => std::borrow::Cow::Owned(format!(
                        "{}...[+{} chars]",
                        &raw[..cut],
                        raw[cut..].chars().count()
                    )),
                    None => raw,
                },
                None => raw,
            };
            let line = capped.as_ref();
            let sep = u64::from(sel_segments > 0); // \n between joined segments
            sel_decoded_bytes = sel_decoded_bytes.saturating_add(sep + line.len() as u64);
            sel_segments = sel_segments.saturating_add(1);
            last_sel_empty = buf.is_empty();
            truncator.push(line);
        }
        // Outside the selection: keep scanning (file line count + sniff) but
        // never buffer — the memory contract above.
    }

    let file_total_lines = seg_index;
    if start_line >= file_total_lines {
        // JS throws with the raw offset value; only Some(offset) reaches here
        // (start_line == 0 < 1 ≤ file_total_lines otherwise).
        return Err(ToolError {
            kind: ErrorKind::Offset,
            message: format!(
                "Offset {offset} is beyond end of file ({file_total_lines} lines total)",
                offset = offset.unwrap_or(0)
            ),
        });
    }

    // JS splitLinesForCounting: a trailing "" segment (string ends with \n)
    // is popped; a selection of exactly [""] counts as 0 lines.
    let sel_count_lines = if last_sel_empty { sel_segments - 1 } else { sel_segments };
    let user_limited = limit.map(|l| l.min(file_total_lines - start_line));

    let truncation = truncator.finalize(sel_count_lines, sel_decoded_bytes);
    let prefix = truncator.selection_prefix();
    let first_line_len = truncator.first_line_len();
    let content = render(
        truncation.as_ref(),
        prefix,
        raw_path,
        start_line,
        file_total_lines,
        user_limited,
        first_line_len,
    );
    // NOTE: no compaction here. `read_text` stays a pure, byte-exact pipeline
    // (the built-in read's contract) so the parity suite can assert against it
    // deterministically. Compaction is applied by the CLI and daemon entry
    // points via `read_text_compacted`, which keeps this function free of
    // process-global env state (Rust tests run in parallel and would race).
    Ok(PipelineOutput {
        content,
        truncation,
        binary: segs.binary,
        total_bytes: segs.raw_seen,
        compaction: None,
        locate: None,
    })
}

/// Continuation-note rendering, mirroring read.js's else-if chain exactly.
fn render(
    truncation: Option<&Truncation>,
    prefix: &str,
    raw_path: &str,
    start_line: u64,
    file_total_lines: u64,
    user_limited: Option<u64>,
    first_line_len: u64,
) -> String {
    let start_display = start_line + 1;
    if let Some(t) = truncation
        && t.first_line_exceeds_limit
    {
        return format!(
            "[Line {start_display} is {size}, exceeds {cap} limit. \
             Use bash: sed -n '{start_display}p' {raw_path} | head -c {MAX_BYTES}]",
            size = format_size(first_line_len),
            cap = format_size(MAX_BYTES),
        );
    }
    if let Some(t) = truncation
        && t.truncated
    {
        let end_display = start_display + t.output_lines - 1;
        let limit_note = match t.truncated_by {
            Some(TruncationKind::Lines) => String::new(),
            _ => format!(" ({} limit)", format_size(MAX_BYTES)),
        };
        return format!(
            "{prefix}\n\n[Showing lines {start_display}-{end_display} of \
             {file_total_lines}{limit_note}. Use offset={next} to continue.]",
            next = end_display + 1
        );
    }
    if let Some(u) = user_limited
        && start_line.saturating_add(u) < file_total_lines
    {
        let remaining = file_total_lines - (start_line + u);
        return format!(
            "{prefix}\n\n[{remaining} more lines in file. Use offset={next} to continue.]",
            next = start_line + u + 1
        );
    }
    prefix.to_string()
}

/// Streaming `truncateHead`: fed the selection's lines in order; stops
/// buffering once the byte/line cut is certain, mirroring the JS loop's
/// `lineBytes = byteLength(line) + (i > 0 ? 1 : 0)` accounting. The joined
/// prefix is built in place (`out`), so buffering costs one copy per line —
/// no per-line allocation, no join pass.
struct HeadTruncator {
    max_lines: u64,
    max_bytes: u64,
    /// Buffered selection prefix, `join("\n")`-identical; `out.len()` is
    /// the loop's `bytes` accumulator (separator included).
    out: String,
    buffered_lines: u64,
    lines_seen: u64, // selection lines pushed (counted past the cut)
    byte_break: bool,
    first_line_exceeds: bool,
    first_line_len: u64,
    buffering: bool,
}

impl HeadTruncator {
    fn new(max_lines: u64, max_bytes: u64) -> Self {
        Self {
            max_lines,
            max_bytes,
            // The prefix never exceeds `max_bytes`; presizing to it (capped)
            // makes the common capped case a single allocation with no
            // re-growth.
            out: String::with_capacity(max_bytes.min(64 * 1024) as usize),
            buffered_lines: 0,
            lines_seen: 0,
            byte_break: false,
            first_line_exceeds: false,
            first_line_len: 0,
            buffering: true,
        }
    }

    fn push(&mut self, line: &str) {
        if self.lines_seen == 0 {
            self.first_line_len = line.len() as u64;
            if self.first_line_len > self.max_bytes {
                // JS checks firstLineExceedsLimit before the loop.
                self.first_line_exceeds = true;
                self.buffering = false;
            }
        }
        self.lines_seen += 1;
        if !self.buffering {
            return;
        }
        let i = self.lines_seen - 1;
        if i >= self.max_lines {
            self.buffering = false; // loop exits on the line limit
            return;
        }
        let line_bytes = line.len() as u64 + u64::from(i > 0);
        if (self.out.len() as u64).saturating_add(line_bytes) > self.max_bytes {
            self.byte_break = true; // loop breaks on the byte limit
            self.buffering = false;
            return;
        }
        if i > 0 {
            self.out.push('\n');
        }
        self.out.push_str(line);
        self.buffered_lines += 1;
    }

    /// `None` when the selection fits both caps (JS returns truncated:false
    /// there and read.js leaves `details` undefined).
    fn finalize(&self, sel_total_lines: u64, sel_total_bytes: u64) -> Option<Truncation> {
        let truncated = self.first_line_exceeds
            || self.byte_break
            || sel_total_lines > self.max_lines
            || sel_total_bytes > self.max_bytes;
        if !truncated {
            return None;
        }
        let truncated_by = if self.first_line_exceeds || self.byte_break {
            TruncationKind::Bytes
        } else {
            TruncationKind::Lines
        };
        let content = if self.first_line_exceeds {
            String::new()
        } else {
            self.out.clone()
        };
        let output_bytes = content.len() as u64;
        Some(Truncation {
            output_lines: self.buffered_lines,
            content,
            truncated: true,
            truncated_by: Some(truncated_by),
            total_lines: sel_total_lines,
            total_bytes: sel_total_bytes,
            output_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: self.first_line_exceeds,
            max_lines: self.max_lines,
            max_bytes: self.max_bytes,
        })
    }

    /// The buffered selection prefix — the full selection when untruncated.
    fn selection_prefix(&self) -> &str {
        &self.out
    }

    fn first_line_len(&self) -> u64 {
        self.first_line_len
    }

    /// True once the head buffer accepts no further lines: line cap, byte cap,
    /// or a first line already over the byte cap. Later `push` calls only bump
    /// `lines_seen`, which nothing reads after the scan.
    fn saturated(&self) -> bool {
        !self.buffering
    }
}

/// Newline-segment iterator over a reader with JS `split("\n")` semantics:
/// `n` newlines yield `n + 1` segments; a file ending in `\n` (or an empty
/// file) contributes a trailing empty segment. Also owns raw-byte counting
/// and the 8 KiB NUL sniff.
pub(crate) struct Segmenter<R: BufRead> {
    inner: R,
    /// Previous chunk ended with `\n`; starts true so an empty file yields
    /// its single `[""]` segment.
    last_ended_newline: bool,
    finished: bool,
    pub(crate) raw_seen: u64,
    sniff_left: i64,
    pub(crate) binary: bool,
}

impl<R: BufRead> Segmenter<R> {
    pub(crate) fn new(inner: R) -> Self {
        Self {
            inner,
            last_ended_newline: true,
            finished: false,
            raw_seen: 0,
            sniff_left: BINARY_SNIFF,
            binary: false,
        }
    }

    /// Fills `buf` (reused) with the next segment's bytes, newline stripped.
    /// Returns Ok(false) after the last segment.
    pub(crate) fn next(&mut self, buf: &mut Vec<u8>) -> Result<bool, ToolError> {
        if self.finished {
            return Ok(false);
        }
        buf.clear();
        // Segment scan without a per-line read call: the fill buffer is
        // searched for the next newline with memchr, so a 2,500-line file costs
        // one scan per 64 KiB chunk instead of 2,500 `read_until` calls. The
        // bytes handed to the caller are identical to the per-line form.
        loop {
            let available = self.inner.fill_buf().map_err(read_error)?;
            if available.is_empty() {
                self.finished = true;
                if buf.is_empty() && self.last_ended_newline {
                    return Ok(true); // the trailing empty segment
                }
                return Ok(!buf.is_empty());
            }
            let (take, ended) = match memchr::memchr(b'\n', available) {
                Some(i) => (i + 1, true),
                None => (available.len(), false),
            };
            buf.extend_from_slice(&available[..take]);
            self.inner.consume(take);
            self.raw_seen = self.raw_seen.saturating_add(take as u64);
            self.sniff(&buf[buf.len() - take..]);
            if ended {
                buf.pop();
                self.last_ended_newline = true;
                return Ok(true);
            }
            self.last_ended_newline = false;
        }
    }

    /// NUL sniff over the leading 8 KiB of raw file bytes, chunk by chunk.
    fn sniff(&mut self, chunk: &[u8]) {
        if self.sniff_left <= 0 {
            return;
        }
        let window = &chunk[..(chunk.len() as i64).min(self.sniff_left) as usize];
        if window.contains(&0) {
            self.binary = true;
        }
        self.sniff_left -= window.len() as i64;
    }
}

/// Node's `fsPromises.access(path, R_OK)` error messages, byte for byte.
pub(crate) fn open_error(e: std::io::Error, resolved: &str) -> ToolError {
    match e.kind() {
        std::io::ErrorKind::NotFound => ToolError {
            kind: ErrorKind::Enoent,
            message: format!("ENOENT: no such file or directory, access '{resolved}'"),
        },
        std::io::ErrorKind::PermissionDenied => ToolError {
            kind: ErrorKind::Eacces,
            message: format!("EACCES: permission denied, access '{resolved}'"),
        },
        _ => generic_io_error(e),
    }
}

pub(crate) fn read_error(e: std::io::Error) -> ToolError {
    if e.kind() == std::io::ErrorKind::IsADirectory {
        return ToolError {
            kind: ErrorKind::Eisdir,
            message: "EISDIR: illegal operation on a directory, read".to_string(),
        };
    }
    generic_io_error(e)
}

fn generic_io_error(e: std::io::Error) -> ToolError {
    ToolError {
        kind: ErrorKind::Io,
        message: format!("{e}, read"),
    }
}

/// `formatSize` from truncate.ts. The one-decimal rounding matches JS
/// `Number.toFixed(1)` (round-half-up on the exact double value): tenths are
/// computed as `floor(x * 10 + 0.5)`.
pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{}KB", to_fixed_1(bytes as f64 / 1024.0))
    } else {
        format!("{}MB", to_fixed_1(bytes as f64 / (1024.0 * 1024.0)))
    }
}

fn to_fixed_1(x: f64) -> String {
    let tenths = (x * 10.0 + 0.5).floor();
    let whole = (tenths / 10.0) as u64;
    let frac = (tenths % 10.0) as u64;
    format!("{whole}.{frac}")
}

/// Resolve like the built-in's `resolveToCwd`: `~` expansion, then lexical
/// normalization against the process cwd. (The built-in's macOS screenshot
/// filename variants are handled by the extension's `resolveToolPath`, which
/// pre-resolves the path before dispatch.)
pub fn resolve_path(raw: &str) -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    resolve_path_against(raw, &cwd.to_string_lossy())
}

/// Resolve against an explicit base directory — daemon requests carry the
/// caller's cwd per request; the one-shot CLI resolves against the process
/// cwd. Same `~` expansion and lexical normalization in both cases.
pub fn resolve_path_against(raw: &str, base: &str) -> String {
    let expanded = if raw == "~" {
        std::env::var("HOME").unwrap_or_default()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        raw.to_string()
    };
    if expanded.starts_with('/') {
        normalize(&expanded)
    } else {
        normalize(&format!("{base}/{expanded}"))
    }
}

/// Lexical path cleanup: collapse `//`, `.`, and `..` segments (absolute only).
fn normalize(abs: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in abs.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn truncation_reference() -> Truncation {
        // The built-in's details.truncation for the 2500-line dump fixture.
        Truncation {
            content: "x".repeat(17_999),
            truncated: true,
            truncated_by: Some(TruncationKind::Lines),
            total_lines: 2500,
            total_bytes: 22_500,
            output_lines: 2000,
            output_bytes: 17_999,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines: 2000,
            max_bytes: 51_200,
        }
    }

    // ---- format_size: JS toFixed(1) parity, including the tie case ----

    #[test]
    fn format_size_matches_js_to_fixed() {
        assert_eq!(format_size(0), "0B");
        assert_eq!(format_size(1023), "1023B");
        assert_eq!(format_size(1024), "1.0KB");
        assert_eq!(format_size(1280), "1.3KB"); // exact .25 tie: toFixed rounds up
        assert_eq!(format_size(51_200), "50.0KB");
        assert_eq!(format_size(60_000), "58.6KB"); // 58.59375 -> 58.6
        assert_eq!(format_size(1_048_575), "1024.0KB"); // 1023.999… -> 1024.0
        assert_eq!(format_size(1_048_576), "1.0MB");
        assert_eq!(format_size(1_572_864), "1.5MB");
    }

    // ---- HeadTruncator cap arithmetic (small caps, exact boundaries) ----

    fn trunc(caps: (u64, u64), lines: &[&str], sel_total_lines: u64, sel_total_bytes: u64) -> Option<Truncation> {
        let mut t = HeadTruncator::new(caps.0, caps.1);
        for l in lines {
            t.push(l);
        }
        t.finalize(sel_total_lines, sel_total_bytes)
    }

    #[test]
    fn no_truncation_when_within_caps() {
        assert_eq!(trunc((3, 10), &["ab", "cd"], 2, 5), None);
    }

    #[test]
    fn line_cap_cuts_at_max_lines() {
        let t = trunc((3, 100), &["a", "b", "c", "d"], 4, 7).unwrap();
        assert_eq!(t.output_lines, 3);
        assert_eq!(t.truncated_by, Some(TruncationKind::Lines));
        assert_eq!(t.content, "a\nb\nc");
        assert_eq!(t.output_bytes, 5);
    }

    #[test]
    fn byte_cap_counts_separator_from_second_line() {
        // out_bytes: 2, then 2+ (2+1) = 5; third line 2+1=3 would reach 8 > 5.
        let t = trunc((10, 5), &["ab", "cd", "ef"], 3, 8).unwrap();
        assert_eq!(t.output_lines, 2);
        assert_eq!(t.truncated_by, Some(TruncationKind::Bytes));
        assert_eq!(t.content, "ab\ncd");
        assert_eq!(t.output_bytes, 5);
    }

    #[test]
    fn byte_cap_boundary_is_inclusive() {
        // Exactly max_bytes fits; a strictly larger line breaks.
        assert_eq!(trunc((10, 5), &["abcde"], 1, 5), None);
        let t = trunc((10, 5), &["abcde", "x"], 2, 6).unwrap();
        assert_eq!(t.truncated_by, Some(TruncationKind::Bytes));
        assert_eq!(t.output_lines, 1);
    }

    #[test]
    fn first_line_exceeding_byte_cap_short_circuits() {
        let t = trunc((10, 5), &["abcdef", "x"], 2, 8).unwrap();
        assert!(t.first_line_exceeds_limit);
        assert_eq!(t.truncated_by, Some(TruncationKind::Bytes));
        assert_eq!(t.content, "");
        assert_eq!(t.output_lines, 0);
        assert_eq!(t.output_bytes, 0);
    }

    #[test]
    fn empty_selection_counts_zero_lines() {
        assert_eq!(trunc((10, 10), &[""], 0, 0), None);
    }

    // ---- render: note literals pinned from a one-time built-in dump ----

    #[test]
    fn render_lines_truncation_note_matches_builtin() {
        let t = truncation_reference();
        let out = render(Some(&t), &t.content.clone(), "f.txt", 0, 2501, None, t.output_bytes);
        assert!(out.ends_with(
            "\n\n[Showing lines 1-2000 of 2501. Use offset=2001 to continue.]"
        ));
        assert!(out.starts_with(t.content.as_str()));
    }

    #[test]
    fn render_bytes_truncation_note_matches_builtin() {
        // b600 dump: 600 lines of 100 chars, byte cut at line 506.
        let t = Truncation {
            content: "x".repeat(51_105),
            truncated: true,
            truncated_by: Some(TruncationKind::Bytes),
            total_lines: 600,
            total_bytes: 60_599,
            output_lines: 506,
            output_bytes: 51_105,
            ..truncation_reference()
        };
        let out = render(Some(&t), &t.content.clone(), "b600.txt", 0, 600, None, 100);
        assert!(out.ends_with(
            "\n\n[Showing lines 1-506 of 600 (50.0KB limit). Use offset=507 to continue.]"
        ));
    }

    #[test]
    fn render_first_line_exceeds_note_matches_builtin() {
        // big1st dump: 60000-byte first line -> "58.6KB", raw path, head -c 51200.
        let t = Truncation {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncationKind::Bytes),
            total_lines: 2,
            total_bytes: 60_007,
            output_lines: 0,
            output_bytes: 0,
            first_line_exceeds_limit: true,
            ..truncation_reference()
        };
        let out = render(Some(&t), "", "/tmp/dump/big1st.txt", 0, 2, None, 60_000);
        assert_eq!(
            out,
            "[Line 1 is 58.6KB, exceeds 50.0KB limit. Use bash: sed -n '1p' \
             /tmp/dump/big1st.txt | head -c 51200]"
        );
    }

    #[test]
    fn render_user_limit_note_matches_builtin() {
        // limit.txt dump: "a\nb\nc\nd\n", limit 2 (phantom counts as a line).
        assert_eq!(
            render(None, "a\nb", "limit.txt", 0, 5, Some(2), 2),
            "a\nb\n\n[3 more lines in file. Use offset=3 to continue.]"
        );
        // mid.txt dump: 30 lines, offset 10, limit 5.
        assert_eq!(
            render(None, "L9\nL10\nL11\nL12\nL13", "mid.txt", 9, 30, Some(5), 3),
            "L9\nL10\nL11\nL12\nL13\n\n[16 more lines in file. Use offset=15 to continue.]"
        );
        // limitnl.txt dump: "a\nb\nc\n", limit 2.
        assert_eq!(
            render(None, "a\nb", "limitnl.txt", 0, 4, Some(2), 2),
            "a\nb\n\n[2 more lines in file. Use offset=3 to continue.]"
        );
    }

    #[test]
    fn render_plain_when_no_notes_apply() {
        assert_eq!(render(None, "abc", "f", 0, 1, None, 3), "abc");
        // limit that reaches EOF: no note (phantom2 dump: offset 3, limit 2).
        assert_eq!(render(None, "c\n", "f", 2, 4, Some(2), 2), "c\n");
    }

    // ---- path resolution ----

    #[test]
    fn normalize_collapses_segments() {
        assert_eq!(normalize("/a//b/./c/../"), "/a/b");
        assert_eq!(normalize("/../x"), "/x");
        assert_eq!(normalize("/"), "/");
    }

    // ---- full pipeline over real files (fixtures from the Step 2 dump) ----

    mod file {
        use super::super::{read_text, read_text_compacted, PipelineOutput, Segmenter};
        use crate::envelope::{ErrorKind, TruncationKind};
        use crate::ToolError;
        use std::fs;
        use std::path::{Path, PathBuf};

        fn tmp_file(name: &str, bytes: &[u8]) -> PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("piread-unit-{}-{name}", std::process::id()));
            fs::create_dir_all(&dir).expect("temp dir");
            let file = dir.join("f");
            fs::write(&file, bytes).expect("fixture write");
            file
        }

        fn read(path: &Path, offset: Option<u64>, limit: Option<u64>) -> Result<PipelineOutput, ToolError> {
            read_text(&path.to_string_lossy(), &path.to_string_lossy(), offset, limit, None)
        }

        #[test]
        fn compacted_window_reports_absolute_omission_lines() {
            // C3: compact() speaks window-relative lines; the envelope must
            // publish absolute file lines so the gate needs no window math.
            let body: String = (1..=220)
                .map(|i| format!("line {i}"))
                .collect::<Vec<_>>()
                .join("\n");
            let f = tmp_file("om-abs", body.as_bytes());
            let out = read_text_compacted(
                &f.to_string_lossy(),
                &f.to_string_lossy(),
                Some(60),
                None,
                None,
            )
            .unwrap();
            let c = out
                .compaction
                .as_ref()
                .expect("161 lines exceed the 100-line read budget");
            assert_eq!(c.omissions.len(), 1);
            let o = &c.omissions[0];
            assert!(
                o.start_line >= 60 && o.end_line <= 220,
                "gap {o:?} must be absolute within the 60..=220 window"
            );
            assert_eq!(o.end_line - o.start_line + 1, o.lines);
            assert!(out.content.starts_with("line 60"));
            let gap_first = format!("line {}", o.start_line);
            assert!(!out.content.lines().any(|l| l == gap_first));
        }

        #[test]
        fn t2500_lines_truncation_end_to_end() {
            let body: String = (0..2500).map(|i| format!("line{:04}\n", i)).collect();
            let f = tmp_file("t2500", body.as_bytes());
            let out = read(&f, None, None).unwrap();
            let prefix: String = (0..2000).map(|i| format!("line{:04}", i)).collect::<Vec<_>>().join("\n");
            assert_eq!(prefix.len(), 17_999);
            assert!(!out.binary, "no NULs");
            assert_eq!(out.total_bytes, 22_500);
            let t = out.truncation.as_ref().unwrap();
            assert_eq!(t.content, prefix);
            assert!(t.truncated);
            assert_eq!(t.truncated_by, Some(TruncationKind::Lines));
            assert_eq!(t.total_lines, 2500); // popped count of the selection
            assert_eq!(t.total_bytes, 22_500);
            assert_eq!(t.output_lines, 2000);
            assert_eq!(t.output_bytes, 17_999);
            assert_eq!(out.content, format!(
                "{prefix}\n\n[Showing lines 1-2000 of 2501. Use offset=2001 to continue.]"
            ));
        }

        #[test]
        fn b600_bytes_truncation_end_to_end() {
            let body: String = (0..600).map(|_| "x".repeat(100)).collect::<Vec<_>>().join("\n");
            let f = tmp_file("b600", body.as_bytes());
            let out = read(&f, None, None).unwrap();
            assert_eq!(out.total_bytes, 60_599);
            let t = out.truncation.as_ref().unwrap();
            assert_eq!(t.truncated_by, Some(TruncationKind::Bytes));
            assert_eq!(t.total_lines, 600);
            assert_eq!(t.output_lines, 506);
            assert_eq!(t.output_bytes, 51_105);
            assert_eq!(out.content, format!(
                "{}\n\n[Showing lines 1-506 of 600 (50.0KB limit). Use offset=507 to continue.]",
                t.content
            ));
        }

        #[test]
        fn big_first_line_sed_note() {
            let body = format!("{}\nsmall\n", "y".repeat(60_000));
            let f = tmp_file("big1st", body.as_bytes());
            let p = f.to_string_lossy().into_owned();
            let out = read_text(&p, &p, None, None, None).unwrap();
            assert_eq!(out.content, format!(
                "[Line 1 is 58.6KB, exceeds 50.0KB limit. Use bash: sed -n '1p' {p} | head -c 51200]"
            ));
            let t = out.truncation.unwrap();
            assert!(t.first_line_exceeds_limit);
            assert_eq!(t.total_bytes, 60_007);
            assert_eq!(t.output_lines, 0);
        }

        #[test]
        fn line_cap_truncates_only_long_lines() {
            // Off by default: identical to the built-in.
            let body = format!("short\n{}\nnorm\n", "a".repeat(20));
            let f = tmp_file("linecap", body.as_bytes());
            let p = f.to_string_lossy().into_owned();
            let uncapped = read_text(&p, &p, None, None, None).unwrap();
            assert_eq!(uncapped.content, body);

            // Cap at 10: only the long line is cut, with a [+N chars] marker.
            let capped = read_text(&p, &p, None, None, Some(10)).unwrap();
            assert_eq!(capped.content, "short\naaaaaaaaaa...[+10 chars]\nnorm\n");

            // Lines at or below the cap are untouched.
            let body2 = "exactlyten\nexactlynine\n"; // 10 then 11 chars
            let f2 = tmp_file("linecap2", body2.as_bytes());
            let p2 = f2.to_string_lossy().into_owned();
            let out2 = read_text(&p2, &p2, None, None, Some(10)).unwrap();
            assert_eq!(out2.content, "exactlyten\nexactlynin...[+1 chars]\n");
        }

        #[test]
        fn crlf_noeol_empty_one_and_unicode() {            let out = read(&tmp_file("crlf", b"one\r\ntwo\r\nthree\r\n"), None, None).unwrap();
            assert_eq!(out.content, "one\r\ntwo\r\nthree\r\n");
            assert!(out.truncation.is_none());
            assert_eq!(out.total_bytes, 17);

            let out = read(&tmp_file("noeol", b"alpha\nbeta\ngamma"), None, None).unwrap();
            assert_eq!(out.content, "alpha\nbeta\ngamma");
            assert!(out.truncation.is_none());

            let out = read(&tmp_file("empty", b""), None, None).unwrap();
            assert_eq!(out.content, "");
            assert!(out.truncation.is_none());
            assert_eq!(out.total_bytes, 0);
            // empty file still has one (phantom) line: offset 1 reads it
            let out = read(&tmp_file("empty", b""), Some(1), None).unwrap();
            assert_eq!(out.content, "");

            let out = read(&tmp_file("one", b"solo\n"), None, None).unwrap();
            assert_eq!(out.content, "solo\n");

            let out = read(&tmp_file("uni", "héllo\n🎉emoji\n".as_bytes()), None, None).unwrap();
            assert_eq!(out.content, "héllo\n🎉emoji\n");
            assert_eq!(out.total_bytes, 17); // 6 + 1 + 9 + 1 raw
        }

        #[test]
        fn lossy_decode_matches_node_replacement_semantics() {
            let out = read(&tmp_file("bad", &[0x61, 0xff, 0x62, 0x0a, 0x63, 0xfe, 0x0a]), None, None).unwrap();
            assert_eq!(out.content, "a\u{FFFD}b\nc\u{FFFD}\n");
            assert_eq!(out.total_bytes, 7); // raw, not decoded

            // maximal-subpart rules pinned against Node (2026-10 dump):
            assert_eq!(read(&tmp_file("c0", &[0xc0, 0x80]), None, None).unwrap().content, "\u{FFFD}\u{FFFD}");
            assert_eq!(read(&tmp_file("ed", &[0xed, 0xa0, 0x80]), None, None).unwrap().content, "\u{FFFD}\u{FFFD}\u{FFFD}");
            assert_eq!(read(&tmp_file("f0", &[0xf0, 0x9f]), None, None).unwrap().content, "\u{FFFD}");
            assert_eq!(read(&tmp_file("f4", &[0xf0, 0x9f, 0x8f, 0x80]), None, None).unwrap().content, "🏀");
        }

        #[test]
        fn binary_sniff_window_is_first_8k() {
            let in_window = format!("{}\0\n", "a".repeat(8191));
            let out = read(&tmp_file("nul-in", in_window.as_bytes()), None, None).unwrap();
            assert!(out.binary);
            let out_window = format!("{}\0\n", "a".repeat(8192));
            let out2 = read(&tmp_file("nul-out", out_window.as_bytes()), None, None).unwrap();
            assert!(!out2.binary);
            // NUL is valid UTF-8: content keeps it, unchanged (nul.bin dump)
            let out3 = read(&tmp_file("nulbin", b"ab\0cd\0ef\n"), None, None).unwrap();
            assert!(out3.binary);
            assert_eq!(out3.content, "ab\0cd\0ef\n");
        }

        #[test]
        fn offset_windows_and_phantom_line() {
            // mid dump: 30 lines, offset 10 (0-based 9), limit 5 -> L9..L13 + note
            let body: String = (0..30).map(|i| format!("L{i}")).collect::<Vec<_>>().join("\n");
            let f = tmp_file("mid", body.as_bytes());
            let out = read(&f, Some(10), Some(5)).unwrap();
            assert_eq!(out.content, "L9\nL10\nL11\nL12\nL13\n\n[16 more lines in file. Use offset=15 to continue.]");
            assert!(out.truncation.is_none());

            // phantom line: "a\nb\nc\n" has 4 segments; offset 4 reads ""
            let f = tmp_file("phantom", b"a\nb\nc\n");
            assert_eq!(read(&f, Some(4), None).unwrap().content, "");
            // offset 3, limit 2 -> [c, ""] -> "c\n", no note (reached EOF)
            assert_eq!(read(&f, Some(3), Some(2)).unwrap().content, "c\n");
            // beyond EOF rejects with the built-in's message
            let err = read(&f, Some(5), None).unwrap_err();
            assert!(matches!(err.kind, ErrorKind::Offset));
            assert_eq!(err.message, "Offset 5 is beyond end of file (4 lines total)");
            // u64::MAX offset: no overflow, clean rejection
            let err = read(&f, Some(u64::MAX), None).unwrap_err();
            assert_eq!(err.message, "Offset 18446744073709551615 is beyond end of file (4 lines total)");
        }

        #[test]
        fn user_limit_note_counts_phantom() {
            // limit dump: "a\nb\nc\nd\n" limit 2 -> 5 segments, 3 remain
            let out = read(&tmp_file("limit", b"a\nb\nc\nd\n"), None, Some(2)).unwrap();
            assert_eq!(out.content, "a\nb\n\n[3 more lines in file. Use offset=3 to continue.]");
            assert!(out.truncation.is_none());
        }

        #[test]
        fn compaction_diagnostics_are_envelope_only() {
            // The head-tail compaction notice is a debugging detail. It must be
            // readable from the envelope (`details.compaction`) and must never
            // be written to a stream, so a host that surfaces stderr cannot
            // echo `piread: compacted (...)` into the conversation.
            let body: String = (0..2500).map(|i| format!("line{:04}\n", i)).collect();
            let f = tmp_file("compacted-envelope", body.as_bytes());
            let resolved = f.to_string_lossy().to_string();
            let out = read_text_compacted(&resolved, &resolved, None, None, None).unwrap();
            let notable = out.compaction.as_ref().expect("oversized read is compacted");
            assert_eq!(notable.strategy, "head-tail");
            assert!(notable.omitted_chars > 0);
            assert!(out.content.contains(crate::compress::OMISSION_TAG));
            assert!(
                !out.content.contains("piread: compacted"),
                "diagnostic must not enter model-visible content"
            );
        }

        fn scan(bytes: &[u8]) -> (Vec<String>, u64, bool) {
            let mut segs = Segmenter::new(std::io::Cursor::new(bytes.to_vec()));
            let mut buf: Vec<u8> = Vec::new();
            let mut out = Vec::new();
            while segs.next(&mut buf).expect("segment read") {
                out.push(String::from_utf8(buf.clone()).expect("segment is UTF-8"));
            }
            (out, segs.raw_seen, segs.binary)
        }

        fn segments(bytes: &[u8]) -> Vec<String> {
            scan(bytes).0
        }

        /// JS `split("\n")`: `n` newlines yield `n + 1` segments, a trailing
        /// newline contributes a final empty one, an empty file yields `[""]`.
        /// Pinned because every counting rule downstream reads these bytes.
        #[test]
        fn segmenter_matches_js_split_semantics() {
            let cases: [(&[u8], &[&str]); 7] = [
                (b"", &[""]),
                (b"a", &["a"]),
                (b"a\n", &["a", ""]),
                (b"\n", &["", ""]),
                (b"a\nb", &["a", "b"]),
                (b"a\r\nb\r\n", &["a\r", "b\r", ""]),
                (b"\n\n", &["", "", ""]),
            ];
            for (bytes, want) in cases {
                assert_eq!(segments(bytes), want, "input {bytes:?}");
            }
        }

        #[test]
        fn segmenter_spans_reader_chunks_and_counts_raw_bytes() {
            // A single 200 KiB line: the segment comes back whole however the
            // 64 KiB BufReader chunks it, and raw_seen equals the file length.
            let body = vec![b'q'; 200 * 1024];
            let (out, raw_seen, binary) = scan(&body);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].len(), body.len());
            assert_eq!(raw_seen, body.len() as u64);
            assert!(!binary);

            // Many short lines crossing chunk boundaries.
            let mut body = Vec::new();
            for i in 0..5000 {
                body.extend_from_slice(format!("line{i}\n").as_bytes());
            }
            let (out, raw_seen, _) = scan(&body);
            assert_eq!(out.len(), 5001);
            assert_eq!(out[0], "line0");
            assert_eq!(out[4999], "line4999");
            assert_eq!(out[5000], "");
            assert_eq!(raw_seen, body.len() as u64);

            // NUL inside the first 8 KiB marks the file binary; past it, not.
            let mut early = vec![b'a'; 1024];
            early[100] = 0;
            assert!(scan(&early).2);
            let mut late = vec![b'a'; 16 * 1024];
            late[9000] = 0;
            assert!(!scan(&late).2);
        }

        /// Once the head buffer is full (line cap or byte cap), later selected
        /// lines cannot be rendered — but the selection's *totals* still feed
        /// `truncation.total_bytes` / `total_lines`. This pins them, so a fast
        /// path that skips decode/push for those lines stays honest.
        #[test]
        fn saturated_selection_keeps_line_and_byte_totals_exact() {
            let body: String = (0..5000).map(|i| format!("line{i}\n")).collect();
            let f = tmp_file("saturated", body.as_bytes());
            let out = read(&f, None, None).unwrap();
            let t = out.truncation.expect("overflowing selection is truncated");
            assert_eq!(t.total_lines, 5000);
            assert_eq!(t.output_lines, 2000);
            assert_eq!(t.truncated_by, Some(TruncationKind::Lines));
            // Joined selection length: every segment after the first adds one
            // separator, so the phantom trailing segment contributes the last.
            assert_eq!(t.total_bytes, body.len() as u64);
        }

        #[test]
        fn bytelim_offset_reads_untruncated_window() {
            let body: String = (0..3).map(|_| "z".repeat(19_999)).collect::<Vec<_>>().join("\n");
            let f = tmp_file("bytelim", body.as_bytes());
            let out = read(&f, Some(2), None).unwrap();
            // offset 2 selects lines 2-3 (no trailing newline): 39999 bytes, no truncation
            let expected = format!("{}\n{}", "z".repeat(19_999), "z".repeat(19_999));
            assert_eq!(out.content, expected);
            assert!(out.truncation.is_none());
            assert_eq!(out.total_bytes, 59_999);
        }
    }
}
