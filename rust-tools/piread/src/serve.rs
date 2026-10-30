//! Daemon mode (`piread --serve`): newline-delimited JSON over stdio.
//!
//! Protocol: each stdin line is one JSON request; each request produces
//! exactly one response line on stdout — the same envelope the one-shot CLI
//! prints, prefixed with the echoed request `id`. The extension keeps one
//! daemon alive across read calls to amortize the process-spawn cost (the
//! dominant per-call overhead, per the Step 6 micro-bench); stdin EOF —
//! parent exit, closed pipe — terminates the daemon cleanly.
//!
//! Requests are processed serially in arrival order; the `id` echo lets the
//! client match responses under concurrency. Request failures are per-line
//! error envelopes (never process failures); only transport loss (crash,
//! EOF) is a client-side failure, and the extension's daemon → one-shot
//! ladder covers it.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::Value;

use crate::envelope::{write_fail_with_id, write_success_with_id, ErrorKind};
use crate::pipeline;
use crate::ToolError;

/// One request line. Unknown fields are ignored (liberal in what we accept);
/// `id` is echoed verbatim so the client can use any JSON value.
#[derive(Deserialize)]
struct Request {
    id: Value,
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
    /// Per-line char cap; absent = no cap (byte parity with the built-in).
    #[serde(default)]
    line_cap: Option<u64>,
    /// Fused locate+read needle (`--hits`); absent = paged window read.
    #[serde(default)]
    hits: Option<String>,
    /// Directory relative paths resolve against (default: process cwd).
    cwd: Option<String>,
}

/// Serve until stdin EOF or an unwritable stdout (parent gone). Always exits
/// 0: per-request failures are error envelopes, not process failures.
pub fn serve() -> ExitCode {
    // Own process group: a group-wide kill from the client's group (pibash's
    // kill_tree, job control, CI timeout) must not take the daemon down.
    crate::procgroup::isolate_process_group("piread");
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    // One response buffer reused across requests (capacity ratchets to the
    // largest response seen): serialize in place, append the newline, emit
    // with a single write — no per-response String, no re-growth.
    let mut buf = Vec::with_capacity(16 * 1024);
    // The request line is reused the same way: `lines()` would allocate a
    // fresh String per request.
    let mut stdin = stdin.lock();
    let mut line = String::with_capacity(4 * 1024);
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) | Err(_) => break, // EOF or unreadable stdin: same as EOF
            Ok(_) => {}
        }
        let req = line.trim_end();
        if req.is_empty() {
            continue;
        }
        buf.clear();
        respond_into(req, &mut buf);
        buf.push(b'\n');
        if out.write_all(&buf).and_then(|_| out.flush()).is_err() {
            break; // stdout closed: parent went away, same as EOF
        }
    }
    ExitCode::SUCCESS
}

/// Parse one request line into a response written to `buf`.
fn respond_into(line: &str, buf: &mut Vec<u8>) {
    if let Ok(req) = serde_json::from_str::<Request>(line) {
        return handle_into(&req, buf);
    }
    // Failure path only: parse loosely, so a malformed request can still echo
    // its id back and the message class stays "not JSON" vs "bad request".
    // The common path parses the request exactly once.
    match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            let id = value.get("id").cloned();
            match serde_json::from_value::<Request>(value) {
                Ok(req) => handle_into(&req, buf),
                Err(err) => protocol_error(id.as_ref(), &format!("bad request: {err}"), buf),
            }
        }
        Err(err) => protocol_error(None, &format!("not JSON: {err}"), buf),
    }
}

/// Run one well-formed request through the same pipeline as one-shot mode.
fn handle_into(req: &Request, buf: &mut Vec<u8>) {
    if let Some(err) = validate(req) {
        return write_fail_with_id(buf, Some(&req.id), &err);
    }
    let base = req.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("/"))
            .to_string_lossy()
            .into_owned()
    });
    let resolved = pipeline::resolve_path_against(&req.path, &base);
    let read = match &req.hits {
        Some(needle) => crate::locate::read_hits(&resolved, &req.path, needle, req.line_cap),
        None => pipeline::read_text_compacted(&resolved, &req.path, req.offset, req.limit, req.line_cap),
    };
    match read {
        Ok(out) => write_success_with_id(
            buf,
            Some(&req.id),
            &out.content,
            out.truncation.as_ref(),
            out.binary,
            out.total_bytes,
            out.compaction.as_ref(),
            out.locate.as_ref(),
        ),
        Err(err) => write_fail_with_id(buf, Some(&req.id), &err),
    }
}

/// Mirror the CLI contract: offset/limit, when present, are integers ≥ 1
/// (the extension screens the tool-level 0/negative/non-integer semantics to
/// the built-in before dispatching, so this is defense in depth).
fn validate(req: &Request) -> Option<ToolError> {
    for (name, value) in [("offset", req.offset), ("limit", req.limit)] {
        if value.is_some_and(|v| v == 0) {
            return Some(ToolError {
                kind: ErrorKind::Usage,
                message: format!("{name} must be an integer ≥ 1"),
            });
        }
    }
    if req.hits.as_deref() == Some("") {
        return Some(ToolError {
            kind: ErrorKind::Usage,
            message: "hits must be non-empty".to_string(),
        });
    }
    if req.hits.is_some() && (req.offset.is_some() || req.limit.is_some()) {
        return Some(ToolError {
            kind: ErrorKind::Usage,
            message: "hits cannot combine with offset/limit".to_string(),
        });
    }
    None
}

fn protocol_error(id: Option<&Value>, message: &str, buf: &mut Vec<u8>) {
    write_fail_with_id(
        buf,
        id,
        &ToolError {
            kind: ErrorKind::Protocol,
            message: message.to_string(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::respond_into;

    /// One fixture file per test: the tests run in parallel threads, and a
    /// shared path would let one test's `fs::write` (which truncates first)
    /// be read mid-write by another — an intermittent empty body.
    fn tmp_fixture(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "piread-serve-{}-hits-{tag}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("f");
        std::fs::write(&file, "a\nsym here\nb\n").expect("fixture write");
        file.to_string_lossy().into_owned()
    }

    fn respond(line: &str) -> String {
        let mut buf = Vec::new();
        respond_into(line, &mut buf);
        String::from_utf8(buf).expect("utf-8")
    }

    #[test]
    fn hits_request_routes_to_fused_read() {
        let f = tmp_fixture("fused");
        let out = respond(&format!(r#"{{"id":1,"path":{f:?},"hits":"sym"}}"#));
        assert!(out.contains(r#""ok":true"#), "{out}");
        assert!(out.contains(r#""locate":{"needle":"sym""#), "{out}");
        assert!(out.contains("2:sym here"), "{out}");
    }

    #[test]
    fn hits_with_paging_flags_is_rejected() {
        let f = tmp_fixture("paging");
        let out = respond(&format!(r#"{{"id":2,"path":{f:?},"hits":"sym","offset":1}}"#));
        assert!(out.contains(r#""ok":false"#), "{out}");
        assert!(out.contains("hits cannot combine"), "{out}");
        let out = respond(&format!(r#"{{"id":3,"path":{f:?},"hits":"sym","limit":4}}"#));
        assert!(out.contains("hits cannot combine"), "{out}");
    }

    #[test]
    fn empty_hits_needle_is_rejected() {
        let f = tmp_fixture("empty");
        let out = respond(&format!(r#"{{"id":4,"path":{f:?},"hits":""}}"#));
        assert!(out.contains(r#""ok":false"#), "{out}");
        assert!(out.contains("non-empty"), "{out}");
    }
}
