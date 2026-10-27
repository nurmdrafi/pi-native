//! Integration tests for daemon mode (`--serve`): NDJSON request/response
//! over stdio, id echo, per-line error envelopes, cwd resolution, EOF exit.
//!
//! Envelope payload parity with one-shot mode is oracle-pinned by the
//! harness suite tests/piread-parity.test.mjs; these tests pin the protocol.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_piread");

/// A live daemon: write request lines, read one response line per request.
struct Daemon {
    child: Child,
}

impl Daemon {
    fn start() -> Daemon {
        let child = Command::new(BIN)
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn piread --serve");
        Daemon { child }
    }

    /// Send one request line, read one response line (responses are strictly
    /// ordered, one per request, so paired read-after-write is deterministic).
    fn roundtrip(&mut self, request: &str) -> Value {
        let stdin = self.child.stdin.as_mut().expect("stdin pipe");
        writeln!(stdin, "{request}").expect("write request");
        stdin.flush().expect("flush request");
        let stdout = self.child.stdout.as_mut().expect("stdout pipe");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read response");
        serde_json::from_str(line.trim()).expect("response is one JSON object")
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        // Closing stdin (Drop of the pipe) signals EOF; reap the child.
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

fn fixture(name: &str, body: &str) -> String {
    let dir = std::env::temp_dir().join(format!("piread-serve-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let file = dir.join("f.txt");
    std::fs::write(&file, body).expect("fixture write");
    file.to_string_lossy().into_owned()
}

// NOTE: tests share one daemon where convenient; each `roundtrip` is
// independent (id echo + strict ordering), so cross-test state is only the
// monotone id counter local to each test.

#[test]
fn serves_success_envelope_with_id_echo() {
    let path = fixture("ok", "hello\ndaemon\n");
    let mut d = Daemon::start();
    let resp = d.roundtrip(&format!(r#"{{"id":7,"path":{}}}"#, serde_json::to_string(&path).unwrap()));
    assert_eq!(resp["id"], 7);
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["content"], "hello\ndaemon\n");
    assert_eq!(resp["binary"], false);
    assert_eq!(resp["truncation"], Value::Null);
    assert_eq!(resp["totalBytes"], 13);
}

#[test]
fn id_is_echoed_verbatim_for_any_json_value() {
    let path = fixture("ids", "x\n");
    let mut d = Daemon::start();
    let resp = d.roundtrip(&format!(r#"{{"id":"tag-42","path":{}}}"#, serde_json::to_string(&path).unwrap()));
    assert_eq!(resp["id"], "tag-42");
    assert_eq!(resp["ok"], true);
}

#[test]
fn serves_error_envelope_for_missing_file() {
    let mut d = Daemon::start();
    let resp = d.roundtrip(r#"{"id":2,"path":"/nonexistent/piread-serve"}"#);
    assert_eq!(resp["id"], 2);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["kind"], "ENOENT");
}

#[test]
fn daemon_envelope_matches_one_shot_cli() {
    let body: Vec<String> = (0..30).map(|i| format!("L{i}")).collect();
    let path = fixture("window", &body.join("\n"));
    // one-shot reference for the same read
    let oneshot = Command::new(BIN)
        .args(["--path", &path, "--offset", "10", "--limit", "5"])
        .output()
        .expect("one-shot piread");
    let mut expected: Value =
        serde_json::from_slice(&oneshot.stdout).expect("one-shot envelope");
    // window reads render the tail note but set no truncateHead truncation
    assert_eq!(expected["truncation"], Value::Null);
    assert!(expected["content"]
        .as_str()
        .expect("content")
        .contains("[16 more lines in file. Use offset=15 to continue.]"));

    let mut d = Daemon::start();
    let req = format!(
        r#"{{"id":3,"path":{},"offset":10,"limit":5}}"#,
        serde_json::to_string(&path).unwrap()
    );
    let resp = d.roundtrip(&req);
    let mut actual = resp.clone();
    // `id` is the daemon-only field; neutralize on both sides for comparison
    actual["id"] = Value::Null;
    expected["id"] = Value::Null;
    assert_eq!(actual, expected, "daemon envelope must equal one-shot envelope");
}

#[test]
fn malformed_line_gets_protocol_error_and_loop_continues() {
    let path = fixture("continue", "still alive\n");
    let mut d = Daemon::start();
    let bad = d.roundtrip("this is not json");
    assert_eq!(bad["id"], Value::Null);
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["error"]["kind"], "protocol");

    let missing_fields = d.roundtrip(r#"{"nope":1}"#);
    assert_eq!(missing_fields["ok"], false);
    assert_eq!(missing_fields["error"]["kind"], "protocol");

    // the daemon keeps serving after both
    let ok = d.roundtrip(&format!(r#"{{"id":9,"path":{}}}"#, serde_json::to_string(&path).unwrap()));
    assert_eq!(ok["id"], 9);
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["content"], "still alive\n");
}

#[test]
fn blank_lines_are_ignored_without_response() {
    let path = fixture("blank", "x\n");
    let mut d = Daemon::start();
    let stdin = d.child.stdin.as_mut().expect("stdin pipe");
    writeln!(stdin).unwrap();
    writeln!(stdin, "   ").unwrap();
    stdin.flush().unwrap();
    let resp = d.roundtrip(&format!(r#"{{"id":1,"path":{}}}"#, serde_json::to_string(&path).unwrap()));
    assert_eq!(resp["ok"], true); // no stray responses for the blank lines
}

#[test]
fn offset_zero_is_a_usage_error() {
    let path = fixture("zero", "x\n");
    let mut d = Daemon::start();
    let req = format!(
        r#"{{"id":5,"path":{},"offset":0}}"#,
        serde_json::to_string(&path).unwrap()
    );
    let resp = d.roundtrip(&req);
    assert_eq!(resp["id"], 5);
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["error"]["kind"], "usage");
}

#[test]
fn relative_path_resolves_against_request_cwd() {
    let dir = std::env::temp_dir().join(format!("piread-serve-{}-cwd", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    std::fs::write(dir.join("rel.txt"), "relative content\n").expect("fixture write");
    let req = format!(
        r#"{{"id":11,"path":"rel.txt","cwd":{}}}"#,
        serde_json::to_string(&dir.to_string_lossy()).unwrap()
    );
    let mut d = Daemon::start();
    let resp = d.roundtrip(&req);
    assert_eq!(resp["id"], 11);
    assert_eq!(resp["ok"], true, "got: {resp}");
    assert_eq!(resp["content"], "relative content\n");
}

#[test]
fn stdin_eof_exits_zero() {
    let mut d = Daemon::start();
    drop(d.child.stdin.take()); // EOF
    let status = d.child.wait().expect("wait for exit");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn unknown_request_fields_are_ignored() {
    let path = fixture("unknown", "y\n");
    let mut d = Daemon::start();
    let req = format!(
        r#"{{"id":21,"path":{},"futureField":"ignored"}}"#,
        serde_json::to_string(&path).unwrap()
    );
    let resp = d.roundtrip(&req);
    assert_eq!(resp["id"], 21);
    assert_eq!(resp["ok"], true);
}

#[test]
fn many_sequential_requests_on_one_daemon() {
    let path = fixture("seq", "n\n");
    let mut d = Daemon::start();
    for id in 0..50 {
        let req = format!(
            r#"{{"id":{id},"path":{}}}"#,
            serde_json::to_string(&path).unwrap()
        );
        let resp = d.roundtrip(&req);
        assert_eq!(resp["id"], id, "id mismatch at {id}");
        assert_eq!(resp["ok"], true, "failed at {id}");
        assert_eq!(resp["content"], "n\n");
    }
}
