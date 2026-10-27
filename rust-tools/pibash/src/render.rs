//! Output rendering — the oracle's `formatOutput` + `appendStatus`.

use crate::accumulator::{OutputAccumulator, Snapshot};
use crate::truncate::Truncation;

/// `structuredContent.output` cap — 1 MiB, as the built-in uses.
#[must_use]
pub fn structured_limit() -> usize {
    1024 * 1024
}

/// `appendStatus(text, status)` — blank-line separated, or the status alone
/// when there is no output.
#[must_use]
pub fn append_status(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.to_string()
    } else {
        format!("{text}\n\n{status}")
    }
}

/// Human byte size, matching `formatSize`.
#[must_use]
pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes}B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1}KB", bytes as f64 / 1024.0);
    }
    format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
}

/// Render display text and the truncation payload for a snapshot.
#[must_use]
pub fn format_output(
    accumulator: &mut OutputAccumulator,
    snapshot: Snapshot,
    empty_text: &str,
) -> (String, Option<Truncation>) {
    let truncation = &snapshot.truncation;
    // Move the snapshot's content into the display text instead of cloning it;
    // the snapshot is consumed here and the caller reads the other fields first.
    let mut text = if snapshot.content.is_empty() {
        empty_text.to_string()
    } else {
        snapshot.content
    };
    if !truncation.truncated {
        return (text, None);
    }
    let start_line = truncation
        .total_lines
        .saturating_sub(truncation.output_lines)
        + 1;
    let end_line = truncation.total_lines;
    let full_output = snapshot
        .full_output_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    if truncation.last_line_partial {
        let last_line_size = format_size(accumulator.last_line_bytes());
        text.push_str(&format!(
            "\n\n[Showing last {} of line {end_line} (line is {last_line_size}). Full output: {full_output}]",
            format_size(truncation.output_bytes)
        ));
    } else if truncation.truncated_by == Some("lines") {
        text.push_str(&format!(
            "\n\n[Showing lines {start_line}-{end_line} of {}. Full output: {full_output}]",
            truncation.total_lines
        ));
    } else {
        text.push_str(&format!(
            "\n\n[Showing lines {start_line}-{end_line} of {} ({} limit). Full output: {full_output}]",
            truncation.total_lines,
            format_size(truncation.max_bytes)
        ));
    }
    (text, Some(truncation.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_output_uses_the_placeholder() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.finish();
        let snapshot = acc.snapshot(false);
        let (text, truncation) = format_output(&mut acc, snapshot, "(no output)");
        assert_eq!(text, "(no output)");
        assert!(truncation.is_none());
    }

    #[test]
    fn line_truncation_appends_the_oracle_note() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let body = (0..2100)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        acc.append(body.as_bytes());
        acc.finish();
        let snapshot = acc.snapshot(true);
        let (text, truncation) = format_output(&mut acc, snapshot, "(no output)");
        let truncation = truncation.expect("truncated");
        assert_eq!(truncation.truncated_by, Some("lines"));
        assert!(text.contains("[Showing lines 101-2100 of 2100."));
    }

    #[test]
    fn format_size_matches_the_oracle_units() {
        assert_eq!(format_size(512), "512B");
        assert_eq!(format_size(2048), "2.0KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0MB");
    }

    #[test]
    fn append_status_separates_with_a_blank_line() {
        assert_eq!(append_status("out", "Command exited with code 1"), "out\n\nCommand exited with code 1");
        assert_eq!(append_status("", "Command exited with code 1"), "Command exited with code 1");
    }

    #[test]
    fn partial_last_line_note_reports_the_line_size() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        acc.append("x".repeat(60 * 1024).as_bytes());
        acc.finish();
        let snapshot = acc.snapshot(true);
        let path = snapshot.full_output_path.clone();
        let (text, truncation) = format_output(&mut acc, snapshot, "(no output)");
        let truncation = truncation.expect("truncated");
        assert_eq!(truncation.truncated_by, Some("bytes"));
        assert!(truncation.last_line_partial);
        assert!(text.contains("[Showing last "));
        assert!(text.contains("line is 60.0KB"));
        if let Some(path) = path {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn byte_limited_note_names_the_byte_limit() {
        use std::path::PathBuf;
        let content = "bbbb\ncccc";
        let truncation = Truncation {
            content: content.to_string(),
            truncated: true,
            truncated_by: Some("bytes"),
            total_lines: 3,
            total_bytes: 14,
            output_lines: 2,
            output_bytes: 9,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines: 2000,
            max_bytes: 9,
        };
        let snapshot = Snapshot {
            content: content.to_string(),
            truncation,
            full_output_path: Some(PathBuf::from("/tmp/pibash-test")),
        };
        let mut acc = OutputAccumulator::new("pi-output-test");
        let (text, _) = format_output(&mut acc, snapshot, "(no output)");
        assert!(text.contains("[Showing lines 2-3 of 3 (9B limit). Full output: /tmp/pibash-test]"));
    }
}
