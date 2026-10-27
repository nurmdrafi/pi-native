//! Daemon mode (`piedit --serve`): newline-delimited JSON over stdio.
//!
//! Protocol: each stdin line is one JSON request; each request produces
//! exactly one response line on stdout — the same envelope the one-shot CLI
//! prints, prefixed with the echoed request `id`. With `renderDiff: true`
//! the response is the rendered `{diff, patch, firstChangedLine}` shape
//! (no content crossing the boundary); otherwise the legacy
//! `{baseContent, newContent}` shape. The extension keeps one daemon alive
//! across edit calls to amortize the process-spawn cost; stdin EOF — parent
//! exit, closed pipe — terminates the daemon cleanly.
//!
//! Requests are processed serially in arrival order; the `id` echo lets the
//! client match responses under concurrency. Request failures are per-line
//! error envelopes (never process failures); only transport loss (crash,
//! EOF) is a client-side failure, and the extension's fail-open ladder
//! (one-shot spawn → built-in) covers it.
//!
//! Hot path: one `read_until` into a reused byte buffer per request (no
//! per-line String), one `serde_json` parse of that line (the id is a
//! request field; a second parse happens only on the malformed-request
//! error path), and one reused response buffer flushed with a single write.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::Value;

use crate::ToolError;
use crate::envelope::{ErrorKind, write_fail_with_id, write_success_rendered_with_id, write_success_with_id};
use crate::pipeline;

/// One request line. Unknown fields are ignored (liberal in what we accept);
/// `id` is echoed verbatim so the client can use any JSON value.
#[derive(Deserialize)]
struct Request {
    id: Option<Value>,
    path: String,
    /// Absolute path I/O acts on (the extension resolves against ctx.cwd).
    /// Absent = use `path` verbatim (one-shot CLI compatibility).
    resolved: Option<String>,
    edits: Vec<crate::envelope::Edit>,
    /// Rendered-response fast path (see the module docs).
    #[serde(rename = "renderDiff", default)]
    render_diff: Option<bool>,
}

/// Serve until stdin EOF or an unwritable stdout (parent gone). Always exits
/// 0: per-request failures are error envelopes, not process failures.
pub fn serve() -> ExitCode {
    // Own process group: a group-wide kill from the client's group must not
    // take the daemon down.
    crate::procgroup::isolate_process_group("piedit");
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    // One response buffer reused across requests (capacity ratchets to the
    // largest response seen): serialize in place, append the newline, emit
    // with a single write — no per-response String, no re-growth.
    let mut buf = Vec::with_capacity(16 * 1024);
    // One request-line buffer reused across requests: `read_until` appends,
    // so a line costs no allocation once the capacity has ratcheted up.
    let mut line_buf = Vec::with_capacity(16 * 1024);
    loop {
        line_buf.clear();
        match reader.read_until(b'\n', &mut line_buf) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break, // unreadable stdin: treat as EOF
        }
        // Strip the terminator (`\n`, and a `\r` before it for CRLF clients).
        if line_buf.last() == Some(&b'\n') {
            line_buf.pop();
            if line_buf.last() == Some(&b'\r') {
                line_buf.pop();
            }
        }
        if line_buf.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let line = match std::str::from_utf8(&line_buf) {
            Ok(s) => s,
            Err(err) => {
                buf.clear();
                respond_protocol_error(&mut buf, None, &format!("not UTF-8: {err}"));
                emit(&mut out, &mut buf);
                continue;
            }
        };
        buf.clear();
        respond_into(line, &mut buf);
        if !emit(&mut out, &mut buf) {
            break; // stdout closed: parent went away, same as EOF
        }
    }
    ExitCode::SUCCESS
}

/// Append the newline and flush; `false` = stdout gone.
fn emit(out: &mut io::StdoutLock<'_>, buf: &mut Vec<u8>) -> bool {
    buf.push(b'\n');
    out.write_all(buf).and_then(|_| out.flush()).is_ok()
}

/// Parse one request line into a response written to `buf`.
fn respond_into(line: &str, buf: &mut Vec<u8>) {
    // Single parse: `id` is a request field, so the happy path never pays a
    // second pass. Only malformed requests re-parse (for the id echo).
    match serde_json::from_str::<Request>(line) {
        Ok(req) => handle_into(&req, buf),
        Err(err) => {
            let id = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| v.get("id").cloned());
            let message = match &id {
                Some(_) => format!("bad request: {err}"),
                None => format!("not JSON: {err}"),
            };
            respond_protocol_error(buf, id.as_ref(), &message);
        }
    }
}

/// Run one well-formed request through the same pipeline as one-shot mode.
fn handle_into(req: &Request, buf: &mut Vec<u8>) {
    if req.edits.is_empty() {
        return write_fail_with_id(
            buf,
            req.id.as_ref(),
            &ToolError {
                kind: ErrorKind::Usage,
                message:
                    "Edit tool input is invalid. edits must contain at least one replacement."
                        .into(),
            },
        );
    }
    let resolved = req.resolved.as_deref().unwrap_or(&req.path);
    if req.render_diff == Some(true) {
        match pipeline::edit_file_rendered(&req.path, resolved, &req.edits) {
            Ok(rendered) => write_success_rendered_with_id(buf, req.id.as_ref(), &rendered),
            Err(err) => write_fail_with_id(buf, req.id.as_ref(), &err),
        }
    } else {
        match pipeline::edit_file(&req.path, resolved, &req.edits) {
            Ok(applied) => {
                write_success_with_id(buf, req.id.as_ref(), &applied.base_content, &applied.new_content);
            }
            Err(err) => write_fail_with_id(buf, req.id.as_ref(), &err),
        }
    }
}

fn respond_protocol_error(buf: &mut Vec<u8>, id: Option<&Value>, message: &str) {
    write_fail_with_id(
        buf,
        id,
        &ToolError {
            kind: ErrorKind::Protocol,
            message: message.to_string(),
        },
    );
}
