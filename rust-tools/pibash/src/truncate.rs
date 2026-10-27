//! JS-parity primitives: line splitting, byte helpers, truncate-tail.
//!
//! The built-in bash tool is the oracle. Everything here mirrors
//! `dist/core/tools/truncate.js` byte-for-byte, including the JS quirks:
//! `String.split("\n")` yields a trailing phantom segment for content ending
//! in a newline, and truncation is measured in *decoded* bytes.

/// `Buffer.byteLength(s, "utf8")` — Rust `str` is already valid UTF-8.
#[must_use]
pub fn js_byte_length(s: &str) -> usize {
    s.len()
}

/// `splitLinesForCounting` — `content.split("\n")` with the trailing phantom
/// segment popped, and zero lines for empty content. The oracle pops it, so a
/// body ending in a newline counts N lines, not N+1.
#[must_use]
pub fn split_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

/// Field-for-field the shape of the oracle's `truncateTail` return value.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Truncation {
    /// Duplicated on the wire with the top-level display text (the oracle's
    /// own `details.truncation` carries its copy too). The daemon omits it and
    /// the extension reconstructs it from `text`, which halves the envelope for
    /// large truncated output without changing the rebuilt result.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub content: String,
    pub truncated: bool,
    #[serde(rename = "truncatedBy")]
    pub truncated_by: Option<&'static str>,
    #[serde(rename = "totalLines")]
    pub total_lines: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: usize,
    #[serde(rename = "outputLines")]
    pub output_lines: usize,
    #[serde(rename = "outputBytes")]
    pub output_bytes: usize,
    #[serde(rename = "lastLinePartial")]
    pub last_line_partial: bool,
    #[serde(rename = "firstLineExceedsLimit")]
    pub first_line_exceeds_limit: bool,
    #[serde(rename = "maxLines")]
    pub max_lines: usize,
    #[serde(rename = "maxBytes")]
    pub max_bytes: usize,
}

