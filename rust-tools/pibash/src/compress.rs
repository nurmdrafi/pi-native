//! Deterministic, command-aware tool-output compression.
//!
//! No LLM, no timestamps, no thread/iteration nondeterminism: the same command
//! and the same bytes always produce the same output, byte-for-byte. The
//! classifier picks a [`CommandKind`] from the command string; the formatters
//! turn oversized output into a head-tail or error-priority view that always
//! preserves UTF-8 boundaries, always carries an explicit omission marker with
//! an omitted-size count, and never drops actionable lines (errors, warnings,
//! failures, panics, assertions, stack frames, file/line refs, final summary).
//!
//! This module is deterministic and side-effect free: it never writes. The
//! spill file — the lossless copy of the full output — is owned by
//! [`crate::accumulator`]; the streaming twins below read it in bounded
//! windows, never materializing the stream.

use crate::accumulator::{read_spill_string, utf8_chunks_valid, FullStream};
use crate::truncate::{
    js_byte_length, split_lines, truncate_string_to_bytes_from_end,
    truncate_string_to_bytes_from_start,
};
use std::borrow::Cow;
use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// The compression target: the model-visible budget enforced by the
/// permission-gate H1 cap (40 lines / 2 KB, `extensions/permission-gate/`
/// `bash-cap.ts`). Tier-1 prunes to THIS budget so `error_priority` / `head_tail`
/// windows form inside the envelope the model actually sees, and the gate can
/// pass the result through without re-cutting rescued diagnostics.
///
/// Distinct from the accumulator's `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`
/// (2000 / 50 KB), which remain the spill + parity-envelope cap matching the
/// built-in oracle.
pub const COMPRESS_MAX_LINES: usize = 40;
pub const COMPRESS_MAX_BYTES: usize = 2048;

/// True when `text` carries a Tier-1 omission marker, i.e. this tool already
/// compressed it. The permission gate uses the same signal to skip H1; exposed
/// for tests and consumers that verify the wire contract.
#[must_use]
#[allow(dead_code)]
pub fn has_omission_marker(text: &str) -> bool {
    text.contains(OMISSION_TAG)
}

/// Command family inferred from the command string.
///
/// Deterministic first-match-wins over shell-separated segments, so
/// `rg foo && cargo test` classifies as [`CommandKind::Test`] (the first
/// recognized segment), not Search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Test,
    Build,
    Git,
    Search,
    Log,
    Generic,
}

/// Which formatter produced the visible text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// Output fit the inline budget: verbatim, no omission.
    None,
    /// Head-tail split with a success/failure asymmetry.
    HeadTail,
    /// Actionable lines kept verbatim; non-actionable repetition collapsed.
    ErrorPriority,
}

impl Strategy {
    /// Stable wire name (requirement 5: `strategy`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::None => "none",
            Strategy::HeadTail => "head-tail",
            Strategy::ErrorPriority => "error-priority",
        }
    }
}

/// Compression metadata attached to the success envelope (requirement 5).
#[derive(Debug, Clone, serde::Serialize)]
pub struct CompressionMeta {
    /// `none` | `head-tail` | `error-priority`.
    pub strategy: &'static str,
    #[serde(rename = "originalChars")]
    pub original_chars: usize,
    #[serde(rename = "visibleChars")]
    pub visible_chars: usize,
    #[serde(rename = "omittedChars")]
    pub omitted_chars: usize,
    #[serde(rename = "spillUsed")]
    pub spill_used: bool,
    /// Present only when a spill file actually holds the full output.
    #[serde(rename = "fullOutputPath", skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
}

/// Classify a command string into a [`CommandKind`].
///
/// Shell-separated segments are scanned left to right; the first segment whose
/// leading tokens match a known command wins, so `rg foo && cargo test` is Test.
#[must_use]
pub fn classify(command: &str) -> CommandKind {
    for segment in split_segments(command) {
        if let Some(kind) = classify_segment(&segment) {
            return kind;
        }
    }
    CommandKind::Generic
}

/// Split on the common command separators, preserving order.
fn split_segments(command: &str) -> Vec<String> {
    command
        .split(['&', '|', ';', '\n'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

/// Leading tokens of one segment, skipping `sudo`/env-var prefixes.
fn leading_tokens(segment: &str) -> Vec<String> {
    let mut tokens: Vec<String> = segment
        .split_whitespace()
        .map(str::to_string)
        .collect();
    while let Some(first) = tokens.first() {
        if first == "sudo" || (first.contains('=') && !first.starts_with('-')) {
            tokens.remove(0);
        } else {
            break;
        }
    }
    tokens
}

fn classify_segment(segment: &str) -> Option<CommandKind> {
    let tokens = leading_tokens(segment);
    let first = tokens.first()?.as_str();
    let second = tokens.get(1).map(String::as_str).unwrap_or("");
    match first {
        "cargo" => match second {
            "test" => Some(CommandKind::Test),
            "build" | "check" | "clippy" => Some(CommandKind::Build),
            _ => None,
        },
        "npm" | "pnpm" | "yarn" | "bun" => match second {
            "test" => Some(CommandKind::Test),
            "run" => match tokens.get(2).map(String::as_str) {
                Some("build") => Some(CommandKind::Build),
                Some("test") => Some(CommandKind::Test),
                _ => None,
            },
            "build" => Some(CommandKind::Build),
            _ => None,
        },
        "pytest" | "jest" | "mocha" | "vitest" => Some(CommandKind::Test),
        "go" => match second {
            "test" => Some(CommandKind::Test),
            "build" => Some(CommandKind::Build),
            _ => None,
        },
        "make" | "tsc" | "gcc" | "clang" | "vite" => Some(CommandKind::Build),
        "git" => match second {
            "diff" | "log" | "status" | "show" | "stash" => Some(CommandKind::Git),
            _ => None,
        },
        "grep" | "rg" | "ag" | "ack" | "fd" | "find" => Some(CommandKind::Search),
        "docker" if second == "logs" => Some(CommandKind::Log),
        "kubectl" if second == "logs" => Some(CommandKind::Log),
        "journalctl" => Some(CommandKind::Log),
        "tail" if tokens.iter().any(|t| t == "-f") => Some(CommandKind::Log),
        _ => None,
    }
}

/// Result of a compression pass: the visible text plus what was dropped.
pub struct Compressed<'a> {
    pub content: Cow<'a, str>,
    pub strategy: Strategy,
    /// Characters omitted (always 0 when `strategy == Strategy::None`).
    pub omitted_chars: usize,
    /// True when the formatter cut a single long line rather than whole lines.
    /// Part of the compression result; consumed by tests and future renderers.
    #[allow(dead_code)]
    pub partial: bool,
}

impl<'a> Compressed<'a> {
    fn verbatim(text: &'a str) -> Self {
        Compressed {
            content: Cow::Borrowed(text),
            strategy: Strategy::None,
            omitted_chars: 0,
            partial: false,
        }
    }
}

/// Marker inserted where content was dropped. Deterministic and char-counted —
/// no wall-clock, no run id — so the output is reproducible (requirement 7).
///
/// The stable prefix doubles as an idempotence tag: a body that already carries
/// it is never re-truncated.
pub const OMISSION_TAG: &str = "[... omitted ";

#[must_use]
pub fn omission_marker(omitted_chars: usize, omitted_lines: usize) -> String {
    if omitted_lines > 0 {
        format!("{OMISSION_TAG}{omitted_chars} chars / {omitted_lines} lines ...]")
    } else {
        format!("{OMISSION_TAG}{omitted_chars} chars ...]")
    }
}

/// Head-tail split honoring the success/failure asymmetry (requirement 2).
///
/// Successful commands retain more head than tail (2/3 head); failed commands
/// retain more tail than head (2/3 tail), because a failure's summary and error
/// lines sit at the end. Line-aligned; a single line larger than the whole
/// budget is cut head+tail on a UTF-8 boundary. Always emits an omission marker
/// when it drops anything.
#[must_use]
pub fn head_tail(text: &str, max_lines: usize, max_bytes: usize, success: bool) -> Compressed<'_> {
    head_tail_lines(text, &split_lines(text), max_lines, max_bytes, success)
}

fn head_tail_lines<'a>(
    text: &'a str,
    lines: &[&str],
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Compressed<'a> {
    if fits(text, max_lines, max_bytes) {
        return Compressed::verbatim(text);
    }
    // Idempotence: a body our formatter already emitted carries the marker; do
    // not re-truncate it (re-truncation would drop kept content and rewrite the
    // count, breaking determinism and losing information).
    if text.contains(OMISSION_TAG) {
        return Compressed::verbatim(text);
    }
    let total_lines = lines.len();

    // Split the budgets 2/3 : 1/3, head-heavy on success, tail-heavy on failure.
    // Reserve 3 lines for the marker and its two blank separators so the TOTAL
    // output line count (content + markers) stays within `max_lines`.
    let (head_share, tail_share): (usize, usize) = if success { (2, 1) } else { (1, 2) };
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * head_share / (head_share + tail_share);
    let tail_lines_budget = content_lines - head_lines_budget;
    let head_bytes_budget = max_bytes * head_share / (head_share + tail_share);
    let tail_bytes_budget = max_bytes - head_bytes_budget;

    let head = take_head(lines, head_lines_budget, head_bytes_budget);
    // The tail scans from the true end; overlap with the head is trimmed after.
    let tail = take_tail(lines, total_lines, tail_lines_budget, tail_bytes_budget);
    let tail = trim_overlap(lines, head.kept, tail);

    let kept_lines = head.kept + tail.kept;
    if kept_lines >= total_lines {
        // Nothing dropped after alignment: still verbatim.
        return Compressed::verbatim(text);
    }
    let omitted_lines = total_lines - kept_lines;
    let omitted_chars =
        text.chars().count().saturating_sub(head.text.chars().count() + tail.text.chars().count());
    let marker = omission_marker(omitted_chars, omitted_lines);
    let content = format!("{}\n\n{marker}\n\n{}", head.text, tail.text);
    Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head.partial || tail.partial,
    }
}

fn fits(text: &str, max_lines: usize, max_bytes: usize) -> bool {
    line_count(text) <= max_lines && js_byte_length(text) <= max_bytes
}

