//! JSON envelope — the wire contract between piwrite and the extension.
//!
//! Field order matches the frozen CLI contract (`ok` first; success carries
//! `path` then `bytes`, failure carries `error`). Serialization is
//! hand-rolled, byte-identical to `serde_json` — pinned by unit tests
//! against the derive and exhaustively over all single-byte strings — the
//! same discipline as the piread envelope, minus its large-content SWAR
//! scan: the only string piwrite ever emits is the echoed path.

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

/// `{"ok":true,"path":"<path>","bytes":<n>}` as a one-line string.
pub fn ok_line(path: &str, bytes: u64) -> String {
    let mut buf = Vec::new();
    write_ok(&mut buf, path, bytes);
    String::from_utf8(buf).expect("success envelope is UTF-8")
}

/// `{"ok":false,"error":"<msg>"}` as a one-line string.
pub fn fail_line(error: &str) -> String {
    let mut buf = Vec::new();
    write_fail(&mut buf, error);
    String::from_utf8(buf).expect("failure envelope is UTF-8")
}

/// Serialize one success envelope into `buf` (no trailing newline).
pub fn write_ok(buf: &mut Vec<u8>, path: &str, bytes: u64) {
    buf.extend_from_slice(b"{\"ok\":true,\"path\":");
    write_json_string(buf, path);
    buf.extend_from_slice(b",\"bytes\":");
    buf.extend_from_slice(bytes.to_string().as_bytes());
    buf.push(b'}');
}

/// Serialize one failure envelope into `buf` (no trailing newline).
pub fn write_fail(buf: &mut Vec<u8>, error: &str) {
    buf.extend_from_slice(b"{\"ok\":false,\"error\":");
    write_json_string(buf, error);
    buf.push(b'}');
}

/// Append `s` as a JSON string literal (quotes included), byte-identical to
/// `serde_json::to_writer(&mut buf, &s)`. A path is short, so a plain
/// byte-wise scan over the escape table beats the SWAR word skip piread
/// needs for megabyte contents.
fn write_json_string(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    for &byte in s.as_bytes() {
        match ESCAPE[byte as usize] {
            0 => buf.push(byte),
            esc => push_escape(buf, esc, byte),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    /// Derive mirror of the hand-rolled success line (parity reference).
    #[derive(Serialize)]
    struct Success<'a> {
        ok: bool,
        path: &'a str,
        bytes: u64,
    }

    /// Derive mirror of the hand-rolled failure line (parity reference).
    #[derive(Serialize)]
    struct Failure<'a> {
        ok: bool,
        error: &'a str,
    }

    #[test]
    fn success_line_matches_serde_json() {
        assert_eq!(
            ok_line("a/b/c.txt", 42),
            serde_json::to_string(&Success {
                ok: true,
                path: "a/b/c.txt",
                bytes: 42,
            })
            .unwrap()
        );
    }

    #[test]
    fn failure_line_matches_serde_json() {
        assert_eq!(
            fail_line("not a directory: \"x\"\n"),
            serde_json::to_string(&Failure {
                ok: false,
                error: "not a directory: \"x\"\n",
            })
            .unwrap()
        );
    }

    #[test]
    fn escapes_match_serde_json_for_every_single_byte_string() {
        for b in 0u8..=0x7f {
            let s = (b as char).to_string();
            let mut hand = Vec::new();
            write_json_string(&mut hand, &s);
            assert_eq!(
                hand,
                serde_json::to_string(&s).unwrap().as_bytes(),
                "byte {b:#04x}"
            );
        }
    }

    #[test]
    fn escapes_match_serde_json_on_hostile_strings() {
        for s in [
            "we\"ird\\path.txt",
            "nl\ninside\ttab\r\u{8}\u{c}",
            "\u{7f}del\u{1f600}emoji\u{e9}",
            "plain/path",
            "",
        ] {
            let mut hand = Vec::new();
            write_json_string(&mut hand, s);
            assert_eq!(hand, serde_json::to_string(s).unwrap().as_bytes(), "{s:?}");
        }
    }

    #[test]
    fn every_escape_class_appears_in_a_full_line() {
        let hostile = "a\"b\\c\nd\te\rf\u{8}g\u{c}h\u{1f}i";
        assert_eq!(
            ok_line(hostile, 7),
            serde_json::to_string(&Success {
                ok: true,
                path: hostile,
                bytes: 7,
            })
            .unwrap()
        );
    }
}