/// Take the last `max_bytes` bytes of `s`, on a character boundary: skip any
/// leading UTF-8 continuation bytes so the result is valid UTF-8. Mirrors the
/// oracle's `truncateStringToBytesFromEnd`.
#[must_use]
pub fn truncate_string_to_bytes_from_end(s: &str, max_bytes: usize) -> String {
    let bytes = s.as_bytes();
    if bytes.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = bytes.len() - max_bytes;
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Take the first `max_bytes` bytes of `s`, on a character boundary: never end
/// inside a UTF-8 sequence. The complement of `truncate_string_to_bytes_from_end`
/// for head slices.
#[must_use]
pub fn truncate_string_to_bytes_from_start(s: &str, max_bytes: usize) -> String {
    let bytes = s.as_bytes();
    if bytes.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    // Back off any trailing continuation bytes so the cut lands on a boundary.
    while end > 0 && (bytes[end] & 0xc0) == 0x80 {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Truncate from the head, keeping the last `max_lines` / `max_bytes`.
/// Direct port of `truncateTail`.
#[must_use]
pub fn truncate_tail(content: &str, max_lines: usize, max_bytes: usize) -> Truncation {
    let total_bytes = js_byte_length(content);
    let lines = split_lines(content);
    let total_lines = lines.len();

    if total_lines <= max_lines && total_bytes <= max_bytes {
        return Truncation {
            content: content.to_string(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    // Walk backwards to find the slice of `lines` that fits, then join it
    // once. The earlier shape pushed each kept line into a `Vec<String>` with an
    // `insert(0, ...)`, allocating a String per line and shifting the whole
    // vector each iteration — O(n²) on line-capped output.
    let mut start = lines.len();
    let mut kept = 0usize;
    let mut output_bytes_count: usize = 0;
    let mut truncated_by: &'static str = "lines";
    let mut last_line_partial = false;
    let mut partial: Option<String> = None;

    while start > 0 && kept < max_lines {
        let line = lines[start - 1];
        // +1 for the newline, except for the last line (added first).
        let line_bytes = js_byte_length(line) + usize::from(start != lines.len());
        if output_bytes_count + line_bytes > max_bytes {
            truncated_by = "bytes";
            if kept == 0 {
                let truncated_line = truncate_string_to_bytes_from_end(line, max_bytes);
                output_bytes_count = js_byte_length(&truncated_line);
                partial = Some(truncated_line);
                last_line_partial = true;
                kept += 1;
            }
            break;
        }
        start -= 1;
        kept += 1;
        output_bytes_count += line_bytes;
    }

    if kept >= max_lines && output_bytes_count <= max_bytes {
        truncated_by = "lines";
    }

    let joined = match partial {
        Some(line) => line,
        None => lines[start..].join("\n"),
    };
    let final_output_bytes = js_byte_length(&joined);

    Truncation {
        content: joined,
        truncated: true,
        truncated_by: Some(truncated_by),
        total_lines,
        total_bytes,
        output_lines: kept,
        output_bytes: final_output_bytes,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_LINES: usize = 2000;
    const MAX_BYTES: usize = 50 * 1024;

    #[test]
    fn trailing_newline_does_not_add_a_phantom_line() {
        // Verified against the oracle's splitLinesForCounting: the trailing
        // empty segment is popped, and empty content has zero lines.
        assert_eq!(split_lines("a\n"), vec!["a"]);
        assert_eq!(split_lines("a"), vec!["a"]);
        assert!(split_lines("").is_empty());
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
    }

    #[test]
    fn under_budget_is_not_truncated() {
        let t = truncate_tail("a\nb\nc", MAX_LINES, MAX_BYTES);
        assert!(!t.truncated);
        assert_eq!(t.truncated_by, None);
        assert_eq!(t.total_lines, 3);
        assert_eq!(t.content, "a\nb\nc");
    }

    #[test]
    fn truncates_by_lines_from_the_tail() {
        let content = (0..10).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let t = truncate_tail(&content, 3, MAX_BYTES);
        assert!(t.truncated);
        assert_eq!(t.truncated_by, Some("lines"));
        assert_eq!(t.content, "7\n8\n9");
        assert_eq!(t.output_lines, 3);
        assert_eq!(t.total_lines, 10);
    }

    #[test]
    fn truncates_by_bytes_when_the_budget_binds() {
        let t = truncate_tail("aaaa\nbbbb\ncccc", MAX_LINES, 9);
        assert!(t.truncated);
        assert_eq!(t.truncated_by, Some("bytes"));
        assert_eq!(t.content, "bbbb\ncccc");
    }

    #[test]
    fn partial_last_line_when_a_single_line_exceeds_the_budget() {
        let t = truncate_tail("0123456789abcdef", MAX_LINES, 4);
        assert!(t.truncated);
        assert_eq!(t.truncated_by, Some("bytes"));
        assert!(t.last_line_partial);
        assert_eq!(t.content, "cdef");
    }

    #[test]
    fn empty_content_has_zero_lines() {
        let t = truncate_tail("", 2000, 50 * 1024);
        assert!(!t.truncated);
        assert_eq!(t.total_lines, 0);
        assert_eq!(t.total_bytes, 0);
        assert_eq!(t.content, "");
    }

    #[test]
    fn single_newline_is_one_line() {
        // `"\n".split("\n")` is ["", ""] with the phantom popped -> [""].
        let t = truncate_tail("
", 2000, 50 * 1024);
        assert_eq!(t.total_lines, 1);
        assert_eq!(t.content, "
");
    }

    #[test]
    fn no_truncation_when_exactly_at_both_caps() {
        let content = "aa
bb
cc";
        let bytes = js_byte_length(content);
        let t = truncate_tail(content, 3, bytes);
        assert!(!t.truncated);
        assert_eq!(t.truncated_by, None);
        assert_eq!(t.output_lines, 3);
    }

    #[test]
    fn one_over_the_line_cap_truncates() {
        let content = "a
b
c
d";
        let t = truncate_tail(content, 3, 50 * 1024);
        assert!(t.truncated);
        assert_eq!(t.truncated_by, Some("lines"));
        assert_eq!(t.content, "b
c
d");
    }

    #[test]
    fn byte_cap_never_splits_a_multibyte_character() {
        // 3-byte chars; cutting mid-sequence must skip to a boundary.
        let content = "€€€€";
        let t = truncate_tail(content, 2000, 4);
        assert!(t.last_line_partial);
        assert!(t.content.is_char_boundary(0));
        assert!(content.ends_with(&t.content));
    }

    #[test]
    fn trailing_empty_line_does_not_change_line_count() {
        let with = truncate_tail("a
b
", 2000, 50 * 1024);
        let without = truncate_tail("a
b", 2000, 50 * 1024);
        assert_eq!(with.total_lines, without.total_lines);
    }

    #[test]
    fn carriage_returns_are_not_line_separators() {
        // The oracle splits on \n only; \r stays inside the line.
        let t = truncate_tail("a\r\nb", 2000, 50 * 1024);
        assert_eq!(t.total_lines, 2);
        assert_eq!(t.content, "a\r\nb");
    }

    #[test]
    fn multibyte_lines_are_measured_in_bytes() {
        // 2 bytes per char; a 1-char line is 2 bytes, +1 newline when joined.
        let t = truncate_tail("é\né\né", MAX_LINES, 7);
        assert!(t.truncated);
        assert_eq!(t.content, "é\né");
    }

    #[test]
    fn truncate_string_to_bytes_from_end_skips_to_a_char_boundary() {
        assert_eq!(truncate_string_to_bytes_from_end("abcdef", 3), "def");
        // 4 bytes cuts inside the first 3-byte char, so it skips to the next.
        assert_eq!(truncate_string_to_bytes_from_end("€€", 4), "€");
    }

    #[test]
    fn partial_line_reports_one_output_line_and_no_head_flag() {
        let t = truncate_tail("0123456789", 2000, 4);
        assert!(t.truncated);
        assert!(t.last_line_partial);
        assert!(!t.first_line_exceeds_limit, "tail truncation never sets the head flag");
        assert_eq!(t.output_lines, 1);
        assert_eq!(t.content, "6789");
    }

    #[test]
    fn exactly_the_line_cap_within_bytes_is_not_truncated() {
        let content = (0..2000).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let t = truncate_tail(&content, 2000, 50 * 1024);
        assert!(!t.truncated);
        assert_eq!(t.total_lines, 2000);
        assert_eq!(t.output_lines, 2000);
    }
}
