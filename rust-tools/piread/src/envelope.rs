//! JSON envelope types — the wire contract between piread and the extension.
//!
//! Field order matches the spec (`ok` first) and names are camelCase so the
//! extension can forward values verbatim. Serialization is hand-rolled for
//! the two large string fields (`content`, `truncation.content`): serde's
//! per-byte escape scan measured ~0.8 GB/s there (twice per response — the
//! truncation report repeats the prefix), while a SWAR word scan over clean
//! spans runs ~2.5× faster and never regresses escape-dense text. Output is
//! byte-identical to `serde_json` (pinned by unit tests against the derive
//! and exhaustively over all single-byte strings).

use serde::Serialize;
use serde_json::Value;

use crate::ToolError;

/// Truncation report mirroring the built-in `truncateHead` result object.
/// Rendered content sits in the top-level `content` field; this is the
/// `details.truncation` payload the extension forwards.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Truncation {
    pub content: String,
    pub truncated: bool,
    /// "lines" | "bytes" | null — serialized as a JSON string or null.
    pub truncated_by: Option<TruncationKind>,
    pub total_lines: u64,
    pub total_bytes: u64,
    pub output_lines: u64,
    pub output_bytes: u64,
    pub last_line_partial: bool,
    pub first_line_exceeds_limit: bool,
    pub max_lines: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum TruncationKind {
    #[serde(rename = "lines")]
    Lines,
    #[serde(rename = "bytes")]
    Bytes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(test)]
struct Success<'a> {
    /// Daemon request id (echoed verbatim); absent in one-shot output.
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a Value>,
    ok: bool,
    content: &'a str,
    truncation: Option<&'a Truncation>,
    binary: bool,
    total_bytes: u64,
    compaction: Option<CompactionWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locate: Option<&'a LocateWire>,
}

/// Head-tail compaction diagnostics carried in the success envelope
/// (`compaction`). `Serialize + PartialEq` so the serde-derive parity test can
/// compare it against the hand-rolled writer; owned by the envelope so
/// `pipeline` re-exports it instead of defining a mirror type.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionWire<'a> {
    pub strategy: &'a str,
    pub original_chars: usize,
    pub visible_chars: usize,
    pub omitted_chars: usize,
    /// Whole-line cuts in absolute 1-based file lines (C3); empty when the
    /// cut was chars-only or nothing was dropped.
    pub omissions: Vec<OmissionWire>,
    pub partial: bool,
}

/// One compaction cut as carried in the success envelope: absolute 1-based
/// file lines plus the chars/lines counts the model-visible marker states.
/// Consumed by the permission gate's structured coverage path; `Serialize +
/// PartialEq` so it rides `CompactionWire`'s derive-parity test.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OmissionWire {
    pub start_line: usize,
    pub end_line: usize,
    pub chars: usize,
    pub lines: usize,
}

#[derive(Serialize)]
#[cfg(test)]
struct Failure<'a> {
    /// Daemon request id (echoed verbatim); absent in one-shot output.
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a Value>,
    ok: bool,
    error: &'a ToolErrorBody<'a>,
}

#[derive(Serialize)]
#[cfg(test)]
struct ToolErrorBody<'a> {
    kind: &'a ErrorKind,
    message: &'a str,
}