/// Generic-kind fast path for oversized, ANSI-free, fold-free, marker-free
/// streams: one fused scan replaces the full line materialization
/// (`split_lines` allocates a `Vec<&str>` with one entry per line) and the
/// dedup pre-pass. The scan captures only the head/tail windows the budget
/// arithmetic can ever read, and detects everything the materialized path
/// would act on: any ESC byte (ANSI), `[` (omission-tag prefix byte), or
/// adjacent duplicate line (fold candidate) aborts to `None`, so the caller
/// falls back to the exact existing path — byte-identical output by
/// construction, never by parity of reimplementation.
///
/// Preconditions, established by the caller: the body exceeds the budget.
/// The fast path is taken only when `total > window`; for smaller bodies
/// `trim_overlap` and the kept-everything branch become reachable, so they
/// stay on the materialized path. Overlap proof for large streams: real
/// overlap needs `total < head_kept + tail_kept <= head_budget +
/// tail_budget < window < total` — a contradiction, so skipping
/// `trim_overlap` is exact.
#[must_use]
fn head_tail_windowed(
    text: &str,
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Option<Compressed<'_>> {
    // Budget arithmetic mirrored from `head_tail_lines` (requirement 2).
    let (head_share, tail_share): (usize, usize) = if success { (2, 1) } else { (1, 2) };
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * head_share / (head_share + tail_share);
    let tail_lines_budget = content_lines - head_lines_budget;
    let head_bytes_budget = max_bytes * head_share / (head_share + tail_share);
    let tail_bytes_budget = max_bytes - head_bytes_budget;

    let window = head_lines_budget + tail_lines_budget + 4;
    let bytes = text.as_bytes();

    // Fused single scan: count lines, capture head window (fixed capacity)
    // and tail window (ring of the last `window` lines), bail on any anomaly.
    let mut head: Vec<(usize, usize)> = Vec::with_capacity(head_lines_budget);
    let mut tail: VecDeque<(usize, usize)> = VecDeque::with_capacity(window);
    let mut total = 0usize;
    let mut start = 0usize;
    let mut prev: Option<(usize, usize)> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b || b == b'[' {
            return None; // ANSI escape or omission-tag prefix byte.
        }
        if b == b'\n' {
            let dup = prev.is_some_and(|(ps, pe)| {
                pe - ps == i - start && bytes[ps..pe] == bytes[start..i]
            });
            if dup {
                return None; // adjacent duplicate: a fold candidate.
            }
            prev = Some((start, i));
            total += 1;
            if head.len() < head_lines_budget {
                head.push((start, i));
            }
            if tail.len() == window {
                tail.pop_front();
            }
            tail.push_back((start, i));
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < bytes.len() {
        // Final line without a trailing newline; same duplicate guard.
        let dup = prev.is_some_and(|(ps, pe)| {
            pe - ps == bytes.len() - start && bytes[ps..pe] == bytes[start..bytes.len()]
        });
        if dup {
            return None;
        }
        total += 1;
        if head.len() < head_lines_budget {
            head.push((start, bytes.len()));
        }
        if tail.len() == window {
            tail.pop_front();
        }
        tail.push_back((start, bytes.len()));
    }
    if total <= window {
        return None; // Small corpora: overlap/kept-everything branches live on
                     // the materialized path.
    }

    let head_lines: Vec<&str> = head.iter().map(|&(s, e)| &text[s..e]).collect();
    let tail_lines: Vec<&str> = tail.iter().map(|&(s, e)| &text[s..e]).collect();

    let head_slice = take_head(&head_lines, head_lines_budget, head_bytes_budget);
    // `from = tail_lines.len()`: walking the window from its end touches the
    // true last lines (total > window), with identical per-line byte math.
    let tail_slice = take_tail(
        &tail_lines,
        tail_lines.len(),
        tail_lines_budget,
        tail_bytes_budget,
    );

    let omitted_lines = total - head_slice.kept - tail_slice.kept;
    let omitted_chars = text
        .chars()
        .count()
        .saturating_sub(head_slice.text.chars().count() + tail_slice.text.chars().count());
    let marker = omission_marker(omitted_chars, omitted_lines);
    let content = format!("{}\n\n{marker}\n\n{}", head_slice.text, tail_slice.text);
    Some(Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head_slice.partial || tail_slice.partial,
    })
}

/// Streaming state for [`head_tail_windowed_folds`]: budget-bounded head/tail
/// rings of REBUILT lines (fold markers are synthesized and owned, plain
/// lines borrow the input) plus the running totals of the virtual rebuild.
struct FoldWindow<'a> {
    /// Rebuilt line count, before the trailing-phantom adjustment.
    total: usize,
    /// Sum of char counts over every rebuilt line.
    chars: usize,
    /// Sum of byte lengths over every rebuilt line.
    nbytes: usize,
    /// Fold markers emitted (0 => the dedup pass is a no-op).
    folds: usize,
    /// First rebuilt lines — `take_head`'s reach plus one entry.
    head: Vec<Cow<'a, str>>,
    /// Ring bytes under `take_head` accounting (first line: no separator).
    head_bytes: usize,
    /// False once the byte cap makes further head entries unreachable.
    head_open: bool,
    head_cap: usize,
    head_budget: usize,
    /// Last rebuilt lines — `take_tail`'s reach plus one entry.
    tail: VecDeque<Cow<'a, str>>,
    /// Ring bytes under `take_tail` accounting (every line: +1).
    tail_bytes: usize,
    tail_cap: usize,
    tail_budget: usize,
    last_empty: bool,
}

impl<'a> FoldWindow<'a> {
    /// Record one rebuilt line: totals first, then ring maintenance. Both
    /// rings stay O(budget): the head stops growing once its cumulative
    /// `take_head` cost busts the head byte budget (`take_head` can never read
    /// past that line), and the tail drops front entries beyond `take_tail`'s
    /// line or byte reach (a dropped entry is exactly one `take_tail` would
    /// break on, so its content is never needed).
    fn emit(&mut self, line: Cow<'a, str>) {
        self.last_empty = line.is_empty();
        self.total += 1;
        self.chars += line.chars().count();
        self.nbytes += line.len();
        if self.head_open && self.head.len() < self.head_cap {
            self.head_bytes += line.len() + usize::from(!self.head.is_empty());
            self.head.push(line.clone());
            if self.head_bytes > self.head_budget {
                self.head_open = false;
            }
        }
        self.tail_bytes += line.len() + 1;
        self.tail.push_back(line);
        while self.tail.len() > self.tail_cap
            || (self.tail_bytes > self.tail_budget && self.tail.len() > 1)
        {
            match self.tail.pop_front() {
                Some(front) => self.tail_bytes -= front.len() + 1,
                None => break,
            }
        }
    }

    /// Fold a completed run exactly as `dedup_lines` pass 2 would: one
    /// synthesized marker line for foldable runs, the members verbatim
    /// otherwise (actionable and blank lines never fold).
    fn flush(&mut self, text: &'a str, first: (usize, usize), run: usize) {
        let line = &text[first.0..first.1];
        self.flush_line(line, run);
    }

    /// `flush` over a line the walker carried — same fold rule, owned copies
    /// instead of borrows (the streaming twin feeds `FoldWindow<'static>`).
    fn flush_line(&mut self, line: &str, run: usize) {
        if run > 1 && !is_actionable(line) && !line.trim().is_empty() {
            self.folds += 1;
            self.emit(Cow::Owned(format!(
                "{line} [... repeated {run} times ...]"
            )));
        } else {
            for _ in 0..run {
                self.emit(Cow::Owned(line.to_string()));
            }
        }
    }
}

/// Generic-kind fold fast path: the counterpart of [`head_tail_windowed`] for
/// the over-budget bodies that scan declines on — ANSI-free, marker-free
/// streams WITH adjacent duplicate lines (fold candidates). The materialized
/// path would `split_lines` the whole stream (16 B per line) and rebuild it
/// into a stream-sized `String`; this pass runs the dedup fold virtually in
/// one fused scan: runs are detected inline, rebuilt lines flow into
/// budget-bounded head/tail rings, and running counters stand in for the
/// rebuilt string. `None` defers to the exact materialized path on every band
/// the rings cannot prove — anomaly bytes, no fold, a rebuild that fits, and
/// the kept-everything/overlap band — so the output equals
/// `dedup_lines` + `head_tail` composed, never a reimplementation parity.
#[must_use]
fn head_tail_windowed_folds(
    text: &str,
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Option<Compressed<'_>> {
    // Budget arithmetic mirrored from `head_tail_lines` (requirement 2).
    let (head_share, tail_share): (usize, usize) = if success { (2, 1) } else { (1, 2) };
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * head_share / (head_share + tail_share);
    let tail_lines_budget = content_lines - head_lines_budget;
    let head_bytes_budget = max_bytes * head_share / (head_share + tail_share);
    let tail_bytes_budget = max_bytes - head_bytes_budget;

    let bytes = text.as_bytes();
    let mut win = FoldWindow {
        total: 0,
        chars: 0,
        nbytes: 0,
        folds: 0,
        head: Vec::with_capacity(head_lines_budget + 1),
        head_bytes: 0,
        head_open: true,
        head_cap: head_lines_budget + 1,
        head_budget: head_bytes_budget,
        tail: VecDeque::with_capacity(tail_lines_budget + 1),
        tail_bytes: 0,
        tail_cap: tail_lines_budget + 1,
        tail_budget: tail_bytes_budget,
        last_empty: false,
    };

    // Fused scan: run detection shares the anomaly walk, so 0x1b / b'[' bail
    // before any further state grows.
    let mut run_first = (0usize, 0usize);
    let mut run_len = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b || b == b'[' {
            return None; // ANSI escape or omission-tag prefix byte.
        }
        if b == b'\n' {
            // Oversized line: every band this pass can prove needs the whole
            // line in hand (fold markers embed it; the verbatim-rebuild band
            // requires the total under `max_bytes`), and flushing it into the
            // rings would copy it whole. Defer to the materialized path.
            if i - start > max_bytes {
                return None;
            }
            if run_len > 0 && bytes[run_first.0..run_first.1] == bytes[start..i] {
                run_len += 1;
            } else {
                if run_len > 0 {
                    win.flush(text, run_first, run_len);
                }
                run_first = (start, i);
                run_len = 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    if start < bytes.len() {
        // Final line without a trailing newline; same run rule, same
        // oversized-line defer.
        if bytes.len() - start > max_bytes {
            return None;
        }
        if run_len > 0 && bytes[run_first.0..run_first.1] == bytes[start..bytes.len()] {
            run_len += 1;
        } else {
            if run_len > 0 {
                win.flush(text, run_first, run_len);
            }
            run_first = (start, bytes.len());
            run_len = 1;
        }
    }
    if run_len > 0 {
        win.flush(text, run_first, run_len);
    }

    if win.folds == 0 {
        return None; // Dedup is a no-op here; the exact path below owns it.
    }
    // The rebuild joins with '\n' and never writes a trailing one, so a
    // trailing empty source line leaves the rebuilt string ending in '\n' —
    // `split_lines` pops that phantom. Mirror it: the line totals and the
    // tail ring drop the last rebuilt line. (The rebuilt STRING keeps its
    // trailing '\n', so the char/byte totals below do not.)
    let mut total = win.total;
    if win.last_empty {
        if total <= 1 {
            return None; // Degenerate rebuild; the exact path owns it.
        }
        total -= 1;
        if let Some(dropped) = win.tail.pop_back() {
            win.tail_bytes -= dropped.len() + 1;
        }
    }
    // Rebuild fits the budget: cleaning is not omission, so the ORIGINAL body
    // comes back verbatim with Strategy::None (pinned by the fold tests).
    if total <= max_lines && win.nbytes + win.total - 1 <= max_bytes {
        return Some(Compressed::verbatim(text));
    }
    if total <= head_lines_budget + tail_lines_budget {
        return None; // kept-everything / overlap bands stay materialized.
    }
    let head_lines: Vec<&str> = win.head.iter().map(|c| c.as_ref()).collect();
    let tail_lines: Vec<&str> = win.tail.iter().map(|c| c.as_ref()).collect();
    let head = take_head(&head_lines, head_lines_budget, head_bytes_budget);
    // `from = tail_lines.len()`: the ring holds the true last lines (total
    // exceeds both budgets), with identical per-line byte math.
    let tail = take_tail(
        &tail_lines,
        tail_lines.len(),
        tail_lines_budget,
        tail_bytes_budget,
    );
    // Overlap is unreachable — same proof as `head_tail_windowed`: real
    // overlap needs total < head_kept + tail_kept <= head+tail budgets, but
    // this band only runs with total > head+tail budgets. Skipping
    // `trim_overlap` (and the kept-everything branch) is therefore exact.
    let omitted_lines = total - head.kept - tail.kept;
    // Marker math over the REBUILT totals: every rebuilt line's chars plus
    // the total-1 '\n' separators the join would write.
    let rebuilt_chars = win.chars + win.total - 1;
    let omitted_chars = rebuilt_chars
        .saturating_sub(head.text.chars().count())
        .saturating_sub(tail.text.chars().count());
    let marker = omission_marker(omitted_chars, omitted_lines);
    let content = format!("{}\n\n{marker}\n\n{}", head.text, tail.text);
    Some(Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head.partial || tail.partial,
    })
}

/// `split_lines(text).len()` without materializing the line vector — one
/// linear scan, zero allocations, same phantom-line semantics.
fn line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    text.matches('\n').count() + usize::from(!text.ends_with('\n'))
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

/// Last `max_lines` lines / `max_bytes` bytes below `from`, boundary-safe.
fn take_tail(lines: &[&str], from: usize, max_lines: usize, max_bytes: usize) -> Slice {
    let mut kept = 0usize;
    let mut bytes = 0usize;
    let mut start = from;
    for idx in (0..from).rev() {
        if kept >= max_lines {
            break;
        }
        let line = lines[idx];
        let line_bytes = js_byte_length(line) + 1;
        if bytes + line_bytes > max_bytes {
            if kept == 0 {
                return Slice {
                    text: truncate_string_to_bytes_from_end(line, max_bytes),
                    kept: 0,
                    partial: true,
                };
            }
            break;
        }
        bytes += line_bytes;
        kept += 1;
        start = idx;
    }
    Slice {
        text: lines[start..from].join("\n"),
        kept,
        partial: false,
    }
}

/// Drop any tail lines that overlap the head's kept span, and recompute kept.
fn trim_overlap(lines: &[&str], head_kept: usize, tail: Slice) -> Slice {
    if tail.partial || tail.kept == 0 {
        return tail;
    }
    // The tail's first line index is total - kept (contiguous from the end).
    let total = lines.len();
    let tail_start = total - tail.kept;
    if tail_start >= head_kept {
        return tail;
    }
    let new_start = head_kept.min(total);
    let kept = total.saturating_sub(new_start);
    Slice {
        text: lines[new_start..].join("\n"),
        kept,
        partial: false,
    }
}

/// Requirement 4: keep actionable lines verbatim while collapsing repeated,
/// non-actionable progress repetition.
///
/// Actionable lines — errors, warnings, failures, panics, assertions, stack
/// frames, file:line references, and the final summary — are always kept. Runs
/// of identical or progress-shaped lines collapse to one representative line
/// plus a count. Always emits an omission marker when it drops anything.
#[must_use]
pub fn error_priority(text: &str, max_lines: usize, max_bytes: usize) -> Compressed<'_> {
    error_priority_lines(text, &split_lines(text), max_lines, max_bytes)
}

