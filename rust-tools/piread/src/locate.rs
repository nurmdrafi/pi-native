//! Fused locate+read (`--hits <NEEDLE>`) — one call replacing the two-call
//! locate-then-read pattern.
//!
//! Shape (spec: `research/piread-fused-locate-read.md`):
//! 1. stream the file once, recording the 1-based line numbers whose text
//!    contains NEEDLE (literal, case-sensitive) — memory is O(hits);
//! 2. merge the hit neighborhoods `[h-context, h+context]` (adjacent or
//!    overlapping merge into one window);
//! 3. stream again, printing the windows as `N:text` lines (the shape
//!    `rg -n` emits, so hit-line parsers stay reusable) under the shared
//!    read budget (`read.window.lines` / `read.window.bytes`);
//! 4. skipped ranges become omission markers carrying absolute line ranges;
//!    hits that fall outside the printed windows become one footer pointer
//!    line (the remainder is hit lines, never a blind gap).
//!
//! Budget note: the byte budget governs file lines and gap markers; the
//! footer pointer line rides after it, like the default mode's continuation
//! note (`render` in `pipeline`), and is bounded by `read.locate.pointers`.

use std::fs::File;
use std::io::BufReader;

use crate::bounds::{READ_LOCATE_CONTEXT, READ_LOCATE_POINTERS, READ_WINDOW_BYTES, READ_WINDOW_LINES};
use crate::envelope::LocateWire;
use crate::pipeline::{PipelineOutput, Segmenter, open_error};
use crate::ToolError;

/// Headroom subtracted from the byte budget for line-emission decisions so
/// the gap marker that may follow the last accepted line still fits. The
/// grammar is fixed plus two decimal numbers; 128 bytes covers the absurd
/// u64-width worst case, so the rendered content never exceeds the budget.
const MARKER_HEADROOM: usize = 128;

/// One fused locate+read. `raw_path` is echoed in the miss notice only.
pub fn read_hits(
    resolved: &str,
    raw_path: &str,
    needle: &str,
    line_cap: Option<u64>,
) -> Result<PipelineOutput, ToolError> {
    let (hits, total_lines, binary, total_bytes) = locate(resolved, needle)?;

    if hits.is_empty() {
        return Ok(PipelineOutput {
            content: format!(
                "[no lines matching '{needle}' in {raw_path} ({total_lines} lines, {total_bytes} bytes)]"
            ),
            truncation: None,
            binary,
            total_bytes,
            compaction: None,
            locate: Some(LocateWire {
                needle: needle.to_string(),
                hits: Vec::new(),
                hits_total: 0,
                windows: Vec::new(),
                total_lines,
            }),
        });
    }

    // Merge hit neighborhoods; hits ascend, so windows do too.
    let mut windows: Vec<(u64, u64)> = Vec::new();
    for &h in &hits {
        let lo = h.saturating_sub(READ_LOCATE_CONTEXT).max(1);
        let hi = h.saturating_add(READ_LOCATE_CONTEXT).min(total_lines);
        match windows.last_mut() {
            Some(w) if lo <= w.1 + 1 => w.1 = w.1.max(hi),
            _ => windows.push((lo, hi)),
        }
    }

    // Pass 2: print under both budgets, in file order.
    let line_stop = READ_WINDOW_LINES as usize;
    let byte_stop = READ_WINDOW_BYTES.saturating_sub(MARKER_HEADROOM as u64) as usize;
    let file = File::open(resolved).map_err(|e| open_error(e, resolved))?;
    let mut segs = Segmenter::new(BufReader::with_capacity(64 * 1024, file));
    let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024);

    let mut parts: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut printed = 0usize;
    let mut spent = false;
    let mut wi = 0usize; // current window index
    let mut line_no = 0u64;
    let mut gap_open: Option<u64> = None;
    let mut gap_chars = 0usize;
    let mut printed_windows: Vec<(u64, u64)> = Vec::new();

    while segs.next(&mut buf)? {
        line_no += 1;
        while wi < windows.len() && line_no > windows[wi].1 {
            wi += 1; // window fully passed
        }
        let inside = wi < windows.len() && line_no >= windows[wi].0;
        let raw = String::from_utf8_lossy(&buf);
        let rendered = format!("{line_no}:{}", capped(&raw, line_cap));

        let accept = !spent
            && inside
            && printed < line_stop
            && bytes + rendered.len() <= byte_stop;
        if !accept {
            if gap_open.is_none() {
                gap_open = Some(line_no);
            }
            gap_chars += raw.chars().count();
            if inside {
                // Budget ran out mid-window: nothing later can print.
                spent = true;
            }
            continue;
        }
        if let Some(start) = gap_open.take() {
            let marker = marker(start, line_no - 1, gap_chars);
            bytes += marker.len();
            parts.push(marker);
            gap_chars = 0;
        }
        bytes += rendered.len();
        printed += 1;
        parts.push(rendered);
        match printed_windows.last_mut() {
            // Contiguous printed lines extend the window; a fresh window
            // starts whenever printing resumed after a skipped range.
            Some(w) if w.1 + 1 == line_no => w.1 = line_no,
            _ => printed_windows.push((line_no, line_no)),
        }
    }
    if let Some(start) = gap_open {
        parts.push(marker(start, total_lines, gap_chars));
    }

    // Footer: hits the printed windows did not cover. Windows fill in file
    // order, so a hit is covered exactly when it is at or before the last
    // printed line.
    let last_printed = printed_windows.last().map_or(0, |w| w.1);
    let beyond: Vec<u64> = hits.iter().copied().filter(|h| *h > last_printed).collect();
    // The wire field must name the hits the MODEL can see: every printed hit
    // plus the footer pointers. Capping the raw head of the list instead would
    // hand the permission gate a set disjoint from the ones the footer sends
    // the model back to, so a wide read covering an unprinted hit would be
    // blocked as if the fused call had never reported it.
    let mut listed_hits: Vec<u64> = hits.iter().copied().filter(|h| *h <= last_printed).collect();
    let pointers = &beyond[..beyond.len().min(READ_LOCATE_POINTERS as usize)];
    listed_hits.extend_from_slice(pointers);
    if !beyond.is_empty() {
        let mut footer = String::from("[hits beyond window: ");
        footer.push_str(&pointers.iter().map(u64::to_string).collect::<Vec<_>>().join(", "));
        if beyond.len() > pointers.len() {
            footer.push_str(&format!(", +{} more", beyond.len() - pointers.len()));
        }
        footer.push(']');
        parts.push(footer);
    }

    Ok(PipelineOutput {
        content: parts.join("\n"),
        truncation: None,
        binary,
        total_bytes,
        compaction: None,
        locate: Some(LocateWire {
            needle: needle.to_string(),
            hits: listed_hits,
            hits_total: hits.len() as u64,
            windows: printed_windows,
            total_lines,
        }),
    })
}

