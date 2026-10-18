//! Bounded streaming output accumulator — port of `OutputAccumulator`.
//!
//! Keeps only a decoded tail in memory (`maxBytes * 2` rolling window, as the
//! oracle does), spills the full raw stream to a temp file the moment the
//! output can no longer fit, and produces the display snapshot + truncation.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::truncate::{js_byte_length, truncate_string_to_bytes_from_start, truncate_tail, Truncation};

/// Streaming UTF-8 decoder — the port of `TextDecoder` with `{stream: true}`.
///
/// A multi-byte character can straddle two `read()` chunks, because a pipe
/// delivers whatever bytes are ready. The oracle's streaming decoder buffers the
/// incomplete trailing sequence until the next chunk, so the character decodes
/// once; a per-chunk `from_utf8_lossy` instead emitted a replacement character
/// per half of the character and corrupted the output. That was the largest
/// parity gap in the accumulator.
#[derive(Default)]
struct Utf8Stream {
    pending: [u8; 4],
    pending_len: usize,
}

impl Utf8Stream {
    fn is_clean(&self) -> bool {
        self.pending_len == 0
    }

    /// Append decoded text for `data`, buffering an incomplete trailing
    /// sequence (if any) for the next chunk.
    fn decode_into(&mut self, data: &[u8], out: &mut String) {
        if self.pending_len == 0 {
            self.decode_slice(data, out);
            return;
        }
        // A UTF-8 character is at most 4 bytes, so at most three leading bytes
        // of `data` are needed to complete the pending sequence.
        let needed = 4 - self.pending_len;
        let take = data.len().min(needed);
        let head_len = self.pending_len + take;
        let mut head = [0u8; 4];
        head[..self.pending_len].copy_from_slice(&self.pending[..self.pending_len]);
        head[self.pending_len..head_len].copy_from_slice(&data[..take]);
        self.pending_len = 0;
        self.decode_slice(&head[..head_len], out);
        self.decode_slice(&data[take..], out);
    }