fn error_priority_lines<'a>(text: &'a str, lines: &[&str], max_lines: usize, max_bytes: usize) -> Compressed<'a> {
    if js_byte_length(text) <= max_bytes && lines.len() <= max_lines {
        return Compressed::verbatim(text);
    }
    // Idempotence: never re-compress a body we already emitted.
    if text.contains(OMISSION_TAG) {
        return Compressed::verbatim(text);
    }

    if text.contains(OMISSION_TAG) {
        return Compressed::verbatim(text);
    }

    let total_lines = lines.len();

    // Rule (requirement 4): preserve ALL actionable lines verbatim, then fill
    // the remaining budget with head-tail context. `keep` is a byte-per-line
    // bitmap (O(1) membership); a set here cost O(log n) per probe across
    // hundreds of thousands of lines.
    let mut keep: Vec<bool> = vec![false; total_lines];
    let mut actionable_count = 0usize;
    let mut actionable_bytes = 0usize;
    for (i, line) in lines.iter().enumerate() {
        if is_actionable(line) {
            keep[i] = true;
            actionable_count += 1;
            actionable_bytes += js_byte_length(line) + 1;
        }
    }

    // Budget for context is what is left after the actionable lines, measured
    // in BOTH bytes and lines (the parity tail-truncation caps at 2000 lines,
    // so context must leave room to keep the middle actionable lines under
    // both caps).
    let context_budget = max_bytes.saturating_sub(actionable_bytes);
    // Reserve a line for each maximal gap's omission marker (at most two gaps:
    // before and after the kept span) so kept lines + markers stay ≤ max_lines.
    let context_line_budget = max_lines
        .saturating_sub(actionable_count)
        .saturating_sub(2);
    let mut taken_total = 0usize;
    if context_budget > 0 && context_line_budget > 0 {
        // Head context first, then tail context, so the ends are covered. The
        // line and byte budgets are SHARED across both passes so the total kept
        // line count stays within `max_lines`; each pass gets at most half the
        // line budget so both ends are represented. Each pass stops as soon as
        // its per-pass budget is spent, so it never walks the whole stream.
        let per_pass_lines = context_line_budget / 2;
        fill_context(
            lines,
            &mut keep,
            0..total_lines,
            per_pass_lines,
            context_budget,
            &mut taken_total,
            context_line_budget,
        );
        fill_context(
            lines,
            &mut keep,
            (0..total_lines).rev(),
            per_pass_lines,
            context_budget,
            &mut taken_total,
            context_line_budget,
        );
    }

    if actionable_count + taken_total >= total_lines {
        return Compressed::verbatim(text);
    }

    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut omitted_chars = 0usize;
    while i < total_lines {
        if keep[i] {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        // Collapse a maximal run of dropped lines into one marker.
        let mut run = 0usize;
        while i + run < total_lines && !keep[i + run] {
            omitted_chars += lines[i + run].chars().count() + 1; // +newline
            run += 1;
        }
        if run > 0 {
            out.push(omission_marker(0, run));
            i += run;
        } else {
            // Defensive: keep would have handled index i, so this branch is
            // unreachable; advance to guarantee termination regardless.
            i += 1;
        }
    }

    let content = out.join("\n");
    Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::ErrorPriority,
        omitted_chars,
        partial: false,
    }
}

/// Fill head or tail context into a `keep` bitmap, honoring the per-pass line
/// budget, the shared line budget, and the byte budget. Iterates only until the
/// per-pass budget is spent, so it never walks the whole stream.
fn fill_context(
    lines: &[&str],
    keep: &mut [bool],
    indices: impl Iterator<Item = usize>,
    per_pass_lines: usize,
    context_budget: usize,
    taken_total: &mut usize,
    context_line_budget: usize,
) {
    let mut bytes = 0usize;
    let mut taken = 0usize;
    for i in indices {
        if keep[i] {
            continue;
        }
        if taken >= per_pass_lines || *taken_total >= context_line_budget {
            break;
        }
        let line_bytes = js_byte_length(lines[i]) + 1;
        if bytes + line_bytes > context_budget {
            break;
        }
        bytes += line_bytes;
        taken += 1;
        *taken_total += 1;
        keep[i] = true;
    }
}

/// A line the model must see: errors, warnings, failures, panics, assertions,
/// stack frames, file:line refs, and the final test/build summary.
///
/// Matchers are hand-rolled (no regex crate) and deliberately high-confidence:
/// they target real runtime traces and compiler diagnostics rather than any
/// prose that merely contains a keyword. The generic `at ` marker is gone — it
/// matched conversational text and defeated the compression goal.
fn is_actionable(line: &str) -> bool {
    let trimmed = line.trim_start();

    // One cheap byte scan gates the precise matchers. Most compiler-progress and
    // download-noise lines contain none of the signature bytes below and fall
    // out here in a single pass instead of ~15 substring searches. Presence is
    // necessary but not sufficient — the precise matchers still decide.
    let mut has_colon = false;
    let mut has_marker_byte = false;
    for &b in trimmed.as_bytes() {
        match b {
            b':' => has_colon = true,
            b'e' | b'E' | b'r' | b'R' | b'a' | b'A' | b'"' | b'/' | b'-' | b't' | b'T' => {
                has_marker_byte = true
            }
            _ => {}
        }
        if has_colon && has_marker_byte {
            break;
        }
    }
    if !has_colon && !has_marker_byte {
        return false;
    }

    // --- Rust: `--> path:line:col` ---
    if trimmed.starts_with("-->") {
        return true;
    }
    // --- JS/TS/Node stack frames: `at fn (loc)` / node:/node_modules/ ---
    if trimmed.starts_with("at ") || trimmed.contains("(node:internal/") || trimmed.contains("/node_modules/") {
        return true;
    }
    // --- Python: `File "...", line N` ---
    if trimmed.starts_with("File \"") && trimmed.contains(", line ") {
        return true;
    }

    // --- Keyword markers (case-insensitive, single lowercased copy) ---
    // `str::contains` is SIMD/two-way accelerated; a hand-rolled multi-pattern
    // scan measured SLOWER here, so use the stdlib primitive.
    let lower = ascii_lowercase_cow(trimmed);
    if MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }

    // --- file:line refs (`src/main.rs:10:5`) ---
    if has_colon && contains_file_line(trimmed) {
        return true;
    }

    false
}

/// Marker roots, lowercase; matched case-insensitively.
const MARKERS: &[&str] = &[
    "error", "warning", "warn", "fail", "assert", "panic", "expected",
    "thread '", "test result:", "stack backtrace", "note: run", "traceback",
    "caused by:", "segmentation fault", "core dumped",
];

/// ASCII-only lowercase, borrowing the input when there is nothing to fold
/// (the common all-lowercase case), so the hot path allocates nothing.
fn ascii_lowercase_cow(s: &str) -> std::borrow::Cow<'_, str> {
    if s.bytes().any(|b| b.is_ascii_uppercase()) {
        std::borrow::Cow::Owned(s.to_ascii_lowercase())
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

/// True when the line contains a `path.ext:NN` reference (Rust/C/C++ diagnostics
/// and Python frames). Requires a dot in the path segment so plain prose like
/// `version 1:2` does not match.
fn contains_file_line(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b':' {
            // The char before the colon should end a path-like token, and the
            // char after should start a digit.
            if i > 0 && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
                // Scan back over the path token (letters, digits, . / _ -).
                let mut j = i;
                let mut has_dot = false;
                while j > 0 {
                    let c = bytes[j - 1];
                    if c == b'.' {
                        has_dot = true;
                    } else if !(c.is_ascii_alphanumeric()
                        || c == b'/'
                        || c == b'_'
                        || c == b'-')
                    {
                        break;
                    }
                    j -= 1;
                }
                if has_dot && j < i {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

/// Remove terminal escape sequences: CSI color/style codes, OSC sequences,
/// and lone carriage returns (port of `stripAnsi` in output-scrub.ts). Pure
/// single-pass scan — no regex crate dependency.
#[must_use]
/// ANSI strip, copy-on-write: piped output is ANSI-free in practice, so the
/// common case borrows the input untouched (no stream-sized allocation).
fn strip_ansi_cow(s: &str) -> Cow<'_, str> {
    if !s.as_bytes().contains(&0x1b) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(strip_ansi(s))
}

pub fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC: dispatch on the next byte.
            match bytes.get(i + 1) {
                // CSI: ESC [ ... final byte in 0x40..=0x7e
                Some(b'[') => {
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += usize::from(i < bytes.len());
                }
                // OSC: ESC ] ... terminated by BEL or ESC \
                Some(b']') => {
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                // Two-byte escape (ESC followed by a single byte).
                Some(_) => i += 2,
                None => i += 1,
            }
            continue;
        }
        if b == b'\r' {
            // Drop CR; keep the LF of CRLF, drop a bare CR.
            if bytes.get(i + 1) == Some(&b'\n') {
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        // Copy this UTF-8 run up to the next control char.
        let start = i;
        while i < bytes.len() && bytes[i] != 0x1b && bytes[i] != b'\r' {
            i += 1;
        }
        out.push_str(&s[start..i]);
    }
    out
}

/// Shared-split core of the dedup pass (see the `dedup_repeats` test shim).
fn dedup_lines<'a>(s: &'a str, lines: &[&'a str]) -> Cow<'a, str> {
    if lines.len() < 2 {
        return Cow::Borrowed(s);
    }
    // Pass 1: locate foldable runs with the original predicate.
    let mut folds: Vec<(usize, usize)> = Vec::new(); // (line index, run)
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let mut run = 1usize;
        while i + run < lines.len() && lines[i + run] == line {
            run += 1;
        }
        if run > 1 && !is_actionable(line) && !line.trim().is_empty() {
            folds.push((i, run));
        }
        i += run;
    }
    // Byte-identity when nothing was folded: small output must pass through
    // unchanged (a re-join would drop a trailing newline and break parity).
    if folds.is_empty() {
        return Cow::Borrowed(s);
    }
    // Pass 2: emit through one buffer. The previous shape pushed a
    // `String::to_string` per kept line before joining — one malloc per line,
    // which was the dominant cost on seq-class output. Capacity is bounded to
    // the rebuild's realistic size (a marker per fold plus the kept lines):
    // dedup shrinks, so grow on demand instead of reserving stream-sized.
    let mut out = String::with_capacity(s.len().min(folds.len().saturating_mul(64) + 4096));
    let mut i = 0usize;
    for &(start, run) in &folds {
        while i < start {
            if i > 0 {
                out.push('\n');
            }
            out.push_str(lines[i]);
            i += 1;
        }
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{} [... repeated {run} times ...]",
            lines[start]
        ));
        i += run;
    }
    while i < lines.len() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(lines[i]);
        i += 1;
    }
    Cow::Owned(out)
}