/// Pass 1: stream the file, collecting hit line numbers plus the totals the
/// envelope and markers need. Does not buffer the body.
fn locate(resolved: &str, needle: &str) -> Result<(Vec<u64>, u64, bool, u64), ToolError> {
    let file = File::open(resolved).map_err(|e| open_error(e, resolved))?;
    let mut segs = Segmenter::new(BufReader::with_capacity(64 * 1024, file));
    let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024);
    let mut hits = Vec::new();
    let mut total_lines = 0u64;
    while segs.next(&mut buf)? {
        total_lines += 1;
        if String::from_utf8_lossy(&buf).contains(needle) {
            hits.push(total_lines);
        }
    }
    Ok((hits, total_lines, segs.binary, segs.raw_seen))
}

/// Omission marker in the shared grammar, extended with the absolute range
/// so the model can continue without a re-locate.
fn marker(start: u64, end: u64, chars: usize) -> String {
    format!("[... omitted {chars} chars / {} lines ({start}-{end}) ...]", end - start + 1)
}

/// Per-line character cap, identical semantics to the default read path:
/// lines over the cap keep `cap` chars plus a `...[+M chars]` marker;
/// everything else passes through untouched.
fn capped(raw: &str, cap: Option<u64>) -> std::borrow::Cow<'_, str> {
    let Some(c) = cap else { return raw.into() };
    match raw.char_indices().nth(c as usize) {
        Some((cut, _)) => format!("{}...[+{} chars]", &raw[..cut], raw[cut..].chars().count()).into(),
        None => raw.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::read_hits;
    use crate::bounds::READ_LOCATE_POINTERS;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_file(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("piread-locate-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("f");
        fs::write(&file, body).expect("fixture write");
        file
    }

    /// `l1`..`lN`, no trailing newline (N segments for N lines).
    fn numbered(n: usize) -> String {
        (1..=n).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n")
    }

    /// Replace line `n` (1-based) with `text` in a 200-line body.
    fn with_line(n: usize, text: &str) -> String {
        let mut lines: Vec<String> = (1..=200).map(|i| format!("l{i}")).collect();
        lines[n - 1] = text.to_string();
        lines.join("\n")
    }

    #[test]
    fn single_hit_prints_merged_window_with_line_prefixes() {
        let body = with_line(20, "target here");
        let f = tmp_file("single", &body);
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "target", None).unwrap();
        // window [20-12, 20+12] = [8, 32]; the rest is a marked gap
        assert!(out.content.contains("[... omitted 14 chars / 7 lines (1-7) ...]"));
        assert!(out.content.contains("8:l8"));
        assert!(out.content.contains("32:l32"));
        assert!(!out.content.contains(":l33"));
        // l33..l99 are 3 chars, l100..l200 are 4: 67*3 + 101*4 = 605
        assert!(out.content.contains("[... omitted 605 chars / 168 lines (33-200) ...]"));
        assert!(!out.content.contains("hits beyond window"));
        let locate = out.locate.as_ref().expect("locate wire");
        assert_eq!(locate.hits, vec![20]);
        assert_eq!(locate.hits_total, 1);
        assert_eq!(locate.total_lines, 200);
        assert_eq!(locate.windows, vec![(8, 32)]);
        assert!(!out.binary);
    }

    #[test]
    fn adjacent_hits_merge_into_one_window() {
        let mut body: Vec<String> = (1..=40).map(|i| format!("l{i}")).collect();
        body[9] = "sym".into(); // line 10
        body[14] = "sym".into(); // line 15
        let f = tmp_file("adjacent", &body.join("\n"));
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "sym", None).unwrap();
        let locate = out.locate.as_ref().expect("locate wire");
        assert_eq!(locate.windows, vec![(1, 27)]);
        // one window: no interior marker between merged neighborhoods
        assert_eq!(out.content.matches("omitted").count(), 1); // trailing only
        assert!(out.content.contains("[... omitted 39 chars / 13 lines (28-40) ...]"));
    }

    #[test]
    fn distant_hits_get_gap_marker_between_windows() {
        let body = with_line(10, "sym").replace("l60", "sym");
        let f = tmp_file("distant", &body);
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "sym", None).unwrap();
        let locate = out.locate.as_ref().expect("locate wire");
        assert_eq!(locate.windows, vec![(1, 22), (48, 72)]);
        assert!(out.content.contains("22:l22"));
        assert!(out.content.contains("[... omitted 75 chars / 25 lines (23-47) ...]"));
        assert!(out.content.contains("48:l48"));
        // l73..l99 are 3 chars, l100..l200 are 4: 27*3 + 101*4 = 485
        assert!(out.content.contains("[... omitted 485 chars / 128 lines (73-200) ...]"));
    }

    #[test]
    fn line_budget_cuts_and_footer_lists_remaining_hits() {
        let body: Vec<String> = (1..=400).map(|i| format!("sym{i}")).collect();
        let f = tmp_file("budget", &body.join("\n"));
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "sym", None).unwrap();
        let locate = out.locate.as_ref().expect("locate wire");
        assert_eq!(locate.windows, vec![(1, 100)]);
        assert_eq!(locate.hits_total, 400);
        assert!(out.content.contains("100:sym100"));
        assert!(!out.content.lines().any(|l| l.starts_with("101:")));
        assert!(out.content.contains("hits beyond window: 101, 102, 103"));
        assert!(out.content.contains("+260 more"));
        // The wire field names the hits the model can see: the 100 printed ones
        // plus the footer pointers. Capping the raw head would hide exactly the
        // lines the footer sends the model back to (the permission gate seeds
        // its R1c anchors from this field).
        assert_eq!(locate.hits.len(), 100 + READ_LOCATE_POINTERS as usize);
        assert_eq!(locate.hits[..3], [1, 2, 3]);
        assert_eq!(locate.hits[100..103], [101, 102, 103]);
        assert_eq!(
            locate.hits.last().copied(),
            Some(100 + READ_LOCATE_POINTERS)
        );
    }

    #[test]
    fn byte_budget_cuts_at_line_boundary() {
        // 100 lines x 210 chars, every line a hit: one window, byte budget
        // binds long before the 100-line budget.
        let long_line = format!("sym{}", "a".repeat(207));
        let body: Vec<String> = (1..=100).map(|_| long_line.clone()).collect();
        let f = tmp_file("bytes", &body.join("\n"));
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "sym", None).unwrap();
        let locate = out.locate.as_ref().expect("locate wire");
        // cut mid-window, well before EOF
        assert!(locate.windows[0].1 < 100, "byte cut expected, got {:?}", locate.windows);
        // every printed file line is whole: prefix + full 210-char payload
        let file_lines = out
            .content
            .lines()
            .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()))
            .filter(|l| l.contains(':'));
        for l in file_lines {
            let (_n, text) = l.split_once(':').expect("n:text");
            assert_eq!(text.chars().count(), 210, "partial line: {l:.30}");
        }
        assert!(out.content.contains("hits beyond window"));
    }

    #[test]
    fn miss_returns_one_line_notice_and_empty_hits() {
        let body = numbered(5);
        let f = tmp_file("miss", &body);
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "zzz", None).unwrap();
        let total = body.len() as u64;
        assert_eq!(
            out.content,
            format!("[no lines matching 'zzz' in {p} (5 lines, {total} bytes)]")
        );
        let locate = out.locate.as_ref().expect("locate wire");
        assert!(locate.hits.is_empty());
        assert_eq!(locate.hits_total, 0);
        assert_eq!(locate.total_lines, 5);
        assert!(locate.windows.is_empty());
        assert_eq!(out.total_bytes, total);
    }

    #[test]
    fn line_cap_applies_to_fused_lines() {
        let body = with_line(1, &format!("sym{}", "a".repeat(30)));
        let f = tmp_file("cap", &body);
        let p = f.to_string_lossy().into_owned();
        let out = read_hits(&p, &p, "sym", Some(10)).unwrap();
        assert!(out.content.contains("1:symaaaaaaa...[+23 chars]"));
    }
}