    fn decode_slice(&mut self, bytes: &[u8], out: &mut String) {
        let mut rest = bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return;
                }
                Err(err) => {
                    // Everything before `valid_up_to` is known-good UTF-8.
                    out.push_str(std::str::from_utf8(&rest[..err.valid_up_to()]).unwrap_or(""));
                    match err.error_len() {
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[err.valid_up_to() + len..];
                        }
                        None => {
                            let leftover = &rest[err.valid_up_to()..];
                            debug_assert!(leftover.len() <= self.pending.len());
                            self.pending[..leftover.len()].copy_from_slice(leftover);
                            self.pending_len = leftover.len();
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Flush an unfinished sequence as a single replacement character, matching
    /// `TextDecoder.decode()` at end of stream.
    fn finish_into(&mut self, out: &mut String) {
        if self.pending_len > 0 {
            out.push(char::REPLACEMENT_CHARACTER);
            self.pending_len = 0;
        }
    }
}

/// Built-in defaults (`dist/core/tools/truncate.js`).
pub const DEFAULT_MAX_LINES: usize = 2000;
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;

/// Snapshot handed to the renderer: display text + truncation + spill path.
pub struct Snapshot {
    pub content: String,
    pub truncation: Truncation,
    pub full_output_path: Option<PathBuf>,
}

/// Incremental accumulator over raw stdout/stderr chunks.
pub struct OutputAccumulator {
    max_lines: usize,
    max_bytes: usize,
    max_rolling_bytes: usize,
    temp_file_prefix: String,
    tail: String,
    tail_starts_at_line_boundary: bool,
    total_raw_bytes: usize,
    total_decoded_bytes: usize,
    completed_lines: usize,
    total_lines: usize,
    current_line_bytes: usize,
    has_open_line: bool,
    finished: bool,
    decoder: Utf8Stream,
    temp_file_path: Option<PathBuf>,
    temp_writer: Option<BufWriter<File>>,
    /// Raw bytes kept only while a spill file may still be needed. Held as one
    /// contiguous buffer: the previous `Vec<Vec<u8>>` shape made
    /// `read_full_output` concatenate every chunk into a second full copy.
    raw: Vec<u8>,
    /// Byte offset in `tail` where each of the last complete lines starts —
    /// the line half of the streaming compaction window. Bounded to
    /// `max_lines + 1` entries so snapshots never re-split the whole tail.
    tail_line_starts: VecDeque<usize>,
}

impl OutputAccumulator {
    #[must_use]
    pub fn new(temp_file_prefix: &str) -> Self {
        let max_lines = DEFAULT_MAX_LINES;
        let max_bytes = DEFAULT_MAX_BYTES;
        Self {
            max_lines,
            max_bytes,
            max_rolling_bytes: (max_bytes * 2).max(1),
            temp_file_prefix: temp_file_prefix.to_string(),
            tail: String::new(),
            tail_starts_at_line_boundary: true,
            total_raw_bytes: 0,
            total_decoded_bytes: 0,
            completed_lines: 0,
            total_lines: 0,
            current_line_bytes: 0,
            has_open_line: false,
            finished: false,
            decoder: Utf8Stream::default(),
            temp_file_path: None,
            temp_writer: None,
            raw: Vec::new(),
            tail_line_starts: VecDeque::new(),
        }
    }

    /// Feed one raw chunk. UTF-8 is decoded with a streaming decoder, so a
    /// character split across two chunks decodes once instead of producing a
    /// replacement character per half (oracle parity).
    pub fn append(&mut self, data: &[u8]) {
        self.total_raw_bytes += data.len();
        // Fast path: nothing pending and the chunk is valid UTF-8 (the common
        // case), so decode in place with no temporary allocation.
        if self.decoder.is_clean()
            && let Ok(text) = std::str::from_utf8(data)
        {
            self.append_decoded_text(text);
        } else {
            let mut decoded = String::with_capacity(data.len() + 4);
            self.decoder.decode_into(data, &mut decoded);
            self.append_decoded_text(&decoded);
        }

        if self.temp_writer.is_some() || self.should_use_temp_file() {
            self.ensure_temp_file();
            if let Some(writer) = self.temp_writer.as_mut() {
                let _ = writer.write_all(data);
            }
        } else if !data.is_empty() {
            self.raw.extend_from_slice(data);
        }
    }

    /// Flush and close the spill writer.
    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        // Flush any half-decoded character at end of stream, as the oracle's
        // streaming decoder does in `finish()`.
        let mut flushed = String::new();
        self.decoder.finish_into(&mut flushed);
        if !flushed.is_empty() {
            self.append_decoded_text(&flushed);
        }
        if self.should_use_temp_file() {
            self.ensure_temp_file();
        }
        if let Some(mut writer) = self.temp_writer.take() {
            let _ = writer.flush();
        }
    }

    /// Display snapshot: truncated tail, truncation metadata, spill path.
    pub fn snapshot(&mut self, persist_if_truncated: bool) -> Snapshot {
        let text = self.snapshot_text();
        let mut truncation = truncate_tail(&text, self.max_lines, self.max_bytes);
        let truncated =
            self.total_lines > self.max_lines || self.total_decoded_bytes > self.max_bytes;
        truncation.truncated = truncated;
        truncation.truncated_by = if truncated {
            truncation.truncated_by.or(Some(if self.total_decoded_bytes > self.max_bytes {
                "bytes"
            } else {
                "lines"
            }))
        } else {
            None
        };
        truncation.total_lines = self.total_lines;
        truncation.total_bytes = self.total_decoded_bytes;
        truncation.max_lines = self.max_lines;
        truncation.max_bytes = self.max_bytes;

        if persist_if_truncated && truncation.truncated {
            self.ensure_temp_file();
        }

        Snapshot {
            content: truncation.content.clone(),
            truncation,
            full_output_path: self.temp_file_path.clone(),
        }
    }

    /// Bytes on the currently open (last, newline-free) line — the oracle's
    /// `getLastLineBytes()`, used by the partial-last-line note.
    #[must_use]
    pub fn last_line_bytes(&self) -> usize {
        self.current_line_bytes
    }

    /// The path of the spill file holding the full stream, if one exists. Does
    /// not create a spill (unlike `snapshot(true)`).
    #[must_use]
    pub fn temp_output_path(&self) -> Option<PathBuf> {
        self.temp_file_path.clone()
    }

    /// Consume the accumulator into the complete, uncapped output — the one
    /// materialization both the Tier-1 compression pre-pass and the capped
    /// structured output (`cap_full_output`) are derived from. The spill file
    /// is read exactly once; the in-memory raw buffer is moved (zero-copy on
    /// the common valid-UTF-8 case).
    #[must_use]
    pub fn into_full_text(mut self) -> String {
        if let Some(path) = self.temp_file_path.take() {
            return match std::fs::read(path) {
                Ok(bytes) => from_utf8_owned(bytes),
                Err(_) => String::new(),
            };
        }
        from_utf8_owned(std::mem::take(&mut self.raw))
    }

    fn append_decoded_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let bytes = js_byte_length(text);
        self.total_decoded_bytes += bytes;
        let tail_base = self.tail.len();
        self.tail.push_str(text);
        for (idx, _) in text.match_indices('\n') {
            self.tail_line_starts.push_back(tail_base + idx + 1);
        }
        if js_byte_length(&self.tail) > self.max_rolling_bytes * 2
            || self.tail_line_starts.len() > self.max_lines + 2
        {
            self.trim_tail();
        }

        let newlines = text.matches('\n').count();
        if newlines == 0 {
            self.current_line_bytes += bytes;
            self.has_open_line = true;
        } else {
            self.completed_lines += newlines;
            let tail = match text.rfind('\n') {
                Some(idx) => &text[idx + 1..],
                None => text,
            };
            self.current_line_bytes = js_byte_length(tail);
            self.has_open_line = !tail.is_empty();
        }
        self.total_lines = self.completed_lines + usize::from(self.has_open_line);
    }