/// Fused locate+read report carried in the success envelope (`locate`),
/// present only for `--hits` reads. `hits` holds ascending match line
/// numbers the model can actually see — every hit inside a printed window,
/// plus the footer pointers capped at `read.locate.pointers`; `hits_total`
/// is the full match count; `windows` lists the printed windows (1-based,
/// inclusive).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocateWire {
    pub needle: String,
    pub hits: Vec<u64>,
    pub hits_total: u64,
    pub windows: Vec<(u64, u64)>,
    /// Whole-file line count (JS split semantics): the domain the printed
    /// windows are complemented against for read-coverage indexing.
    pub total_lines: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum ErrorKind {
    #[serde(rename = "ENOENT")]
    Enoent,
    #[serde(rename = "EACCES")]
    Eacces,
    #[serde(rename = "EISDIR")]
    Eisdir,
    #[serde(rename = "io")]
    Io,
    #[serde(rename = "offset")]
    Offset,
    /// Daemon-mode only: request violated the CLI contract (offset/limit < 1).
    #[serde(rename = "usage")]
    Usage,
    /// Daemon-mode only: unparseable request line.
    #[serde(rename = "protocol")]
    Protocol,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Enoent => "ENOENT",
            ErrorKind::Eacces => "EACCES",
            ErrorKind::Eisdir => "EISDIR",
            ErrorKind::Io => "io",
            ErrorKind::Offset => "offset",
            ErrorKind::Usage => "usage",
            ErrorKind::Protocol => "protocol",
        }
    }
}

pub fn success_envelope(
    content: &str,
    truncation: Option<&Truncation>,
    binary: bool,
    total_bytes: u64,
    compaction: Option<&CompactionWire<'_>>,
    locate: Option<&LocateWire>,
) -> String {
    let mut buf = Vec::new();
    write_success_with_id(
        &mut buf,
        None,
        content,
        truncation,
        binary,
        total_bytes,
        compaction,
        locate,
    );
    String::from_utf8(buf).expect("success envelope is UTF-8")
}

pub fn fail_envelope(err: &ToolError) -> String {
    let mut buf = Vec::new();
    write_fail_with_id(&mut buf, None, err);
    String::from_utf8(buf).expect("failure envelope is UTF-8")
}

/// serde_json's escape classification: 0 = passthrough, else the escape
/// code (1..=7 named, 8 = `\u00xx`). Built to mirror serde_json's private
/// `ESCAPE` table exactly.
static ESCAPE: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0;
    while i < 0x20 {
        t[i] = 8;
        i += 1;
    }
    t[0x08] = 1;
    t[b'\t' as usize] = 2;
    t[b'\n' as usize] = 3;
    t[0x0C] = 4;
    t[b'\r' as usize] = 5;
    t[b'"' as usize] = 6;
    t[b'\\' as usize] = 7;
    t
};

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Append `s` as a JSON string literal (quotes included), byte-identical to
/// `serde_json::to_writer(&mut buf, &s)` — clean 8-byte words are skipped
/// with SWAR zero-tests; a flagged word is scanned byte-wise; four dirty
/// words in a row hand off to a serde-identical loop for the rest.
fn write_json_str(buf: &mut Vec<u8>, s: &str) {
    /// serde-identical byte loop from `from` (inclusive) to the end.
    fn tail(buf: &mut Vec<u8>, bytes: &[u8], from: usize) {
        let mut start = from;
        for i in from..bytes.len() {
            let esc = ESCAPE[bytes[i] as usize];
            if esc == 0 {
                continue;
            }
            if start < i {
                buf.extend_from_slice(&bytes[start..i]);
            }
            push_escape(buf, esc, bytes[i]);
            start = i + 1;
        }
        buf.extend_from_slice(&bytes[start..]);
    }

    buf.push(b'"');
    let bytes = s.as_bytes();
    let mut emitted = 0; // bytes already flushed (clean-span start)
    let mut j = 0; // scan cursor
    let mut dirty_streak = 0u32;
    while j + 8 <= bytes.len() {
        let v = u64::from_le_bytes(bytes[j..j + 8].try_into().unwrap());
        let x22 = v ^ 0x2222_2222_2222_2222;
        let x5c = v ^ 0x5c5c_5c5c_5c5c_5c5c;
        // Any byte < 0x20 (hasless), or " or \\ (haszero on xored word).
        let dirty = (v.wrapping_sub(0x2020_2020_2020_2020) & !v
            | x22.wrapping_sub(0x0101_0101_0101_0101) & !x22
            | x5c.wrapping_sub(0x0101_0101_0101_0101) & !x5c)
            & 0x8080_8080_8080_8080;
        if dirty == 0 {
            j += 8;
            dirty_streak = 0;
            continue;
        }
        dirty_streak += 1;
        if dirty_streak >= 4 {
            // Escape-dense tail: word tests cost more than they save.
            buf.extend_from_slice(&bytes[emitted..j]);
            tail(buf, bytes, j);
            buf.push(b'"');
            return;
        }
        let word_end = j + 8;
        while j < word_end {
            let esc = ESCAPE[bytes[j] as usize];
            if esc != 0 {
                buf.extend_from_slice(&bytes[emitted..j]);
                push_escape(buf, esc, bytes[j]);
                emitted = j + 1;
            }
            j += 1;
        }
    }
    buf.extend_from_slice(&bytes[emitted..j]);
    tail(buf, bytes, j);
    buf.push(b'"');
}