/// Rough token count: characters / 4. Deliberately cheap — the orchestrator's
/// spill logic reads this instead of running a tokenizer in JS.
#[must_use]
pub fn token_estimate(s: &str) -> usize {
    s.chars().count() / 4
}

/// The single deterministic Tier-1 pass main.rs calls.
///
/// Tier-1 only engages when the raw text exceeds the model budget: within
/// budget the output is returned verbatim so pibash stays a byte-identical
/// display oracle for small results. Over budget, the pipeline is
/// strip ANSI → dedup repeated lines → classify-driven reduction
/// (error-priority for test/build, head-tail otherwise).
#[must_use]
pub fn compress_output(
    text: &str,
    kind: CommandKind,
    success: bool,
    max_lines: usize,
    max_bytes: usize,
) -> Compressed<'_> {
    // Within the model budget: nothing to compress, stay byte-identical.
    if js_byte_length(text) <= max_bytes && line_count(text) <= max_lines {
        return Compressed::verbatim(text);
    }

    // Generic fast path: oversized ANSI-free, fold-free, marker-free streams
    // (e.g. `seq 50000`) skip the line materialization and the dedup scan in
    // one fused pass. The scan itself detects every anomaly the materialized
    // path would act on; `None` falls through to the exact path below.
    if !matches!(kind, CommandKind::Test | CommandKind::Build)
        && let Some(c) = head_tail_windowed(text, max_lines, max_bytes, success)
    {
        return c;
    }
    // Fold fast path: the duplicate-line bodies the first scan declined on.
    // Same guard; `None` (anomaly byte, no fold, small rebuild) falls through
    // to the exact materialized path below.
    if !matches!(kind, CommandKind::Test | CommandKind::Build)
        && let Some(c) = head_tail_windowed_folds(text, max_lines, max_bytes, success)
    {
        return c;
    }

    // Tier 1: deterministic structural pruning. Copy-on-write + a single
    // split shared across passes: piped output is ANSI-free and fold-free in
    // the common case, so the stream is neither copied nor re-split per pass.
    let cleaned = strip_ansi_cow(text);
    let lines = split_lines(&cleaned);
    let deduped = dedup_lines(&cleaned, &lines);

    // Test/build output: preserve actionable lines, fill the rest with context.
    // The fold case rewrites the text and invalidates the line slices, so it
    // goes back through the public wrappers (re-splitting) — the rare path.
    if matches!(kind, CommandKind::Test | CommandKind::Build) {
        let c = match &deduped {
            Cow::Borrowed(_) => error_priority_lines(&cleaned, &lines, max_lines, max_bytes),
            Cow::Owned(rebuilt) => error_priority(rebuilt, max_lines, max_bytes),
        };
        if c.strategy == Strategy::ErrorPriority {
            // ErrorPriority content is always an owned window; detaching it
            // from the local `cleaned`/`deduped` borrows is a move, not a copy.
            return Compressed {
                content: Cow::Owned(c.content.into_owned()),
                strategy: c.strategy,
                omitted_chars: c.omitted_chars,
                partial: c.partial,
            };
        }
        // error-priority found nothing to drop; fall through to head-tail.
    }

    let c = match &deduped {
        Cow::Borrowed(_) => head_tail_lines(&cleaned, &lines, max_lines, max_bytes, success),
        Cow::Owned(rebuilt) => head_tail(rebuilt, max_lines, max_bytes, success),
    };
    if c.strategy == Strategy::None {
        // Cleaning alone brought it within budget (ANSI/dup removal is not
        // omission — the visible content is complete), so it stays
        // Strategy::None with the cleaned body.
        return Compressed {
            content: cleaned,
            strategy: Strategy::None,
            omitted_chars: 0,
            partial: false,
        };
    }
    // An omission strategy fired: `c.content` is a small owned window (never
    // the verbatim borrow), so detaching it from the local borrows above is a
    // move, not a copy.
    let Compressed {
        content,
        strategy,
        omitted_chars,
        partial,
    } = c;
    Compressed {
        content: Cow::Owned(content.into_owned()),
        strategy,
        omitted_chars,
        partial,
    }
}

// ---- Spill streaming: the C2 windowed twins ---------------------------------
//
// The `&str` fast paths above scan a materialized string; when the
// accumulator spilled, materializing means a full copy of a 100 MB-class
// stream (measured ~1x the output in peak RSS). These twins run the same
// budget arithmetic over 64 KiB windows read straight off the spill file,
// holding only budget-bounded state. Every band the bounded windows cannot
// prove byte-exact returns `None` and falls through to the exact materialized
// path — same never-a-reimplementation contract as the `&str` fast paths.

/// Read granularity for spill scans.
const STREAM_CHUNK: usize = 64 * 1024;

/// Spills at or below this size materialize once (one page-cache-hot read)
/// instead of streaming: below it the windowed scan's per-line bookkeeping
/// costs more than a single bounded materialization, and the buffer stays
/// under every per-class RSS cap. Above it, O(budget) streaming keeps peak
/// RSS flat as output grows.
const STREAM_MATERIALIZE_MAX: usize = 16 * 1024 * 1024;

/// Bounded facts about one streamed line: byte length and head/tail byte
/// windows of at most `cap` bytes (the whole line when it fits). Windows are
/// trimmed to char boundaries, so they reinterpret as `&str` exactly.
/// Borrowed view of one streamed line: byte length and head/tail byte
/// windows of at most `cap` bytes (the whole line when it fits). Windows are
/// trimmed to char boundaries, so they reinterpret as `&str` exactly. The
/// bytes live in walker-owned buffers reused across lines, so the hot scan
/// allocates nothing per line.
struct LineView<'a> {
    head: &'a [u8],
    tail: &'a [u8],
    len: usize,
}

impl LineView<'_> {
    /// The whole line as `&str`, when it fits the carry cap.
    fn full(&self) -> Option<&str> {
        if self.len <= self.head.len() {
            std::str::from_utf8(self.head).ok()
        } else {
            None
        }
    }
}

/// Windows are boundary-trimmed by the walker, so the decode is exact; the
/// fallback only satisfies the type.
fn window_str(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap_or("")
}

enum WalkEvent<'a> {
    Line(LineView<'a>),
    Eof,
    /// ESC/'[' anomaly byte, invalid UTF-8, or read error: the exact
    /// materialized path owns this stream.
    Bail,
}

/// Chunked line splitter over a spill file. Carries the open line across
/// chunk boundaries byte-exactly (a multibyte char split mid-line is never
/// decoded here — bytes only), and counts chars as non-continuation bytes,
/// exact for the valid-UTF-8 streams the validator lets through.
struct SpillWalker {
    file: File,
    unread: usize,
    buf: Vec<u8>,
    pos: usize,
    /// Incomplete trailing UTF-8 sequence deferred to the next chunk.
    seq: Vec<u8>,
    /// Reused per-line window buffers: cleared at each line start, never
    /// reallocated once capacity reaches the carry cap.
    line_head: Vec<u8>,
    line_tail: Vec<u8>,
    len: usize,
    /// Chars of the whole stream, separators included.
    total_chars: usize,
    cap: usize,
    eof: bool,
}

impl SpillWalker {
    fn open(path: &Path, len: usize, cap: usize) -> Option<Self> {
        let file = File::open(path).ok()?;
        Some(SpillWalker {
            file,
            unread: len,
            buf: Vec::new(),
            pos: 0,
            seq: Vec::new(),
            line_head: Vec::new(),
            line_tail: Vec::new(),
            len: 0,
            total_chars: 0,
            cap,
            eof: false,
        })
    }

    fn next(&mut self) -> WalkEvent<'_> {
        loop {
            if self.pos >= self.buf.len() {
                if self.eof {
                    if !self.seq.is_empty() {
                        return WalkEvent::Bail; // stream ends mid-character
                    }
                    if self.len > 0 {
                        return self.take_line();
                    }
                    return WalkEvent::Eof;
                }
                if !self.refill() {
                    return WalkEvent::Bail;
                }
                continue;
            }
            let nl = self.buf[self.pos..].iter().position(|&b| b == b'\n');
            match nl {
                Some(k) => {
                    let start = self.pos;
                    let end = start + k;
                    self.pos = end + 1;
                    if self.scan_segment(start, end) {
                        return WalkEvent::Bail;
                    }
                    self.total_chars += 1; // the consumed newline
                    return self.take_line();
                }
                None => {
                    let start = self.pos;
                    let end = self.buf.len();
                    self.pos = end;
                    if self.scan_segment(start, end) {
                        return WalkEvent::Bail;
                    }
                }
            }
        }
    }

    /// Fold `buf[start..end]` into the open line; true on an anomaly byte.
    /// One pass: the segment is newline-free by construction, so counting
    /// non-continuation bytes is its exact char count.
    fn scan_segment(&mut self, start: usize, end: usize) -> bool {
        if self.len == 0 {
            // Line start: reset the reused window buffers (capacity stays).
            self.line_head.clear();
            self.line_tail.clear();
        }
        let seg = &self.buf[start..end];
        let mut chars = 0usize;
        for &b in seg {
            if b == 0x1b || b == b'[' {
                return true; // ANSI escape or omission-tag prefix byte.
            }
            if (b & 0xc0) != 0x80 {
                chars += 1;
            }
        }
        if self.line_head.len() < self.cap {
            let take = (self.cap - self.line_head.len()).min(seg.len());
            self.line_head.extend_from_slice(&seg[..take]);
        }
        self.line_tail.extend_from_slice(seg);
        if self.line_tail.len() > self.cap {
            let cut = self.line_tail.len() - self.cap;
            self.line_tail.drain(..cut);
        }
        self.len += seg.len();
        self.total_chars += chars;
        false
    }

    /// Close the open line, trimming its windows to char boundaries when the
    /// line overflowed the carry cap (the cut edges may land mid-character).
    fn take_line(&mut self) -> WalkEvent<'_> {
        if self.len > self.cap {
            while self.line_head.last().is_some_and(|&b| (b & 0xc0) == 0x80) {
                self.line_head.pop();
            }
            let mut start = 0;
            while start < self.line_tail.len() && (self.line_tail[start] & 0xc0) == 0x80 {
                start += 1;
            }
            self.line_tail.drain(..start);
        }
        let len = self.len;
        self.len = 0;
        WalkEvent::Line(LineView {
            head: &self.line_head,
            tail: &self.line_tail,
            len,
        })
    }

    /// Read the next chunk; false on a read error or invalid UTF-8 (the
    /// materialized lossy path owns those streams).
    fn refill(&mut self) -> bool {
        let want = STREAM_CHUNK.min(self.unread);
        if want == 0 {
            self.eof = true;
            return true;
        }
        self.buf.clear();
        self.buf.resize(want, 0);
        let n = match self.file.read(&mut self.buf) {
            Ok(0) => {
                self.eof = true;
                return true;
            }
            Ok(n) => n,
            Err(_) => return false,
        };
        self.unread -= n;
        self.buf.truncate(n);
        if !utf8_chunks_valid(&mut self.seq, &self.buf) {
            return false;
        }
        self.pos = 0;
        true
    }
}