    fn trim_tail(&mut self) {
        self.trim_tail_bytes();
        self.trim_tail_lines();
    }

    /// Byte window: keep at most `max_rolling_bytes`, cutting on a char
    /// boundary exactly as before.
    fn trim_tail_bytes(&mut self) {
        let bytes = self.tail.as_bytes();
        if bytes.len() <= self.max_rolling_bytes {
            return;
        }
        let mut start = bytes.len() - self.max_rolling_bytes;
        while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
            start += 1;
        }
        if start > 0 {
            self.tail_starts_at_line_boundary = bytes[start - 1] == 0x0a;
        }
        self.tail = String::from_utf8_lossy(&bytes[start..]).into_owned();
        self.tail_line_starts.retain(|off| *off >= start);
        for off in &mut self.tail_line_starts {
            *off -= start;
        }
    }

    /// Line window: keep at most `max_lines + 1` complete lines, so every
    /// `snapshot()` re-splits only the display window instead of the whole
    /// rolling tail. The oracle keeps the last `max_lines` lines, so a window
    /// of `max_lines + 1` complete lines (+ the open line) always contains
    /// everything a one-pass truncation could keep — same bytes out. The
    /// entry after the final newline is the phantom empty line, so the deque
    /// bound is one higher than the real-line target.
    fn trim_tail_lines(&mut self) {
        while self.tail_line_starts.len() > self.max_lines + 2 {
            self.tail_line_starts.pop_front();
        }
        let Some(&cut) = self.tail_line_starts.front() else {
            return;
        };
        if cut == 0 {
            return;
        }
        for off in &mut self.tail_line_starts {
            *off -= cut;
        }
        self.tail = self.tail[cut..].to_string();
        self.tail_starts_at_line_boundary = true;
    }

    fn snapshot_text(&self) -> String {
        if self.tail_starts_at_line_boundary {
            return self.tail.clone();
        }
        match self.tail.find('\n') {
            Some(idx) => self.tail[idx + 1..].to_string(),
            None => self.tail.clone(),
        }
    }

    fn should_use_temp_file(&self) -> bool {
        self.total_raw_bytes > self.max_bytes
            || self.total_decoded_bytes > self.max_bytes
            || self.total_lines > self.max_lines
    }

    fn ensure_temp_file(&mut self) {
        if self.temp_file_path.is_some() {
            return;
        }
        let Some((path, file)) = create_output_file(&self.temp_file_prefix) else {
            return;
        };
        let mut writer = BufWriter::new(file);
        let _ = writer.write_all(&self.raw);
        self.raw.clear();
        self.raw.shrink_to_fit();
        self.temp_file_path = Some(path);
        self.temp_writer = Some(writer);
    }
}