fn push_escape(buf: &mut Vec<u8>, esc: u8, byte: u8) {
    match esc {
        1 => buf.extend_from_slice(b"\\b"),
        2 => buf.extend_from_slice(b"\\t"),
        3 => buf.extend_from_slice(b"\\n"),
        4 => buf.extend_from_slice(b"\\f"),
        5 => buf.extend_from_slice(b"\\r"),
        6 => buf.extend_from_slice(b"\\\""),
        7 => buf.extend_from_slice(b"\\\\"),
        _ => {
            buf.extend_from_slice(b"\\u00");
            buf.push(HEX[(byte >> 4) as usize]);
            buf.push(HEX[(byte & 0xF) as usize]);
        }
    }
}

fn write_bool(buf: &mut Vec<u8>, v: bool) {
    buf.extend_from_slice(if v { b"true" } else { b"false" });
}

fn write_u64(buf: &mut Vec<u8>, v: u64) {
    // serde_json writes integers via itoa-style formatting; reuse it for the
    // handful of numeric fields (no format! machinery).
    serde_json::to_writer(&mut *buf, &v).expect("u64 serializes");
}

fn write_truncation(buf: &mut Vec<u8>, t: &Truncation) {
    // Field order mirrors the derive on `Truncation` (pinned by test).
    buf.extend_from_slice(b"{\"content\":");
    write_json_str(buf, &t.content);
    buf.extend_from_slice(b",\"truncated\":");
    write_bool(buf, t.truncated);
    buf.extend_from_slice(b",\"truncatedBy\":");
    match t.truncated_by {
        Some(TruncationKind::Lines) => buf.extend_from_slice(b"\"lines\""),
        Some(TruncationKind::Bytes) => buf.extend_from_slice(b"\"bytes\""),
        None => buf.extend_from_slice(b"null"),
    }
    for (name, v) in [
        ("totalLines", t.total_lines),
        ("totalBytes", t.total_bytes),
        ("outputLines", t.output_lines),
        ("outputBytes", t.output_bytes),
    ] {
        buf.extend_from_slice(b",\"");
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(b"\":");
        write_u64(buf, v);
    }
    for (name, v) in [
        ("lastLinePartial", t.last_line_partial),
        ("firstLineExceedsLimit", t.first_line_exceeds_limit),
    ] {
        buf.extend_from_slice(b",\"");
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(b"\":");
        write_bool(buf, v);
    }
    for (name, v) in [("maxLines", t.max_lines), ("maxBytes", t.max_bytes)] {
        buf.extend_from_slice(b",\"");
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(b"\":");
        write_u64(buf, v);
    }
    buf.push(b'}');
}