/// [`head_tail_windowed`] over a spilled stream: the same fused scan fed from
/// 64 KiB chunks, with the head/tail rings holding bounded byte windows
/// instead of borrows. A ring window is the whole line for anything
/// `take_head`/`take_tail` can keep, and a superset of the bytes their partial
/// cuts read for the line that busts the budget — so the windowed assembly is
/// exact. `None` on every band the bounded windows cannot prove: anomaly
/// bytes, invalid UTF-8, adjacent equal-length lines too large to compare
/// (unknown counts as a duplicate — the folds twin and then the materialized
/// path own it), and the small-corpus band.
fn head_tail_windowed_spill(
    path: &Path,
    file_len: usize,
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Option<Compressed<'static>> {
    // Budget arithmetic mirrored from `head_tail_lines` (requirement 2).
    let (head_share, tail_share): (usize, usize) = if success { (2, 1) } else { (1, 2) };
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * head_share / (head_share + tail_share);
    let tail_lines_budget = content_lines - head_lines_budget;
    let head_bytes_budget = max_bytes * head_share / (head_share + tail_share);
    let tail_bytes_budget = max_bytes - head_bytes_budget;

    let window = head_lines_budget + tail_lines_budget + 4;
    let cap = max_bytes + 64;
    let mut walker = SpillWalker::open(path, file_len, cap)?;

    let mut head: VecDeque<String> = VecDeque::with_capacity(head_lines_budget);
    let mut tail: VecDeque<String> = VecDeque::with_capacity(window);
    let mut total = 0usize;
    // Reused prev-line bytes for the adjacent-duplicate guard.
    let mut prev_len = 0usize;
    let mut prev_head: Vec<u8> = Vec::new();
    let mut has_prev = false;
    loop {
        match walker.next() {
            WalkEvent::Bail => return None,
            WalkEvent::Eof => break,
            WalkEvent::Line(line) => {
                // Adjacent duplicate guard: equal lengths either compare in
                // full (both fit the carry cap) or defer as unknown.
                let dup = has_prev
                    && prev_len == line.len
                    && (line.len > cap || prev_head == line.head);
                if dup {
                    return None; // fold candidate — the folds twin owns it.
                }
                total += 1;
                if head.len() < head_lines_budget {
                    let mut slot = String::new();
                    slot.push_str(window_str(line.head));
                    head.push_back(slot);
                }
                let mut slot = if tail.len() == window {
                    tail.pop_front().unwrap_or_default()
                } else {
                    String::new()
                };
                slot.clear();
                slot.push_str(window_str(line.tail));
                tail.push_back(slot);
                prev_len = line.len;
                prev_head.clear();
                prev_head.extend_from_slice(line.head);
                has_prev = true;
            }
        }
    }
    if total <= window {
        return None; // Small corpora: overlap/kept-everything branches live on
                     // the materialized path.
    }

    let head_lines: Vec<&str> = head.iter().map(String::as_str).collect();
    let tail_lines: Vec<&str> = tail.iter().map(String::as_str).collect();

    let head_slice = take_head(&head_lines, head_lines_budget, head_bytes_budget);
    // `from = tail_lines.len()`: walking the window from its end touches the
    // true last lines (total > window), with identical per-line byte math.
    let tail_slice = take_tail(
        &tail_lines,
        tail_lines.len(),
        tail_lines_budget,
        tail_bytes_budget,
    );

    let omitted_lines = total - head_slice.kept - tail_slice.kept;
    let omitted_chars = walker.total_chars.saturating_sub(
        head_slice.text.chars().count() + tail_slice.text.chars().count(),
    );
    let marker = omission_marker(omitted_chars, omitted_lines);
    let content = format!("{}\n\n{marker}\n\n{}", head_slice.text, tail_slice.text);
    Some(Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head_slice.partial || tail_slice.partial,
    })
}

/// [`head_tail_windowed_folds`] over a spilled stream: same fused run scan,
/// the [`FoldWindow`] rings fed owned lines. Only lines that fit the carry
/// cap can fold (markers embed the line, runs compare in full); anything
/// larger defers to the materialized path. The rebuild-fits band returns the
/// ORIGINAL body verbatim, represented by an empty `Strategy::None` content:
/// `compress_output_stream` flags it input-unchanged and the caller renders
/// from the accumulator's own display snapshot instead.
fn head_tail_windowed_folds_spill(
    path: &Path,
    file_len: usize,
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Option<Compressed<'static>> {
    // Budget arithmetic mirrored from `head_tail_lines` (requirement 2).
    let (head_share, tail_share): (usize, usize) = if success { (2, 1) } else { (1, 2) };
    let content_lines = max_lines.saturating_sub(3);
    let head_lines_budget = content_lines * head_share / (head_share + tail_share);
    let tail_lines_budget = content_lines - head_lines_budget;
    let head_bytes_budget = max_bytes * head_share / (head_share + tail_share);
    let tail_bytes_budget = max_bytes - head_bytes_budget;

    let cap = max_bytes + 64;
    let mut walker = SpillWalker::open(path, file_len, cap)?;
    let mut win = FoldWindow {
        total: 0,
        chars: 0,
        nbytes: 0,
        folds: 0,
        head: Vec::with_capacity(head_lines_budget + 1),
        head_bytes: 0,
        head_open: true,
        head_cap: head_lines_budget + 1,
        head_budget: head_bytes_budget,
        tail: VecDeque::with_capacity(tail_lines_budget + 1),
        tail_bytes: 0,
        tail_cap: tail_lines_budget + 1,
        tail_budget: tail_bytes_budget,
        last_empty: false,
    };

    let mut run_first: Option<String> = None;
    let mut run_len = 0usize;
    loop {
        match walker.next() {
            WalkEvent::Bail => return None,
            WalkEvent::Eof => break,
            WalkEvent::Line(line) => {
                // Whole-line semantics (run compare, actionable check, marker
                // embed) need the line in hand; beyond the cap, defer.
                let line_str = line.full()?;
                let in_run =
                    run_len > 0 && run_first.as_deref().is_some_and(|f| f == line_str);
                if in_run {
                    run_len += 1;
                } else {
                    if run_len > 0 {
                        win.flush_line(run_first.as_deref().unwrap_or(""), run_len);
                    }
                    let slot = run_first.get_or_insert_with(String::new);
                    slot.clear();
                    slot.push_str(line_str);
                    run_len = 1;
                }
            }
        }
    }
    if run_len > 0 {
        win.flush_line(run_first.as_deref().unwrap_or(""), run_len);
    }

    if win.folds == 0 {
        return None; // Dedup is a no-op here; the exact path below owns it.
    }
    // Trailing-phantom adjustment, exactly as the `&str` twin.
    let mut total = win.total;
    if win.last_empty {
        if total <= 1 {
            return None; // Degenerate rebuild; the exact path owns it.
        }
        total -= 1;
        if let Some(dropped) = win.tail.pop_back() {
            win.tail_bytes -= dropped.len() + 1;
        }
    }
    // Rebuild fits the budget: cleaning is not omission, so the ORIGINAL body
    // comes back verbatim (empty-content sentinel; see the doc comment).
    if total <= max_lines && win.nbytes + win.total - 1 <= max_bytes {
        return Some(Compressed {
            content: Cow::Owned(String::new()),
            strategy: Strategy::None,
            omitted_chars: 0,
            partial: false,
        });
    }
    if total <= head_lines_budget + tail_lines_budget {
        return None; // kept-everything / overlap bands stay materialized.
    }
    let head_lines: Vec<&str> = win.head.iter().map(|c| c.as_ref()).collect();
    let tail_lines: Vec<&str> = win.tail.iter().map(|c| c.as_ref()).collect();
    let head = take_head(&head_lines, head_lines_budget, head_bytes_budget);
    // `from = tail_lines.len()`: the ring holds the true last lines (total
    // exceeds both budgets), with identical per-line byte math.
    let tail = take_tail(
        &tail_lines,
        tail_lines.len(),
        tail_lines_budget,
        tail_bytes_budget,
    );
    // Overlap is unreachable — same proof as `head_tail_windowed`.
    let omitted_lines = total - head.kept - tail.kept;
    // Marker math over the REBUILT totals: every rebuilt line's chars plus
    // the total-1 '\n' separators the join would write.
    let rebuilt_chars = win.chars + win.total - 1;
    let omitted_chars = rebuilt_chars
        .saturating_sub(head.text.chars().count())
        .saturating_sub(tail.text.chars().count());
    let marker = omission_marker(omitted_chars, omitted_lines);
    let content = format!("{}\n\n{marker}\n\n{}", head.text, tail.text);
    Some(Compressed {
        content: Cow::Owned(content),
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head.partial || tail.partial,
    })
}

/// The Tier-1 pass over a [`FullStream`]: `Generic`-kind spilled streams above
/// `STREAM_MATERIALIZE_MAX` are
/// scanned through 64 KiB windows and never materialized (a 100 MB stream
/// costs O(budget), not O(stream), in peak RSS); everything else — Test/Build
/// kinds, in-memory buffers bounded by the spill threshold, and every band
/// the windowed twins decline — runs the exact materialized
/// [`compress_output`] over the very bytes `into_full_text` would produce.
///
/// Returns the result plus `input_unchanged`: true only when the content is
/// the input verbatim (no ANSI strip, no rebuild). A `Strategy::None` result
/// with `input_unchanged` carries NO content — the caller renders from the
/// accumulator's own display snapshot, pinned equal to the window snapshot
/// over that verbatim content.
pub fn compress_output_stream(
    stream: &FullStream,
    kind: CommandKind,
    success: bool,
    max_lines: usize,
    max_bytes: usize,
) -> (Compressed<'static>, bool) {
    let materialized = || {
        // Borrow the in-memory buffer: valid UTF-8 costs no copy, and the
        // verbatim sentinel below means a borrowed content never escapes —
        // every other strategy's content is a small owned string. Invalid
        // bytes degrade to the same lossy replacement `from_utf8_owned` used.
        let text = match stream {
            FullStream::Memory(raw) => String::from_utf8_lossy(raw),
            FullStream::Spill { path, .. } => Cow::Owned(read_spill_string(path)),
        };
        let c = compress_output(&text, kind, success, max_lines, max_bytes);
        if c.strategy == Strategy::None && c.content == text {
            // Verbatim pass: the caller renders from the accumulator's
            // display snapshot and never reads this content, so return the
            // empty sentinel (same shape as the windowed twins) instead of
            // `detach`'s full-stream copy — a declined giant line otherwise
            // peaked at 3x the stream (text + borrowed content + the copy).
            return (
                Compressed {
                    content: Cow::Owned(String::new()),
                    strategy: Strategy::None,
                    omitted_chars: 0,
                    partial: false,
                },
                true,
            );
        }
        (detach(c), false)
    };
    if let FullStream::Spill { path, len } = stream
        && !matches!(kind, CommandKind::Test | CommandKind::Build)
        && *len > STREAM_MATERIALIZE_MAX
    {
        if let Some(c) = head_tail_windowed_spill(path, *len, max_lines, max_bytes, success) {
            return (c, false);
        }
        if let Some(c) = head_tail_windowed_folds_spill(path, *len, max_lines, max_bytes, success) {
            let unchanged = c.strategy == Strategy::None;
            return (c, unchanged);
        }
    }
    materialized()
}