/// The capped structured output — string-side twin of the oracle's
/// `readFullOutput`. Under `max_bytes` the buffer moves through unchanged (no
/// second copy of a large stream); beyond it the middle is dropped with the
/// omission marker, first/last halves kept. Head and tail cuts back off to
/// char boundaries exactly like the byte-side path did: an incomplete
/// sequence at a cut is dropped, not replaced.
#[must_use]
pub fn cap_full_output(full: String, max_bytes: usize) -> (String, bool) {
    if js_byte_length(&full) <= max_bytes {
        return (full, false);
    }
    let head_bytes = max_bytes / 2;
    let tail_bytes = max_bytes - head_bytes;
    let head = truncate_string_to_bytes_from_start(&full, head_bytes);
    let tail_start = skip_continuation(full.as_bytes(), full.len() - tail_bytes);
    let tail = String::from_utf8_lossy(&full.as_bytes()[tail_start..]).into_owned();
    let omitted = full.len() - head_bytes - tail_bytes;
    (
        format!("{head}\n\n[... {omitted} bytes omitted ...]\n\n{tail}"),
        true,
    )
}

/// Consume a byte buffer as UTF-8, replacing invalid sequences only when the
/// buffer is not valid UTF-8. String::from_utf8 reuses the allocation, so the
/// common all-valid case is a zero-copy reinterpretation.
fn from_utf8_owned(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned())
}

/// Move start forward past UTF-8 continuation bytes so a tail slice begins on a
/// character boundary (the oracle's truncateStringToBytesFromEnd skip).
fn skip_continuation(bytes: &[u8], mut start: usize) -> usize {
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }
    start
}

/// Create the spill file under the system temp dir, 0600, prefix-tagged.
fn create_output_file(prefix: &str) -> Option<(PathBuf, File)> {
    let dir = std::env::temp_dir();
    let unique = format!(
        "{}-{}-{}.log",
        prefix,
        std::process::id(),
        monotonic_nanos()
    );
    let path = dir.join(unique);
    let file = File::create(&path).ok()?;
    set_private_permissions(&path);
    Some((path, file))
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) {}

