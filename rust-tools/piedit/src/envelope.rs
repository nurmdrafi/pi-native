//! JSON envelope types — the wire contract between piedit and the extension.
//!
//! Request (stdin):  { "edits": [ { "oldText": "…", "newText": "…" } ],
//!                     "renderDiff"?: boolean }
//! Response, legacy (renderDiff absent/false):
//!   success → { ok, baseContent, newContent }
//!   failure → { ok, error: { kind, message } }
//! Response, rendered (renderDiff true):
//!   success → { ok, diff, patch, firstChangedLine? }   (daemon: + echoed id)
//!   failure → { ok, error: { kind, message } }
//!
//! The rendered shape is the fast path: the two full-content strings never
//! cross the boundary, only the small rendered `details` fields do.
//!
//! Field order matches the spec (`ok` first). Serialization is hand-rolled so
//! the two large string fields cross the boundary without a per-field
//! allocation; output is byte-identical to `serde_json` (pinned by unit
//! tests against the derives).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ToolError;

/// One targeted replacement, exactly as the built-in `edit` accepts.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Edit {
    #[serde(rename = "oldText")]
    pub old_text: String,
    #[serde(rename = "newText")]
    pub new_text: String,
}

/// The stdin request object.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// Tool-level path as the caller supplied it (used in error messages when
    /// present); absent = use the CLI `--path` verbatim.
    #[serde(default)]
    pub path: Option<String>,
    pub edits: Vec<Edit>,
    /// When true, the response carries natively rendered `{diff, patch,
    /// firstChangedLine}` instead of `{baseContent, newContent}`.
    #[serde(rename = "renderDiff", default)]
    pub render_diff: Option<bool>,
}

#[derive(Serialize)]
#[cfg(test)]
struct Success<'a> {
    ok: bool,
    #[serde(rename = "baseContent")]
    base_content: &'a str,
    #[serde(rename = "newContent")]
    new_content: &'a str,
}

#[derive(Serialize)]
#[cfg(test)]
struct Failure<'a> {
    ok: bool,
    error: &'a ToolErrorBody<'a>,
}

#[derive(Serialize)]
#[cfg(test)]
struct ToolErrorBody<'a> {
    kind: &'a ErrorKind,
    message: &'a str,
}

/// Coarse failure family for observability; exact messages carry the detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    #[serde(rename = "ENOENT")]
    Enoent,
    #[serde(rename = "EACCES")]
    Eacces,
    #[serde(rename = "ENOTDIR")]
    Enotdir,
    /// The caller's `edits` array was empty or malformed.
    #[serde(rename = "EMPTY_OLDTEXT")]
    EmptyOldText,
    /// An `oldText` was not found in the file.
    #[serde(rename = "NOT_FOUND")]
    NotFound,
    /// An `oldText` matched more than once.
    #[serde(rename = "DUPLICATE")]
    Duplicate,
    /// Two edits' matched regions overlap.
    #[serde(rename = "OVERLAP")]
    Overlap,
    /// The replacements produced identical content.
    #[serde(rename = "NO_CHANGE")]
    NoChange,
    /// Any other I/O failure.
    #[serde(rename = "io")]
    Io,
    /// Daemon-mode only: request violated the CLI contract.
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
            ErrorKind::Enotdir => "ENOTDIR",
            ErrorKind::EmptyOldText => "EMPTY_OLDTEXT",
            ErrorKind::NotFound => "NOT_FOUND",
            ErrorKind::Duplicate => "DUPLICATE",
            ErrorKind::Overlap => "OVERLAP",
            ErrorKind::NoChange => "NO_CHANGE",
            ErrorKind::Io => "io",
            ErrorKind::Usage => "usage",
            ErrorKind::Protocol => "protocol",
        }
    }
}

/// serde_json's escape classification (see rust-tools/piread/src/envelope.rs).
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

/// Append `s` as a JSON string literal, byte-identical to serde_json.
fn write_json_str(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for i in 0..bytes.len() {
        let esc = ESCAPE[bytes[i] as usize];
        if esc == 0 {
            continue;
        }
        buf.extend_from_slice(&bytes[start..i]);
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
                buf.push(HEX[(bytes[i] >> 4) as usize]);
                buf.push(HEX[(bytes[i] & 0xF) as usize]);
            }
        }
        start = i + 1;
    }
    buf.extend_from_slice(&bytes[start..]);
    buf.push(b'"');
}

