//! --serve: persistent NDJSON daemon. One request per line, one (or, for a
//! streaming request, several) response lines, id echoed so a client can match
//! replies and start/partial lines so it can cancel and display live output.

use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use crate::accumulator::OutputAccumulator;
use crate::cli::Request;
use crate::execute_observed;
use crate::execute_with;
use crate::runner::RunObserver;

#[derive(serde::Deserialize)]
struct ServeRequest {
    id: serde_json::Value,
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout: Option<f64>,
    /// Full child environment from the extension. Absent means inherit.
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    /// Emit started/partial lines so the client can cancel and stream output.
    #[serde(default)]
    stream: bool,
}

/// Partial-update throttle, matching the built-in's BASH_UPDATE_THROTTLE_MS.
const UPDATE_THROTTLE: Duration = Duration::from_millis(100);

/// Read requests until stdin closes; never exits on a per-line error.
pub fn run() -> Result<(), String> {
    // Own process group: the daemon runs command trees, and pibash's own
    // kill_tree signals the child's group. Sharing the client's group meant a
    // timeout kill could reach the daemon itself.
    crate::procgroup::isolate_process_group("pibash");
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdin
            .lock()
            .read_line(&mut line)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        let mut out = stdout.lock();
        handle_line(&line, &mut out);
        let _ = out.flush();
    }
}

/// Writes the started/partial lines for a streaming request, throttled like the
/// built-in. The daemon is serial, so it owns stdout outright and needs no lock.
struct StreamObserver<'a> {
    out: &'a mut dyn Write,
    id_json: String,
    last_emit: Instant,
}

impl StreamObserver<'_> {
    fn line(&mut self, body: &[u8]) {
        let _ = self.out.write_all(b"{\"id\":");
        let _ = self.out.write_all(self.id_json.as_bytes());
        let _ = self.out.write_all(b",\"partial\":true,");
        let _ = self.out.write_all(body);
        let _ = self.out.write_all(b"}\n");
        let _ = self.out.flush();
    }
}

impl RunObserver for StreamObserver<'_> {
    fn started(&mut self, pid: u32) {
        let body = format!("\"pid\":{pid},\"started\":true");
        self.line(body.as_bytes());
    }

    fn update(&mut self, accumulator: &mut OutputAccumulator) {
        if self.last_emit.elapsed() < UPDATE_THROTTLE {
            return;
        }
        self.last_emit = Instant::now();
        let mut snapshot = accumulator.snapshot(false);
        // The display text already carries this prefix; drop it on the wire.
        snapshot.truncation.content = String::new();
        let mut body = Vec::with_capacity(snapshot.content.len() + 128);
        body.extend_from_slice(b"\"text\":");
        let _ = serde_json::to_writer(&mut body, &snapshot.content);
        if snapshot.truncation.truncated {
            body.extend_from_slice(b",\"truncation\":");
            let _ = serde_json::to_writer(&mut body, &snapshot.truncation);
        }
        if let Some(path) = snapshot.full_output_path.as_ref() {
            body.extend_from_slice(b",\"fullOutputPath\":");
            let _ = serde_json::to_writer(&mut body, &path.to_string_lossy());
        }
        self.line(&body);
    }
}