fn monotonic_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_output_never_spills() {
        let mut acc = OutputAccumulator::new("pi-output");
        acc.append(b"hello\nworld\n");
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(!snap.truncation.truncated);
        assert!(snap.full_output_path.is_none());
        assert_eq!(snap.content, "hello\nworld\n");
        // The oracle's streaming counter reports 2 lines here (one completed by
        // the newline, one open) — NOT 3. Verified against OutputAccumulator.
        assert_eq!(snap.truncation.total_lines, 2);
    }

    #[test]
    fn large_output_spills_and_truncates() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let big = "x".repeat(60 * 1024);
        acc.append(big.as_bytes());
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(snap.truncation.truncated);
        assert!(snap.full_output_path.is_some());
        let path = snap.full_output_path.clone().unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 60 * 1024);
        let (full, was_truncated) = cap_full_output(acc.into_full_text(), 50 * 1024);
        assert!(was_truncated);
        assert!(full.contains("bytes omitted"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn into_full_text_returns_small_output_without_spill() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(b"hello\nworld\n");
        acc.finish();
        assert_eq!(acc.into_full_text(), "hello\nworld\n");
    }

    #[test]
    fn full_text_returns_the_whole_spilled_stream_uncapped() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let body: String = (0..3000)
            .map(|i| format!("line{i}\n"))
            .collect();
        acc.append(body.as_bytes());
        acc.finish();
        let snapshot = acc.snapshot(true);
        let path = snapshot.full_output_path.clone().unwrap();
        // The full text sees the middle that the tail snapshot discarded.
        let full = acc.into_full_text();
        assert_eq!(full, body);
        assert!(full.contains("line5\n"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn full_output_is_returned_verbatim_under_the_limit() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(b"abc");
        acc.append(b"def");
        acc.finish();
        let (full, was_truncated) = cap_full_output(acc.into_full_text(), 50 * 1024);
        assert!(!was_truncated);
        assert_eq!(full, "abcdef");
    }

    #[test]
    fn stdout_and_stderr_interleave_in_arrival_order() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(b"out\n");
        acc.append(b"err\n");
        acc.finish();
        let snap = acc.snapshot(false);
        assert_eq!(snap.content, "out\nerr\n");
    }

    #[test]
    fn empty_output_snapshot_is_empty_and_untruncated() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.finish();
        let snap = acc.snapshot(true);
        assert_eq!(snap.content, "");
        assert_eq!(snap.truncation.total_lines, 0);
        assert!(!snap.truncation.truncated);
        assert!(snap.full_output_path.is_none());
    }

    #[test]
    fn many_small_chunks_reassemble_identically() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let expected = "line one\nline two\nline three\n";
        for byte in expected.as_bytes() {
            acc.append(&[*byte]);
        }
        acc.finish();
        assert_eq!(acc.snapshot(false).content, expected);
    }

    #[test]
    fn invalid_utf8_is_replaced_not_dropped() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(&[0x61, 0xff, 0x62]);
        acc.finish();
        let content = acc.snapshot(false).content;
        assert!(content.starts_with('a') && content.ends_with('b'));
        assert!(content.contains(char::REPLACEMENT_CHARACTER));
    }

    #[test]
    fn truncation_reports_the_byte_cap_cause() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        // 60 KB of digits: over the 50 KB byte cap with few lines.
        acc.append("1".repeat(60 * 1024).as_bytes());
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(snap.truncation.truncated);
        assert_eq!(snap.truncation.truncated_by, Some("bytes"));
        assert!(snap.truncation.last_line_partial);
    }

    #[test]
    fn spill_file_is_not_written_for_small_output() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(b"small\n");
        acc.finish();
        let snap = acc.snapshot(true);
        assert!(snap.full_output_path.is_none());
    }

    #[test]
    fn last_line_bytes_track_the_open_line() {
        let mut acc = OutputAccumulator::new("pi-output");
        acc.append(b"abc\nde");
        assert_eq!(acc.last_line_bytes(), 2);
    }

    #[test]
    fn last_line_bytes_resets_after_a_trailing_newline() {
        let mut acc = OutputAccumulator::new("pi-output");
        acc.append(b"abc\n");
        assert_eq!(acc.last_line_bytes(), 0);
    }

    #[test]
    fn multibyte_character_split_across_chunks_decodes_once() {
        // A pipe hands over whatever bytes are ready, so a 3-byte character can
        // straddle two reads. The streaming decoder must not emit a replacement
        // character per half (the pre-decoder behavior).
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(&[0xE2]);
        acc.append(&[0x82, 0xAC, b'\n']);
        acc.finish();
        let snap = acc.snapshot(false);
        assert_eq!(snap.content, "€\n");
        assert_eq!(snap.truncation.total_bytes, 4);
    }

    #[test]
    fn four_byte_character_split_two_ways_decodes_once() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(&[0xF0, 0x9F]);
        acc.append(&[0x8E, 0x89]);
        acc.finish();
        let snap = acc.snapshot(false);
        assert_eq!(snap.content, "🎉");
        assert_eq!(snap.truncation.total_bytes, 4);
    }

    #[test]
    fn incomplete_sequence_at_end_of_stream_is_one_replacement() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(&[0xE2, 0x82]); // start of a 3-byte char, never completed
        acc.finish();
        assert_eq!(acc.snapshot(false).content, "\u{FFFD}");
    }

    #[test]
    fn cap_full_output_under_cap_moves_the_string_without_a_copy() {
        // The no-duplication contract: under the cap the caller's buffer IS the
        // structured output — no second stream-sized allocation.
        let full = String::from("hello wörld");
        let (structured, truncated) = cap_full_output(full, 1024);
        assert!(!truncated);
        assert_eq!(structured, "hello wörld");
    }

    #[test]
    fn into_full_text_without_spill_returns_the_raw_bytes() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(b"hello ");
        acc.append("wörld".as_bytes());
        acc.finish();
        let full = acc.into_full_text();
        assert_eq!(full, "hello wörld");
    }

    #[test]
    fn cap_full_output_marks_first_and_last_halves_with_a_byte_count() {
        // The head/tail split only applies past the cap; the oracle returns the
        // raw stream verbatim when it fits.
        let full = "a".repeat(60 * 1024);
        let (structured, truncated) = cap_full_output(full, 100);
        assert!(truncated);
        assert!(structured.starts_with(&"a".repeat(50)));
        assert!(structured.ends_with(&"a".repeat(50)));
        assert!(structured.contains("[... 61340 bytes omitted ...]")); // 61440 - 100
    }

    #[test]
    fn cap_full_output_head_drops_an_incomplete_trailing_character() {
        // The head cut lands mid-character; the boundary back-off drops the
        // partial sequence instead of emitting a replacement character.
        let full = format!("aaaéé{}", "a".repeat(60 * 1024));
        let (structured, truncated) = cap_full_output(full, 8); // head=4, tail=4
        assert!(truncated);
        assert!(structured.starts_with("aaa\n\n"), "head must drop the partial char");
        assert!(!structured.contains('\u{FFFD}'));
    }

    #[test]
    fn snapshot_matches_the_oracle_tail_across_chunked_appends() {
        // Streaming compaction contract: incremental window maintenance must be
        // indistinguishable from truncating the assembled stream in one pass —
        // across line, chunk, and UTF-8 sequence boundaries.
        let mut body = String::new();
        for i in 0..3000 {
            body.push_str(&format!("line {i:04} é{}\n", "x".repeat(i % 7)));
        }
        let mut acc = OutputAccumulator::new("pi-output-test");
        for chunk in body.as_bytes().chunks(7) {
            acc.append(chunk);
        }
        acc.finish();
        let snap = acc.snapshot(false);
        let oracle = crate::truncate::truncate_tail(&body, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert_eq!(snap.truncation.content, oracle.content);
        assert_eq!(snap.truncation.total_lines, oracle.total_lines);
        assert_eq!(snap.truncation.output_lines, oracle.output_lines);
        assert_eq!(snap.truncation.truncated, oracle.truncated);
        assert_eq!(snap.truncation.truncated_by, oracle.truncated_by);
    }

    #[test]
    fn snapshot_matches_the_oracle_tail_when_the_byte_window_binds() {
        // Long lines: the rolling byte window (not the line window) drives the
        // trims, and the kept display must still match a one-pass truncation.
        let body: String = (0..100).map(|i| format!("L{i:03} {}\n", "y".repeat(3072))).collect();
        let mut acc = OutputAccumulator::new("pi-output-test");
        for chunk in body.as_bytes().chunks(1021) {
            acc.append(chunk);
        }
        acc.finish();
        let snap = acc.snapshot(false);
        let oracle = crate::truncate::truncate_tail(&body, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert_eq!(snap.truncation.content, oracle.content);
        assert_eq!(snap.truncation.output_bytes, oracle.output_bytes);
        assert_eq!(snap.truncation.last_line_partial, oracle.last_line_partial);
    }

    #[test]
    fn snapshot_window_stays_aligned_across_repeated_snapshots() {
        // The daemon's throttled observer snapshots after every chunk window;
        // appending past a snapshot must keep the window oracle-identical.
        let body: String = (0..2500).map(|i| format!("row {i:04} é\n")).collect();
        let mut acc = OutputAccumulator::new("pi-output-test");
        for chunk in body.as_bytes().chunks(97) {
            acc.append(chunk);
            let _ = acc.snapshot(false);
        }
        acc.finish();
        let snap = acc.snapshot(false);
        let oracle = crate::truncate::truncate_tail(&body, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert_eq!(snap.truncation.content, oracle.content);
        assert_eq!(snap.truncation.total_lines, oracle.total_lines);
    }

    #[test]
    fn line_and_byte_windows_bind_together_matches_oracle() {
        // 5000 × ~120 B lines trips BOTH trims (line window and the rolling
        // byte window) — the combined case the one-dimensional tests miss.
        let body: String = (0..5000).map(|i| format!("L{i:04} {}\n", "z".repeat(110))).collect();
        let mut acc = OutputAccumulator::new("pi-output-test");
        for chunk in body.as_bytes().chunks(513) {
            acc.append(chunk);
        }
        acc.finish();
        let snap = acc.snapshot(false);
        let oracle = crate::truncate::truncate_tail(&body, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert_eq!(snap.truncation.content, oracle.content);
        assert_eq!(snap.truncation.output_lines, oracle.output_lines);
        assert_eq!(snap.truncation.output_bytes, oracle.output_bytes);
        assert_eq!(snap.truncation.truncated_by, oracle.truncated_by);
    }

    #[test]
    fn open_last_line_without_newline_is_counted_and_kept() {
        let body: String = (0..2500).map(|i| format!("row {i:04} é\n")).collect();
        let body = format!("{body}tail-no-newline é");
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append(body.as_bytes());
        acc.finish();
        let snap = acc.snapshot(false);
        let oracle = crate::truncate::truncate_tail(&body, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert_eq!(snap.truncation.content, oracle.content);
        assert_eq!(snap.truncation.total_lines, oracle.total_lines);
        assert!(snap.truncation.content.ends_with("tail-no-newline é"));
        assert!(!snap.truncation.last_line_partial);
    }

    #[test]
    fn cap_full_output_tail_cut_backs_off_mid_character() {
        // The tail budget starts inside the final multi-byte character; the
        // boundary skip must drop the partial sequence, not emit a replacement.
        let full = format!("{}éa", "a".repeat(60 * 1024));
        let (structured, truncated) = cap_full_output(full, 8); // head=4, tail=4
        assert!(truncated);
        assert!(!structured.contains('\u{FFFD}'));
        assert!(structured.ends_with("éa"));
        assert!(structured.contains("bytes omitted"));
    }

    #[test]
    fn cap_full_output_empty_input_is_verbatim() {
        let (structured, truncated) = cap_full_output(String::new(), 1024);
        assert!(!truncated);
        assert_eq!(structured, "");
    }

    #[test]
    fn cap_full_output_zero_budget_keeps_only_the_marker() {
        let (structured, truncated) = cap_full_output(String::from("abcdef"), 0);
        assert!(truncated);
        assert_eq!(structured, "\n\n[... 6 bytes omitted ...]\n\n");
    }

    #[test]
    fn spill_file_is_created_with_private_permissions() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append("x".repeat(60 * 1024).as_bytes());
        acc.finish();
        let snap = acc.snapshot(true);
        let path = snap.full_output_path.clone().expect("spilled");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "spill file must not be world-readable");
        }
        let _ = std::fs::remove_file(&path);
    }
}
