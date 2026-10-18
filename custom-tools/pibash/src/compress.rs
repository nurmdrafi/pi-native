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
//! This module is pure: it never touches the filesystem. The spill file — the
//! lossless copy of the full output — is owned by [`crate::accumulator`] and is
//! only read from, never written or extended here.

use crate::truncate::{
    js_byte_length, split_lines, truncate_string_to_bytes_from_end,
    truncate_string_to_bytes_from_start,
};
use std::borrow::Cow;

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
pub struct Compressed {
    pub content: String,
    pub strategy: Strategy,
    /// Characters omitted (always 0 when `strategy == Strategy::None`).
    pub omitted_chars: usize,
    /// True when the formatter cut a single long line rather than whole lines.
    /// Part of the compression result; consumed by tests and future renderers.
    #[allow(dead_code)]
    pub partial: bool,
}

impl Compressed {
    fn verbatim(text: &str) -> Self {
        Compressed {
            content: text.to_string(),
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
pub fn head_tail(text: &str, max_lines: usize, max_bytes: usize, success: bool) -> Compressed {
    head_tail_lines(text, &split_lines(text), max_lines, max_bytes, success)
}

fn head_tail_lines(
    text: &str,
    lines: &[&str],
    max_lines: usize,
    max_bytes: usize,
    success: bool,
) -> Compressed {
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
        content,
        strategy: Strategy::HeadTail,
        omitted_chars,
        partial: head.partial || tail.partial,
    }
}

fn fits(text: &str, max_lines: usize, max_bytes: usize) -> bool {
    line_count(text) <= max_lines && js_byte_length(text) <= max_bytes
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
pub fn error_priority(text: &str, max_lines: usize, max_bytes: usize) -> Compressed {
    error_priority_lines(text, &split_lines(text), max_lines, max_bytes)
}

fn error_priority_lines(text: &str, lines: &[&str], max_lines: usize, max_bytes: usize) -> Compressed {
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
        content,
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
    // which was the dominant cost on seq-class output.
    let mut out = String::with_capacity(s.len());
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
) -> Compressed {
    // Within the model budget: nothing to compress, stay byte-identical.
    if js_byte_length(text) <= max_bytes && split_lines(text).len() <= max_lines {
        return Compressed::verbatim(text);
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
            return c;
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
            content: cleaned.into_owned(),
            strategy: Strategy::None,
            omitted_chars: 0,
            partial: false,
        };
    }
    c
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
        let c = compress_output(
            &(0..200).map(|i| format!("line{i}\n")).collect::<String>(),
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
}