/// Daemon response: the one-shot envelope plus the echoed request id first.
/// Serializes straight into `buf` — the daemon reuses one buffer across
/// responses so large payloads cost no per-response allocation.
pub fn write_success_with_id(
    buf: &mut Vec<u8>,
    id: Option<&Value>,
    content: &str,
    truncation: Option<&Truncation>,
    binary: bool,
    total_bytes: u64,
    compaction: Option<&CompactionWire<'_>>,
    locate: Option<&LocateWire>,
) {
    buf.extend_from_slice(b"{");
    if let Some(id) = id {
        buf.extend_from_slice(b"\"id\":");
        serde_json::to_writer(&mut *buf, id).expect("id serializes");
        buf.extend_from_slice(b",");
    }
    buf.extend_from_slice(b"\"ok\":true,\"content\":");
    write_json_str(buf, content);
    buf.extend_from_slice(b",\"truncation\":");
    match truncation {
        None => buf.extend_from_slice(b"null"),
        Some(t) => write_truncation(buf, t),
    }
    buf.extend_from_slice(b",\"binary\":");
    write_bool(buf, binary);
    buf.extend_from_slice(b",\"totalBytes\":");
    write_u64(buf, total_bytes);
    buf.extend_from_slice(b",\"compaction\":");
    match compaction {
        None => buf.extend_from_slice(b"null"),
        Some(c) => {
            buf.extend_from_slice(b"{\"strategy\":");
            write_json_str(buf, c.strategy);
            buf.extend_from_slice(b",\"originalChars\":");
            write_u64(buf, c.original_chars as u64);
            buf.extend_from_slice(b",\"visibleChars\":");
            write_u64(buf, c.visible_chars as u64);
            buf.extend_from_slice(b",\"omittedChars\":");
            write_u64(buf, c.omitted_chars as u64);
            buf.extend_from_slice(b",\"omissions\":[");
            for (i, o) in c.omissions.iter().enumerate() {
                if i > 0 {
                    buf.push(b',');
                }
                buf.extend_from_slice(b"{\"startLine\":");
                write_u64(buf, o.start_line as u64);
                buf.extend_from_slice(b",\"endLine\":");
                write_u64(buf, o.end_line as u64);
                buf.extend_from_slice(b",\"chars\":");
                write_u64(buf, o.chars as u64);
                buf.extend_from_slice(b",\"lines\":");
                write_u64(buf, o.lines as u64);
                buf.push(b'}');
            }
            buf.push(b']');
            buf.extend_from_slice(b",\"partial\":");
            write_bool(buf, c.partial);
            buf.push(b'}');
        }
    }
    if let Some(l) = locate {
        buf.extend_from_slice(b",\"locate\":{\"needle\":");
        write_json_str(buf, &l.needle);
        buf.extend_from_slice(b",\"hits\":[");
        for (i, h) in l.hits.iter().enumerate() {
            if i > 0 {
                buf.push(b',');
            }
            write_u64(buf, *h);
        }
        buf.extend_from_slice(b"],\"hitsTotal\":");
        write_u64(buf, l.hits_total);
        buf.extend_from_slice(b",\"windows\":[");
        for (i, w) in l.windows.iter().enumerate() {
            if i > 0 {
                buf.push(b',');
            }
            buf.push(b'[');
            write_u64(buf, w.0);
            buf.push(b',');
            write_u64(buf, w.1);
            buf.push(b']');
        }
        buf.extend_from_slice(b"],\"totalLines\":");
        write_u64(buf, l.total_lines);
        buf.push(b'}');
    }
    buf.push(b'}');
}