/// Lift a borrow of the materialization-local text into the `'static` result —
/// a move for owned content, the one copy for a verbatim borrow.
fn detach(c: Compressed<'_>) -> Compressed<'static> {
    Compressed {
        content: Cow::Owned(c.content.into_owned()),
        strategy: c.strategy,
        omitted_chars: c.omitted_chars,
        partial: c.partial,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test shim over `dedup_lines` with the collapse semantics pinned here:
    /// repeated-line runs fold to `line [... repeated N times ...]`, actionable
    /// lines never fold, fold-free output is byte-identical.
    fn dedup_repeats(s: &str) -> Cow<'_, str> {
        dedup_lines(s, &split_lines(s))
    }

    // --- Generic fast path: windowed head-tail ---------------------------------
    // Fixtures are oversized, ANSI-free, fold-free, marker-free bodies — the
    // exact shape the fast path exists for (e.g. `seq 50000`).

    fn clean_body(lines: usize, width: usize) -> String {
        (0..lines)
            .map(|i| format!("row-{i:0width$}\n", width = width))
            .collect()
    }

    fn crlf_body(lines: usize) -> String {
        (0..lines).map(|i| format!("r{i}\r\n")).collect()
    }

    fn materialized(body: &str, success: bool) -> Compressed<'_> {
        head_tail_lines(body, &split_lines(body), 40, 2048, success)
    }

    #[test]
    fn windowed_matches_materialized_on_clean_oversized_streams() {
        for success in [true, false] {
            for body in [
                clean_body(5000, 6),
                clean_body(120, 40),
                crlf_body(3000),
                (0..2000)
                    .map(|i| format!("é-€ line {i}\n"))
                    .collect::<String>(), // non-ASCII, dup-free
            ] {
                let expected = materialized(&body, success);
                let got = head_tail_windowed(&body, 40, 2048, success)
                    .expect("clean oversized body must take the fast path");
                assert_eq!(got.content, expected.content, "content mismatch");
                assert_eq!(got.strategy, expected.strategy);
                assert_eq!(got.omitted_chars, expected.omitted_chars);
                assert_eq!(got.partial, expected.partial);
            }
        }
    }

    #[test]
    fn windowed_declines_small_or_anomalous_bodies() {
        // Small corpora (total at or under the window size) and anomalies
        // (ESC, omission-tag prefix byte, adjacent duplicates) must fall back
        // to the exact materialized path.
        assert!(head_tail_windowed(&clean_body(41, 4), 40, 2048, true).is_none());
        assert!(head_tail_windowed(&"a".repeat(3000), 40, 2048, true).is_none());
        let esc = format!("{}\x1b[0m", clean_body(5000, 5));
        assert!(head_tail_windowed(&esc, 40, 2048, true).is_none());
        let dup = "same\n".repeat(5000);
        assert!(head_tail_windowed(&dup, 40, 2048, true).is_none());
        let marker = format!("x\n[... omitted 10 lines ...]\n{}", clean_body(5000, 5));
        assert!(head_tail_windowed(&marker, 40, 2048, true).is_none());
    }

    #[test]
    fn dedup_folds_at_the_first_line_without_a_leading_newline() {
        let body = "dup\ndup\ndup\nother";
        let out = dedup_repeats(body);
        assert_eq!(out, "dup [... repeated 3 times ...]\nother");
    }

    #[test]
    fn dedup_keeps_trailing_content_after_the_last_fold() {
        let body = "head\nrun\nrun\nrun\ntail-é\nmore";
        let out = dedup_repeats(body);
        assert_eq!(out, "head\nrun [... repeated 3 times ...]\ntail-é\nmore");
    }

    #[test]
    fn line_count_matches_split_lines_across_edge_shapes() {
        for body in [
            "", "\n", "a", "a\n", "a\nb", "a\nb\n", "a\n\nb\n", "\n\n", "é\né",
        ] {
            assert_eq!(
                line_count(body),
                split_lines(body).len(),
                "line_count diverged for {body:?}"
            );
        }
    }

    #[test]
    fn compress_output_fold_case_reaches_head_tail_through_the_owned_path() {
        // 100 × ~80 B repeated + distinct lines: folds fire, the cleaned text
        // is rebuilt, and head_tail re-splits it — the Cow::Owned branch.
        let body: String = (0..50)
            .map(|i| format!("step-{}\nstep-{}\nunique-{} pad{}\n", i % 5, i % 5, i, "x".repeat(70)))
            .collect();
        let a = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        let b = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(a.strategy, Strategy::HeadTail);
        assert_eq!(a.content, b.content, "deterministic across runs");
        assert!(js_byte_length(&a.content) <= 2048 + 256);
        assert!(split_lines(&a.content).len() <= 40 + 2);
        assert!(a.content.contains("[... repeated "));
    }

    #[test]
    fn compress_output_with_ansi_over_budget_owns_the_cleaned_text() {
        // ESC sequences force the strip's Owned path; the display must come out
        // ANSI-free and still carry the omission marker.
        let body: String = (0..120)
            .map(|i| format!("\u{1b}[31mline-{i:03} {}\u{1b}[0m\n", "y".repeat(40)))
            .collect();
        let out = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(out.strategy, Strategy::HeadTail);
        assert!(!out.content.contains('\u{1b}'), "ANSI must be stripped");
        assert!(out.content.contains("[..."));
        assert!(js_byte_length(&out.content) <= 2048 + 256);
    }

    #[test]
    fn compress_output_empty_and_tiny_inputs_stay_verbatim() {
        for body in ["", "one line\n"] {
            let out = compress_output(body, CommandKind::Generic, true, 40, 2048);
            assert_eq!(out.strategy, Strategy::None);
            assert_eq!(out.content, body);
        }
    }

    #[test]
    fn classify_test_commands() {
        assert_eq!(classify("cargo test"), CommandKind::Test);
        assert_eq!(classify("cargo test --all"), CommandKind::Test);
        assert_eq!(classify("npm test"), CommandKind::Test);
        assert_eq!(classify("pytest -q"), CommandKind::Test);
        assert_eq!(classify("go test ./..."), CommandKind::Test);
    }

    #[test]
    fn classify_build_commands() {
        assert_eq!(classify("cargo build --release"), CommandKind::Build);
        assert_eq!(classify("npm run build"), CommandKind::Build);
        assert_eq!(classify("tsc -p tsconfig.json"), CommandKind::Build);
    }

    #[test]
    fn classify_git_commands() {
        assert_eq!(classify("git diff HEAD"), CommandKind::Git);
        assert_eq!(classify("git log --oneline"), CommandKind::Git);
        assert_eq!(classify("git status"), CommandKind::Git);
    }

    #[test]
    fn classify_search_commands() {
        assert_eq!(classify("rg pattern src/"), CommandKind::Search);
        assert_eq!(classify("grep -rn foo ."), CommandKind::Search);
    }

    #[test]
    fn classify_log_commands() {
        assert_eq!(classify("docker logs my-container"), CommandKind::Log);
        assert_eq!(classify("kubectl logs pod/foo"), CommandKind::Log);
    }

    #[test]
    fn classify_generic_fallback() {
        assert_eq!(classify("ls -la"), CommandKind::Generic);
        assert_eq!(classify("echo hi"), CommandKind::Generic);
        assert_eq!(classify(""), CommandKind::Generic);
    }

    #[test]
    fn classify_first_recognized_segment_wins() {
        // The first recognized segment decides, in command order.
        assert_eq!(classify("rg foo && cargo test"), CommandKind::Search);
        assert_eq!(classify("cd src && npm run build"), CommandKind::Build);
        assert_eq!(classify("ls && echo x"), CommandKind::Generic);
    }

    #[test]
    fn head_tail_success_keeps_more_head() {
        let body = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let c = head_tail(&body, 12, 50 * 1024, true);
        assert_eq!(c.strategy, Strategy::HeadTail);
        // Success: head share is 2/3, so line0..line7 visible, last lines too.
        assert!(c.content.starts_with("line0"));
        assert!(c.content.contains("line99"));
        assert!(c.content.contains("omitted"));
        assert!(c.omitted_chars > 0);
    }

    #[test]
    fn head_tail_failure_keeps_more_tail() {
        let body = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let c = head_tail(&body, 12, 50 * 1024, false);
        assert_eq!(c.strategy, Strategy::HeadTail);
        assert!(c.content.contains("line99"));
        // Failure keeps fewer head lines than the success split.
        let success = head_tail(&body, 12, 50 * 1024, true);
        let head_count = |s: &str| {
            s.lines()
                .take_while(|l| l.starts_with("line") && l != &"line99")
                .count()
        };
        assert!(head_count(&c.content) < head_count(&success.content));
    }

    #[test]
    fn head_tail_under_budget_is_verbatim() {
        let body = "a\nb\nc";
        let c = head_tail(body, 2000, 50 * 1024, true);
        assert_eq!(c.strategy, Strategy::None);
        assert_eq!(c.content, body);
        assert_eq!(c.omitted_chars, 0);
    }

    #[test]
    fn head_tail_marker_counts_omitted_chars() {
        let body = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let c = head_tail(&body, 10, 50 * 1024, true);
        // The content is `head\n\n<marker>\n\ntail`. Reconstruct the kept text
        // (head and tail blocks) and assert omitted == original - kept.
        let parts: Vec<&str> = c.content.split("\n\n").collect();
        assert_eq!(parts.len(), 3, "head, marker, tail");
        let kept = parts[0].chars().count() + parts[2].chars().count();
        assert_eq!(c.omitted_chars, body.chars().count() - kept);
    }

    #[test]
    fn head_tail_preserves_utf8_boundaries_on_mid_line_cut() {
        // Every line is 3-byte chars; force the byte budget to bind.
        let line = "\u{8a9e}".repeat(100);
        let body = (0..50).map(|_| line.clone()).collect::<Vec<_>>().join("\n");
        let c = head_tail(&body, 2000, 64, true);
        assert!(!c.content.contains('\u{FFFD}'), "no replacement chars");
        assert!(c.content.is_char_boundary(0));
        assert!(c.content.is_char_boundary(c.content.len()));
    }

    #[test]
    fn head_tail_single_long_line_is_cut_head_and_tail() {
        let body = "x".repeat(10_000);
        let c = head_tail(&body, 2000, 200, true);
        assert_eq!(c.strategy, Strategy::HeadTail);
        assert!(c.partial);
        assert!(c.content.contains("omitted"));
        assert!(c.omitted_chars > 0);
    }

    #[test]
    fn omission_marker_detection_matches_the_wire_signal() {
        assert!(!has_omission_marker("plain output"));
        assert!(has_omission_marker("[... omitted 10 chars / 2 lines ...]"));
        let body = (0..200).map(|i| format!("line{i}\n")).collect::<String>();
        let c = compress_output(
            &body,
            CommandKind::Generic,
            true,
            COMPRESS_MAX_LINES,
            COMPRESS_MAX_BYTES,
        );
        assert!(has_omission_marker(&c.content));
    }

    #[test]
    fn compress_targets_the_model_visible_budget() {
        let body = (0..500)
            .map(|i| format!("noise line number {i} with some padding"))
            .collect::<Vec<_>>()
            .join("\n");
        let c = compress_output(
            &body,
            CommandKind::Generic,
            true,
            COMPRESS_MAX_LINES,
            COMPRESS_MAX_BYTES,
        );
        assert_eq!(c.strategy, Strategy::HeadTail);
        assert!(
            split_lines(&c.content).len() <= COMPRESS_MAX_LINES + 2,
            "lines={} bytes={}",
            split_lines(&c.content).len(),
            js_byte_length(&c.content)
        );
        assert!(js_byte_length(&c.content) <= COMPRESS_MAX_BYTES + 256);
    }

    #[test]
    fn head_tail_is_deterministic_and_idempotent() {
        let body = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let a = head_tail(&body, 10, 50 * 1024, true);
        let b = head_tail(&body, 10, 50 * 1024, true);
        assert_eq!(a.content, b.content);
        // Re-compressing the already-compressed body changes nothing further
        // once it fits.
        let again = head_tail(&a.content, 10, 50 * 1024, true);
        assert_eq!(again.content, a.content);
    }

    // ---- error_priority (requirement 4) ----

    #[test]
    fn error_priority_keeps_actionable_lines_verbatim() {
        let mut body = String::new();
        body.push_str("Compiling foo v0.1.0\n");
        for i in 0..200 {
            body.push_str(&format!("   Compiling dep{i} v0.1.0\n"));
        }
        body.push_str("error[E0308]: mismatched types\n");
        body.push_str("  --> src/main.rs:42:5\n");
        body.push_str("   | panic at src/lib.rs:10\n");
        body.push_str("warning: unused variable `x`\n");
        body.push_str("test result: FAILED. 3 passed; 1 failed\n");
        let c = error_priority(&body, 2000, 512);
        assert_eq!(c.strategy, Strategy::ErrorPriority);
        assert!(c.content.contains("error[E0308]: mismatched types"));
        assert!(c.content.contains("--> src/main.rs:42:5"));
        assert!(c.content.contains("panic"));
        assert!(c.content.contains("warning: unused variable"));
        assert!(c.content.contains("test result: FAILED. 3 passed; 1 failed"));
        assert!(c.content.contains("omitted") || c.content.contains("elided"));
    }

    #[test]
    fn error_priority_collapses_repeated_progress_lines() {
        let mut body = String::new();
        for i in 0..200 {
            body.push_str("Downloading crate ... 10%\n");
            if i % 10 == 0 {
                body.push_str(&format!("Downloading crate ... {i}%\n"));
            }
        }
        body.push_str("error: build failed\n");
        let c = error_priority(&body, 2000, 512);
        assert_eq!(c.strategy, Strategy::ErrorPriority);
        assert!(c.omitted_chars > 0);
        assert!(c.content.contains("error: build failed"));
        // The progress flood is collapsed: visible text is far shorter.
        assert!(c.content.chars().count() < body.chars().count() / 2);
    }

    #[test]
    fn error_priority_under_budget_is_verbatim() {
        let body = "ok\nnothing wrong";
        let c = error_priority(body, 2000, 4096);
        assert_eq!(c.strategy, Strategy::None);
        assert_eq!(c.content, body);
    }

    #[test]
    fn error_priority_is_deterministic_and_idempotent() {
        let body = (0..100)
            .map(|i| format!("step {i}\n"))
            .collect::<String>()
            + "error: boom\n";
        let a = error_priority(&body, 2000, 128);
        let b = error_priority(&body, 2000, 128);
        assert_eq!(a.content, b.content);
        let again = error_priority(&a.content, 2000, 128);
        assert_eq!(again.content, a.content);
    }

    #[test]
    fn error_priority_preserves_utf8_boundaries() {
        let body = (0..200)
            .map(|_| "\u{8a9e}\u{8a9e}\u{8a9e}\u{8a9e}".to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\nerror: \u{8a9e}\u{8a9e}";
        let c = error_priority(&body, 2000, 64);
        assert!(!c.content.contains('\u{FFFD}'));
        assert!(c.content.is_char_boundary(0));
        assert!(c.content.is_char_boundary(c.content.len()));
    }

    #[test]
    fn error_priority_keeps_middle_error_under_both_caps() {
        // 5000 noise + error + 5000 noise: the error sits in the middle and
        // must survive BOTH the 2000-line and 50KB caps.
        let mut body = String::new();
        for i in 0..5000 {
            body.push_str(&format!("   Compiling dep{i}\n"));
        }
        body.push_str("error[E0308]: mismatched types\n");
        body.push_str("  --> src/main.rs:42:5\n");
        body.push_str("test result: FAILED. 3 passed; 1 failed\n");
        for i in 0..5000 {
            body.push_str(&format!("   trailing noise {i}\n"));
        }
        let c = compress_output(&body, CommandKind::Test, false, 2000, 50 * 1024);
        assert_eq!(c.strategy, Strategy::ErrorPriority);
        assert!(c.content.contains("error[E0308]: mismatched types"));
        assert!(c.content.contains("--> src/main.rs:42:5"));
        assert!(c.content.contains("test result: FAILED. 3 passed; 1 failed"));
        // Result fits both caps, so a second (parity) pass would not re-cut it.
        assert!(
            split_lines(&c.content).len() <= 2000,
            "line count {}",
            split_lines(&c.content).len()
        );
        assert!(js_byte_length(&c.content) <= 50 * 1024);
    }

    // ---- strip_ansi (ported from output-scrub.ts) ----

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("\u{1b}[1;32mok\u{1b}[0m done"), "ok done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn strip_ansi_removes_osc_and_carriage_returns() {
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{7}b"), "ab");
        assert_eq!(strip_ansi("line\rprogress"), "lineprogress");
        assert_eq!(strip_ansi("a\r\nb"), "a\nb");
    }

    #[test]
    fn strip_ansi_is_identity_without_codes() {
        let s = "no codes here\nsecond line";
        assert_eq!(strip_ansi(s), s);
    }

    // ---- dedup_repeats (log deduplication, doc Tier 1) ----

    #[test]
    fn dedup_collapses_repeated_lines_with_count() {
        let body = (0..50)
            .map(|_| "health check ok")
            .collect::<Vec<_>>()
            .join("\n");
        let out = dedup_repeats(&body);
        assert!(out.contains("health check ok"));
        assert!(out.contains("50"));
        assert!(out.lines().count() < 5);
    }

    #[test]
    fn dedup_keeps_distinct_lines() {
        let body = "alpha\nbeta\ngamma";
        assert_eq!(dedup_repeats(body), body);
    }

    #[test]
    fn dedup_preserves_actionable_lines_verbatim() {
        // Even repeated errors are never folded away.
        let body = "error: boom\nerror: boom\nerror: boom";
        let out = dedup_repeats(body);
        assert_eq!(out.matches("error: boom").count(), 3);
    }

    #[test]
    fn dedup_is_deterministic_and_idempotent() {
        let body = (0..30)
            .map(|_| "tick")
            .collect::<Vec<_>>()
            .join("\n");
        let a = dedup_repeats(&body);
        assert_eq!(a, dedup_repeats(&body));
        assert_eq!(dedup_repeats(&a), a);
    }

    // ---- token_estimate ----

    #[test]
    fn token_estimate_is_chars_over_four() {
        assert_eq!(token_estimate(""), 0);
        assert_eq!(token_estimate("abcd"), 1);
        assert_eq!(token_estimate("abcde"), 1);
        assert_eq!(token_estimate(&"x".repeat(400)), 100);
    }

    // ---- compress_output: the single entry point main.rs calls ----

    #[test]
    fn compress_output_small_is_verbatim_none() {
        let c = compress_output("hello\nworld", CommandKind::Generic, true, 2000, 50 * 1024);
        assert_eq!(c.strategy, Strategy::None);
        assert_eq!(c.omitted_chars, 0);
    }

    #[test]
    fn compress_output_test_kind_uses_error_priority_when_oversized() {
        let mut body = String::new();
        for i in 0..300 {
            body.push_str(&format!("   Compiling dep{i}\n"));
        }
        body.push_str("error[E0308]: mismatched types\n  --> src/main.rs:1:1\n");
        body.push_str("test result: FAILED. 1 failed\n");
        let c = compress_output(&body, CommandKind::Test, false, 2000, 512);
        assert_eq!(c.strategy, Strategy::ErrorPriority);
        assert!(c.content.contains("error[E0308]"));
        assert!(c.content.contains("--> src/main.rs:1:1"));
        assert!(c.content.contains("test result: FAILED"));
    }

    #[test]
    fn compress_output_generic_uses_head_tail() {
        let body = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let c = compress_output(&body, CommandKind::Generic, true, 10, 50 * 1024);
        assert_eq!(c.strategy, Strategy::HeadTail);
        assert!(c.content.contains("omitted"));
    }

    #[test]
    fn compress_output_strips_ansi_when_over_budget() {
        // Over budget: ANSI is stripped as part of Tier-1.
        let body = "\u{1b}[32mok\u{1b}[0m\n".repeat(300);
        let c = compress_output(&body, CommandKind::Generic, true, 20, 256);
        assert!(!c.content.contains('\u{1b}'), "escape codes removed");
    }

    #[test]
    fn compress_output_within_budget_is_byte_identical() {
        // Small output (ANSI included) passes through untouched so pibash stays
        // a byte-identical display oracle for the built-in.
        let body = "\u{1b}[32mok\u{1b}[0m";
        let c = compress_output(body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(c.strategy, Strategy::None);
        assert_eq!(c.content, body);
    }

    #[test]
    fn compress_output_is_deterministic() {
        let body = (0..200)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let a = compress_output(&body, CommandKind::Git, true, 20, 2048);
        let b = compress_output(&body, CommandKind::Git, true, 20, 2048);
        assert_eq!(a.content, b.content);
    }

    // ---- is_actionable: tightened runtime-trace matchers ----

    #[test]
    fn actionable_keeps_rust_traces() {
        assert!(is_actionable("thread 'main' panicked at src/main.rs:10:5"));
        assert!(is_actionable("panicked at 'boom', src/lib.rs:3"));
        assert!(is_actionable("  --> src/main.rs:42:5"));
        assert!(is_actionable("error[E0308]: mismatched types"));
        assert!(is_actionable("note: run with `RUST_BACKTRACE=1`"));
    }

    #[test]
    fn actionable_keeps_python_traces() {
        assert!(is_actionable("Traceback (most recent call last):"));
        assert!(is_actionable("  File \"/app/main.py\", line 12, in <module>"));
        assert!(is_actionable("AssertionError: expected 1 == 2"));
    }

    #[test]
    fn actionable_keeps_js_stack_frames() {
        assert!(is_actionable("    at Object.<anonymous> (/app/index.js:5:1)"));
        assert!(is_actionable("    at foo (node:internal/modules/run_main:1:1)"));
        assert!(is_actionable("    at /app/node_modules/foo/index.js:10:1"));
        assert!(is_actionable("TypeError: undefined is not a function"));
    }

    #[test]
    fn actionable_keeps_native_crashes_and_compiler_blocks() {
        assert!(is_actionable("Segmentation fault (core dumped)"));
        assert!(is_actionable("core dumped"));
        assert!(is_actionable("src/main.c:42:5: error: expected ';' before '}'"));
    }

    #[test]
    fn actionable_rejects_generic_prose_with_at() {
        // The old broad "at " marker must no longer keep prose.
        assert!(!is_actionable("Take a look at the documentation for details"));
        assert!(!is_actionable("   Compiling dep42 v0.1.0"));
        assert!(!is_actionable("Downloading crate foo"));
        assert!(!is_actionable("this line mentions catastrophe"));
    }

    #[test]
    fn actionable_still_keeps_error_and_failure_markers() {
        assert!(is_actionable("error: build failed"));
        assert!(is_actionable("warning: unused variable"));
        assert!(is_actionable("test result: FAILED. 1 failed"));
        assert!(is_actionable("FAIL src/foo.test.ts"));
    }

    // ---- micro-benchmark (run: cargo test compress_bench -- --ignored --nocapture) ----

    /// Build a realistic 100k-line stream: 90% verbose noise, 10% actionable
    /// traces (Rust panic / JS frame / C fault) scattered through the middle
    /// and tail.
    fn bench_stream(lines: usize) -> String {
        let mut out = String::with_capacity(lines * 32);
        for i in 0..lines {
            // Every 10th line is actionable, placed outside the first 5%.
            if i > lines / 20 && i % 10 == 7 {
                match i % 30 {
                    7 => out.push_str("thread 'main' panicked at src/main.rs:10:5\n"),
                    17 => out.push_str("    at Object.<anonymous> (/app/index.js:5:1)\n"),
                    27 => out.push_str("segmentation fault (core dumped)\n"),
                    _ => out.push_str("error[E0308]: mismatched types\n"),
                }
            } else if i % 5 == 0 {
                out.push_str(&format!("   Compiling dep{i} v0.1.0\n"));
            } else if i % 5 == 1 {
                out.push_str("warning: unused variable `x` at line 12\n");
            } else if i % 5 == 2 {
                out.push_str("look at the documentation for details about this step\n");
            } else {
                out.push_str(&format!("   downloaded {i} bytes at 1.2MB/s\n"));
            }
        }
        out
    }

    #[test]
    #[ignore = "micro-benchmark; run with --ignored --nocapture"]
    fn compress_bench_100k_lines() {
        // Target note: a strict 5 ms budget for 100k lines (~50 ns/line) is not
        // reachable with per-line substring matchers in safe Rust — the keyword
        // scan alone is ~15 `str::contains` calls per line. This benchmark
        // measures the real cost and guards against regressions with a budget
        // an order of magnitude above the measured floor. The stream is 3.8 MB;
        // production output reaching compression is capped near 50 KB by the
        // accumulator's tail, so real inputs are far smaller than this stress.
        const BUDGET_MS: f64 = 150.0;
        const LINES: usize = 100_000;
        let stream = bench_stream(LINES);
        let total_lines = stream.lines().count();
        let bytes = js_byte_length(&stream);

        // Warm up (page in, prime branch predictors).
        let _ = compress_output(&stream, CommandKind::Test, false, 2000, 50 * 1024);

        // Stage breakdown — identifies the dominant cost.
        {
            let t = std::time::Instant::now();
            let cleaned = strip_ansi(&stream);
            let strip_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = std::time::Instant::now();
            let deduped = dedup_repeats(&cleaned);
            let dedup_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = std::time::Instant::now();
            let ep = error_priority(&deduped, 2000, 50 * 1024);
            let ep_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = std::time::Instant::now();
            let _ = head_tail(&cleaned, 2000, 50 * 1024, false);
            let ht_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = std::time::Instant::now();
            let mut hits = 0usize;
            for l in deduped.lines() {
                if is_actionable(l) {
                    hits += 1;
                }
            }
            let ia_ms = t.elapsed().as_secs_f64() * 1000.0;
            std::hint::black_box((&deduped, &ep));
            println!("\n--- stage breakdown ---");
            println!("strip_ansi:     {strip_ms:.3} ms");
            println!("dedup_repeats:  {dedup_ms:.3} ms");
            println!("error_priority: {ep_ms:.3} ms");
            println!("head_tail:      {ht_ms:.3} ms");
            println!("is_actionable:  {ia_ms:.3} ms ({hits} hits)");
        }

        const RUNS: usize = 5;
        let mut best = f64::MAX;
        let mut sum = 0.0f64;
        for _ in 0..RUNS {
            let start = std::time::Instant::now();
            let c = compress_output(&stream, CommandKind::Test, false, 2000, 50 * 1024);
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            std::hint::black_box(&c);
            best = best.min(elapsed);
            sum += elapsed;
        }
        let avg = sum / RUNS as f64;
        let per_line_us = avg * 1000.0 / total_lines as f64;

        println!("\n=== pibash compress micro-benchmark ===");
        println!("input:        {total_lines} lines, {bytes} bytes");
        println!("best:         {best:.3} ms");
        println!("average:      {avg:.3} ms over {RUNS} runs");
        println!("per line:     {per_line_us:.3} us");
        println!("throughput:   {:.1} MB/s", (bytes as f64 / 1e6) / (avg / 1000.0));
        println!("budget:       {BUDGET_MS:.3} ms");
        println!("verdict:      {}", if avg < BUDGET_MS { "PASS" } else { "FAIL" });

        assert!(
            avg < BUDGET_MS,
            "compression of {total_lines} lines took {avg:.3} ms (budget {BUDGET_MS} ms)"
        );
    }

    // ---- Characterization: the Generic fold path of compress_output ------
    // Byte-exact literals frozen from the current implementation so an
    // optimization of the fold path can be diffed against today's behavior.

    /// u*100 + dup*30 + v*100 lines: the 30-run of "dup" folds, and the
    /// rebuilt body is still over budget, so head-tail windows the REBUILD.
    fn u_dup_v_corpus() -> String {
        let mut s = String::new();
        for i in 0..100 {
            s.push_str(&format!("u{i:03}\n"));
        }
        for _ in 0..30 {
            s.push_str("dup\n");
        }
        for i in 0..100 {
            s.push_str(&format!("v{i:03}\n"));
        }
        s
    }

    #[test]
    fn pure_fold_body_is_verbatim_none_despite_the_rebuild() {
        // 5000 identical lines fold to one rebuilt line that fits the budget,
        // but the Strategy::None branch discards the rebuild and returns the
        // ORIGINAL cleaned body: cleaning is not omission.
        let body = "y\n".repeat(5000);
        let out = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(out.strategy, Strategy::None);
        assert_eq!(out.content, body.as_str(), "the rebuild must be discarded");
        assert_eq!(out.omitted_chars, 0);
    }

    #[test]
    fn fold_body_over_budget_composes_dedup_then_head_tail() {
        let body = u_dup_v_corpus();
        let out = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(out.strategy, Strategy::HeadTail);
        assert_eq!(out.omitted_chars, 848);
        // Frozen: 24 head lines, blank, marker counting REBUILT chars/lines,
        // blank, 13 tail lines. The rebuild never emits a trailing newline,
        // hence 848 (not 849) omitted chars.
        assert_eq!(
            out.content,
            "u000\nu001\nu002\nu003\nu004\nu005\nu006\nu007\nu008\nu009\nu010\nu011\nu012\nu013\nu014\nu015\nu016\nu017\nu018\nu019\nu020\nu021\nu022\nu023\n\n[... omitted 848 chars / 164 lines ...]\n\nv087\nv088\nv089\nv090\nv091\nv092\nv093\nv094\nv095\nv096\nv097\nv098\nv099"
        );
        // Decomposition: head 24 rebuilt lines + marker line + tail 13
        // rebuilt lines, and the fold marker is exactly one rebuilt line.
        let parts: Vec<&str> = out.content.split("\n\n").collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(split_lines(parts[0]).len(), 24);
        assert_eq!(parts[1], "[... omitted 848 chars / 164 lines ...]");
        assert_eq!(split_lines(parts[2]).len(), 13);
        let rebuilt = dedup_repeats(&body);
        assert_eq!(split_lines(&rebuilt).len(), 201);
        assert_eq!(
            split_lines(&rebuilt)
                .iter()
                .filter(|l| **l == "dup [... repeated 30 times ...]")
                .count(),
            1
        );
    }

    #[test]
    fn fold_predicate_edges() {
        // Any run > 1 of identical non-actionable non-blank lines folds; the
        // emit joins with '\n' and never writes a trailing newline.
        assert_eq!(dedup_repeats("x\nx\ny\n"), "x [... repeated 2 times ...]\ny");
        // Repeated blank lines never fold: byte-identical passthrough.
        assert_eq!(dedup_repeats("\n\n\n\nz\n"), "\n\n\n\nz\n");
        // Repeated actionable lines never fold.
        assert_eq!(
            dedup_repeats(&"error: boom\n".repeat(4)),
            "error: boom\nerror: boom\nerror: boom\nerror: boom\n"
        );
        // Multibyte line content folds with a byte-exact marker.
        assert_eq!(
            dedup_repeats(&"naïve\n".repeat(5)),
            "naïve [... repeated 5 times ...]"
        );

        // Same corpus without the trailing newline: the rebuild never emits
        // one, so the compressed bytes are identical to the newline case.
        let mut body = u_dup_v_corpus();
        body.pop();
        let out = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(out.strategy, Strategy::HeadTail);
        assert_eq!(out.omitted_chars, 848);
        assert_eq!(
            out.content,
            "u000\nu001\nu002\nu003\nu004\nu005\nu006\nu007\nu008\nu009\nu010\nu011\nu012\nu013\nu014\nu015\nu016\nu017\nu018\nu019\nu020\nu021\nu022\nu023\n\n[... omitted 848 chars / 164 lines ...]\n\nv087\nv088\nv089\nv090\nv091\nv092\nv093\nv094\nv095\nv096\nv097\nv098\nv099"
        );

        // success=false flips the split tail-heavy: 12 head / 25 tail lines.
        let body = u_dup_v_corpus();
        let out = compress_output(&body, CommandKind::Generic, false, 40, 2048);
        assert_eq!(out.strategy, Strategy::HeadTail);
        assert_eq!(out.omitted_chars, 848);
        assert_eq!(
            out.content,
            "u000\nu001\nu002\nu003\nu004\nu005\nu006\nu007\nu008\nu009\nu010\nu011\n\n[... omitted 848 chars / 164 lines ...]\n\nv075\nv076\nv077\nv078\nv079\nv080\nv081\nv082\nv083\nv084\nv085\nv086\nv087\nv088\nv089\nv090\nv091\nv092\nv093\nv094\nv095\nv096\nv097\nv098\nv099"
        );
    }

    #[test]
    fn marker_carrying_body_is_never_recompacted() {
        // Over-budget body already carrying a Tier-1 marker: the windowed fast
        // path declines on the '[' byte, head_tail_lines declines on the
        // idempotence tag, and the Strategy::None branch echoes the original
        // bytes back with no omission and no re-count.
        let mut body = String::new();
        for i in 0..100 {
            body.push_str(&format!("a{i:03}\n"));
        }
        body.push_str("[... omitted 5 chars ...]\n");
        for i in 0..100 {
            body.push_str(&format!("b{i:03}\n"));
        }
        let out = compress_output(&body, CommandKind::Generic, true, 40, 2048);
        assert_eq!(out.strategy, Strategy::None);
        assert_eq!(out.content, body.as_str());
        assert_eq!(out.omitted_chars, 0);
    }
}