/// One request line to one final response line (plus any streamed partials).
/// Serializes straight into the writer: the previous shape built a
/// serde_json::Value tree and then re-serialized it, copying the whole
/// (potentially hundreds-of-KB) payload twice for no benefit.
fn handle_line(line: &str, out: &mut dyn Write) {
    let parsed: ServeRequest = match serde_json::from_str(line) {
        Ok(parsed) => parsed,
        Err(err) => {
            let failure = serde_json::json!({
                "id": serde_json::Value::Null,
                "ok": false,
                "error": { "kind": "protocol", "message": err.to_string() }
            });
            let _ = serde_json::to_writer(&mut *out, &failure);
            let _ = out.write_all(b"\n");
            return;
        }
    };
    let request = Request {
        command: parsed.command,
        cwd: parsed
            .cwd
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
            }),
        timeout_seconds: parsed.timeout.filter(|secs| *secs > 0.0),
        env: parsed.env,
    };
    let id_json = serde_json::to_string(&parsed.id).unwrap_or_else(|_| "null".to_string());
    let result = if parsed.stream {
        let mut observer = StreamObserver {
            out: &mut *out,
            id_json: id_json.clone(),
            last_emit: Instant::now(),
        };
        execute_observed(&request, true, &mut observer)
    } else {
        execute_with(&request, true)
    };
    // Splice the echoed id in after the opening brace.
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    buf.extend_from_slice(b"{\"id\":");
    buf.extend_from_slice(id_json.as_bytes());
    match result {
        Ok(success) => {
            let mut body = Vec::with_capacity(1024);
            let _ = serde_json::to_writer(&mut body, &success);
            // body[0] is '{'; append everything after it.
            buf.push(b',');
            buf.extend_from_slice(&body[1..]);
        }
        Err(failure) => {
            let mut body = Vec::with_capacity(256);
            let _ = serde_json::to_writer(&mut body, &failure);
            buf.push(b',');
            buf.extend_from_slice(&body[1..]);
        }
    }
    buf.push(b'\n');
    let _ = out.write_all(&buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle_to_string(line: &str) -> String {
        let mut out = Vec::new();
        handle_line(line, &mut out);
        String::from_utf8(out).expect("valid utf8")
    }

    #[test]
    fn malformed_line_yields_a_protocol_error_and_echoes_null_id() {
        let response = handle_to_string("not json");
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["ok"], serde_json::Value::Bool(false));
        assert_eq!(value["error"]["kind"], "protocol");
        assert!(value["id"].is_null());
    }

    #[test]
    fn request_id_is_echoed_on_success() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let line = format!(
            r#"{{"id":7,"command":"printf ok","cwd":"{cwd}"}}"#
        );
        let value: serde_json::Value = serde_json::from_str(&handle_to_string(&line)).unwrap();
        assert_eq!(value["id"], serde_json::json!(7));
        assert_eq!(value["ok"], serde_json::Value::Bool(true));
        assert_eq!(value["text"], "ok");
    }

    #[test]
    fn request_id_is_echoed_on_failure() {
        let line = r#"{"id":"a","command":"echo x","cwd":"/definitely/not/here"}"#;
        let value: serde_json::Value = serde_json::from_str(&handle_to_string(line)).unwrap();
        assert_eq!(value["id"], serde_json::json!("a"));
        assert_eq!(value["ok"], serde_json::Value::Bool(false));
    }

    #[test]
    fn env_field_is_forwarded_to_the_command() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let line = format!(
            r#"{{"id":1,"command":"printf '%s' \"$PIBASH_TEST\"","cwd":"{cwd}","env":{{"PATH":"/usr/bin:/bin","PIBASH_TEST":"yes"}}}}"#
        );
        let value: serde_json::Value = serde_json::from_str(&handle_to_string(&line)).unwrap();
        assert_eq!(value["text"], "yes");
    }

    #[test]
    fn zero_timeout_is_treated_as_no_timeout() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let line = format!(r#"{{"id":1,"command":"printf ok","cwd":"{cwd}","timeout":0}}"#);
        let value: serde_json::Value = serde_json::from_str(&handle_to_string(&line)).unwrap();
        assert_eq!(value["ok"], serde_json::Value::Bool(true));
        assert_eq!(value["text"], "ok");
    }

    #[test]
    fn streaming_request_emits_a_started_line_with_the_pid() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let line = format!(
            r#"{{"id":5,"command":"printf hi","cwd":"{cwd}","stream":true}}"#
        );
        let text = handle_to_string(&line);
        let mut lines = text.lines();
        let started: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(started["id"], serde_json::json!(5));
        assert_eq!(started["partial"], serde_json::Value::Bool(true));
        assert_eq!(started["started"], serde_json::Value::Bool(true));
        assert!(started["pid"].is_number());
        let final_line: serde_json::Value =
            serde_json::from_str(lines.next().expect("final line")).unwrap();
        assert_eq!(final_line["ok"], serde_json::Value::Bool(true));
        assert_eq!(final_line["text"], "hi");
    }

    #[test]
    fn streaming_request_emits_output_partials_past_the_throttle() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        // The sleep pushes output past the 100 ms throttle, forcing a partial.
        let line = format!(
            r#"{{"id":9,"command":"printf a; sleep 0.15; printf b","cwd":"{cwd}","stream":true}}"#
        );
        let text = handle_to_string(&line);
        let partials: Vec<serde_json::Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v["partial"] == serde_json::Value::Bool(true))
            .collect();
        assert!(partials.iter().any(|p| p["started"] == true));
        assert!(
            partials
                .iter()
                .any(|p| p["text"].as_str().is_some_and(|t| t.contains('a'))),
            "expected a partial with text: {text}"
        );
    }
}