/// Daemon response: the one-shot failure envelope plus the echoed request id.
pub fn write_fail_with_id(buf: &mut Vec<u8>, id: Option<&Value>, err: &ToolError) {
    buf.extend_from_slice(b"{");
    if let Some(id) = id {
        buf.extend_from_slice(b"\"id\":");
        serde_json::to_writer(&mut *buf, id).expect("id serializes");
        buf.extend_from_slice(b",");
    }
    buf.extend_from_slice(b"\"ok\":false,\"error\":{\"kind\":");
    write_json_str(buf, err.kind.as_str());
    buf.extend_from_slice(b",\"message\":");
    write_json_str(buf, &err.message);
    buf.extend_from_slice(b"}}");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fast string writer must be byte-identical to serde_json for every
    /// input, not just corpus shapes — exhaustively over all single bytes,
    /// escape combinations, and randomized strings (deterministic LCG).
    #[test]
    fn json_str_matches_serde_exhaustively() {
        let check = |s: &str| {
            let mut fast = Vec::new();
            write_json_str(&mut fast, s);
            let mut std = Vec::new();
            serde_json::to_writer(&mut std, &s).unwrap();
            assert_eq!(fast, std, "mismatch for {s:?}");
        };
        for b in 0u8..=255 {
            check(&(b as char).to_string());
        }
        let corpus: Vec<String> = [
            String::new(),
            "plain".into(),
            "with \"quotes\" and \\ backslash".into(),
            "all: \u{8}\t\n\u{c}\r \u{b}".into(),
            "unicode héllo 🎉 €€€".into(),
            (0..=255u8).map(|b| b as char).collect(),
            "x".repeat(100),
            "\n".repeat(50),
            "line0000\n".repeat(100),
            "ab\"cd\"ef".repeat(50),
        ]
        .into();
        for s in &corpus {
            check(s);
        }
        let mut seed = 0x1234_5678u64;
        for len in [0usize, 1, 7, 8, 9, 15, 16, 17, 63, 64, 100, 101, 1000, 10_000] {
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    seed = seed
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    (seed >> 33) as u8
                })
                .collect();
            check(&String::from_utf8_lossy(&bytes));
        }
    }

    /// The hand-rolled envelope writers must match the serde derives byte
    /// for byte — this pins field order, casing, skipping, and escaping.
    #[test]
    fn hand_rolled_envelopes_match_derive() {
        let truncation = Truncation {
            content: "prefix\nwith \"quotes\" \\ and \u{1}ctrl\nlines".into(),
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
        };
        let err = ToolError {
            kind: ErrorKind::Enoent,
            message: "ENOENT: no such file or directory, access '/tmp/\"quoted\"'".into(),
        };
        let compaction = CompactionWire {
            strategy: "head-tail",
            original_chars: 9_000,
            visible_chars: 1_800,
            omitted_chars: 7_200,
            omissions: vec![OmissionWire {
                start_line: 164,
                end_line: 168,
                chars: 153,
                lines: 5,
            }],
            partial: true,
        };
        let locate = LocateWire {
            needle: "read_\"text\"".into(),
            hits: vec![3, 44],
            hits_total: 2,
            windows: vec![(1, 15), (32, 56)],
            total_lines: 2500,
        };
        for id in [None, Some(serde_json::json!({"nonce": 7, "tag": "\"x\n"}))] {
            let mut fast = Vec::new();
            write_success_with_id(
                &mut fast,
                id.as_ref(),
                "content with \"q\" \\ and \n newlines \u{1}",
                Some(&truncation),
                true,
                123_456,
                Some(&compaction),
                Some(&locate),
            );
            let derived = serde_json::to_string(&Success {
                id: id.as_ref(),
                ok: true,
                content: "content with \"q\" \\ and \n newlines \u{1}",
                truncation: Some(&truncation),
                binary: true,
                total_bytes: 123_456,
                compaction: Some(compaction.clone()),
                locate: Some(&locate),
            })
            .unwrap();
            assert_eq!(fast, derived.as_bytes());

            let mut fast = Vec::new();
            write_fail_with_id(&mut fast, id.as_ref(), &err);
            let derived = serde_json::to_string(&Failure {
                id: id.as_ref(),
                ok: false,
                error: &ToolErrorBody {
                    kind: &err.kind,
                    message: &err.message,
                },
            })
            .unwrap();
            assert_eq!(fast, derived.as_bytes());
        }
        // untruncated success (truncation: null) via the one-shot wrapper
        let plain = success_envelope("solo\n", None, false, 5, None, None);
        let derived = serde_json::to_string(&Success {
            id: None,
            ok: true,
            content: "solo\n",
            truncation: None,
            binary: false,
            total_bytes: 5,
            compaction: None,
            locate: None,
        })
        .unwrap();
        assert_eq!(plain, derived);
        assert_eq!(
            fail_envelope(&err),
            serde_json::to_string(&Failure {
                id: None,
                ok: false,
                error: &ToolErrorBody { kind: &err.kind, message: &err.message },
            })
            .unwrap()
        );
    }
}