pub fn success_envelope(base_content: &str, new_content: &str) -> String {
    let mut buf = Vec::new();
    write_success_with_id(&mut buf, None, base_content, new_content);
    String::from_utf8(buf).expect("success envelope is UTF-8")
}

/// Rendered-path success for the one-shot CLI: `{ok, diff, patch,
/// firstChangedLine}` (no id — one request, one response).
pub fn success_rendered_envelope(rendered: &crate::pipeline::Rendered) -> String {
    let mut buf = Vec::new();
    write_success_rendered_with_id(&mut buf, None, rendered);
    String::from_utf8(buf).expect("success envelope is UTF-8")
}

pub fn fail_envelope(err: &ToolError) -> String {
    let mut buf = Vec::new();
    write_fail_with_id(&mut buf, None, err);
    String::from_utf8(buf).expect("failure envelope is UTF-8")
}

/// Daemon response: the one-shot envelope plus the echoed request id first.
/// Serializes straight into `buf` — the daemon reuses one buffer across
/// responses so large payloads cost no per-response allocation.
pub fn write_success_with_id(
    buf: &mut Vec<u8>,
    id: Option<&Value>,
    base_content: &str,
    new_content: &str,
) {
    buf.extend_from_slice(b"{");
    if let Some(id) = id {
        buf.extend_from_slice(b"\"id\":");
        serde_json::to_writer(&mut *buf, id).expect("id serializes");
        buf.extend_from_slice(b",");
    }
    buf.extend_from_slice(b"\"ok\":true,\"baseContent\":");
    write_json_str(buf, base_content);
    buf.extend_from_slice(b",\"newContent\":");
    write_json_str(buf, new_content);
    buf.push(b'}');
}

/// Rendered-path success (daemon): `{id?, ok, diff, patch,
/// firstChangedLine?}` — the two content strings never cross the boundary.
pub fn write_success_rendered_with_id(
    buf: &mut Vec<u8>,
    id: Option<&Value>,
    rendered: &crate::pipeline::Rendered,
) {
    buf.extend_from_slice(b"{");
    if let Some(id) = id {
        buf.extend_from_slice(b"\"id\":");
        serde_json::to_writer(&mut *buf, id).expect("id serializes");
        buf.extend_from_slice(b",");
    }
    buf.extend_from_slice(b"\"ok\":true,\"diff\":");
    write_json_str(buf, &rendered.diff);
    buf.extend_from_slice(b",\"patch\":");
    write_json_str(buf, &rendered.patch);
    if let Some(line) = rendered.first_changed_line {
        buf.extend_from_slice(b",\"firstChangedLine\":");
        let mut num = [0u8; 20];
        buf.extend_from_slice(write_uint(&mut num, line as u64));
    }
    buf.push(b'}');
}

/// Decimal render of `n` into `buf`; returns the written slice.
fn write_uint(buf: &mut [u8; 20], n: u64) -> &[u8] {
    if n == 0 {
        buf[0] = b'0';
        return &buf[..1];
    }
    let mut i = buf.len();
    let mut n = n;
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    &buf[i..]
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
        for s in [
            "",
            "plain",
            "with \"quotes\" and \\ backslash",
            "all: \u{8}\t\n\u{c}\r \u{b}",
            "unicode héllo 🎉 €€€",
        ] {
            check(s);
        }
        let all: String = (0..=255u8).map(|b| b as char).collect();
        check(&all);
    }

    #[test]
    fn hand_rolled_envelopes_match_derive() {
        let base = "line with \"quotes\" \\ and \n newlines \u{1}";
        let new = "changed 🎉 content";
        let fast = success_envelope(base, new);
        let derived = serde_json::to_string(&Success {
            ok: true,
            base_content: base,
            new_content: new,
        })
        .unwrap();
        assert_eq!(fast, derived);

        let err = ToolError {
            kind: ErrorKind::NotFound,
            message: "Could not find the exact text in /tmp/x.".into(),
        };
        let fast = fail_envelope(&err);
        let derived = serde_json::to_string(&Failure {
            ok: false,
            error: &ToolErrorBody {
                kind: &err.kind,
                message: &err.message,
            },
        })
        .unwrap();
        assert_eq!(fast, derived);
    }

    #[test]
    fn parses_request_object() {
        let r: Request =
            serde_json::from_str(r#"{"edits":[{"oldText":"a","newText":"b"}]}"#).unwrap();
        assert_eq!(r.edits.len(), 1);
        assert_eq!(r.edits[0].old_text, "a");
        assert!(serde_json::from_str::<Request>(r#"{"edits":"nope"}"#).is_err());
    }
}
