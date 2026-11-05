//! Daemon contract v2: `piwrite --serve` — raw length-prefixed framing over
//! stdio. A request is one header line `{"path":<string>,"bytes":<u64>}`
//! followed IMMEDIATELY by exactly `bytes` raw body bytes (binary-safe, no
//! trailing newline; the next header follows the body directly). One ok
//! response per request, in request order; the daemon exits 0 on EOF at a
//! header boundary, 0 after a truncated-body error, 1 on malformed framing.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn scratch(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "piwrite-serve2-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Build one v2 request: header line + exactly `bytes` raw body bytes.
fn request(path: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "{{\"path\":{},\"bytes\":{}}}\n",
        serde_json::to_string(path).expect("serialize path"),
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

/// Feed `input` raw bytes to one daemon, close stdin, collect stdout text
/// and the exit code.
fn serve_raw(input: &[u8]) -> (String, Option<i32>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_piwrite"))
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn piwrite --serve");
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(input)
        .expect("write requests");
    // The taken stdin drops here: the pipe closes and the daemon sees EOF.
    let out = child.wait_with_output().expect("wait for daemon");
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        out.status.code(),
    )
}

fn responses(text: &str) -> Vec<Value> {
    text.lines()
        .map(|l| serde_json::from_str(l).expect("each response line is JSON"))
        .collect()
}

fn ok_line(path: &str, bytes: u64) -> String {
    format!(
        "{{\"ok\":true,\"path\":{},\"bytes\":{bytes}}}",
        serde_json::to_string(path).expect("serialize path")
    )
}

#[test]
fn round_trips_pipelined_requests_until_eof() {
    let one = scratch("rt").join("one.bin");
    let two = scratch("rt").join("deep/sub/two.txt"); // parents do not exist
    let body_one: &[u8] = &[b'a', b'\n', 0x00, 0xFF, b'}', b'{', b'\n'];
    let mut input = request(one.to_str().expect("utf-8 path"), body_one);
    input.extend_from_slice(&request(two.to_str().expect("utf-8 path"), b"second"));
    let (text, code) = serve_raw(&input);
    assert_eq!(code, Some(0), "EOF at a header boundary exits 0");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "one response per request, in order: {text}");
    assert_eq!(
        lines[0],
        ok_line(one.to_str().expect("utf-8 path"), body_one.len() as u64)
    );
    assert_eq!(lines[1], ok_line(two.to_str().expect("utf-8 path"), 6));
    assert_eq!(fs::read(&one).expect("written"), body_one);
    assert_eq!(fs::read(&two).expect("written"), b"second");
}

#[test]
fn zero_byte_body_creates_empty_file() {
    let f = scratch("zero").join("e.txt");
    let input = request(f.to_str().expect("utf-8 path"), b"");
    let (text, code) = serve_raw(&input);
    assert_eq!(code, Some(0));
    assert_eq!(text, format!("{}\n", ok_line(f.to_str().expect("utf-8 path"), 0)));
    assert_eq!(fs::read(&f).expect("written"), b"");
}

#[test]
fn unicode_path_round_trips() {
    let f = scratch("uni").join("héllo/世界.txt");
    let path = f.to_str().expect("utf-8 path");
    let (text, code) = serve_raw(&request(path, "héllo\n".as_bytes()));
    assert_eq!(code, Some(0));
    assert_eq!(text, format!("{}\n", ok_line(path, 7)));
    assert_eq!(fs::read(&f).expect("written"), "héllo\n".as_bytes());
}

#[test]
fn truncated_body_is_error_and_exit_zero() {
    let f = scratch("trunc").join("partial.bin");
    let path = f.to_str().expect("utf-8 path");
    // Header promises 10 bytes; only 5 arrive before EOF.
    let mut input = request(path, b"          ");
    input.truncate(input.len() - 5);
    let (text, code) = serve_raw(&input);
    assert_eq!(code, Some(0), "truncated body exits 0");
    assert_eq!(text, "{\"ok\":false,\"error\":\"truncated body\"}\n");
    // Partial bytes may already be on disk — the doc contract says so.
    assert_eq!(fs::read(&f).unwrap_or_default(), b"     ");
}

#[test]
fn malformed_header_is_error_and_exit_one() {
    let (text, code) = serve_raw(b"garbage\n");
    assert_eq!(code, Some(1), "framing is unrecoverable");
    assert!(text.starts_with("{\"ok\":false,\"error\":\""), "{text}");
}

#[test]
fn bad_headers_exit_one_without_reading_a_body() {
    let f = scratch("bad").join("f.txt");
    let path = f.to_str().expect("utf-8 path");
    // Each header is a complete line: the daemon must reject at parse time,
    // before any body byte is owed.
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("missing bytes", format!("{}\n", json!({"path": path})).into_bytes()),
        (
            "string bytes",
            format!("{}\n", json!({"path": path, "bytes": "5"})).into_bytes(),
        ),
        (
            "float bytes",
            format!("{}\n", json!({"path": path, "bytes": 5.5})).into_bytes(),
        ),
        (
            "negative bytes",
            format!("{}\n", json!({"path": path, "bytes": -1})).into_bytes(),
        ),
        (
            "bytes over 2^40",
            format!("{}\n", json!({"path": path, "bytes": 1099511627777u64})).into_bytes(),
        ),
        ("empty line", b"\n".to_vec()),
        ("not json", b"{oops\n".to_vec()),
    ];
    for (label, input) in cases {
        let (text, code) = serve_raw(&input);
        assert_eq!(code, Some(1), "{label}: must exit 1");
        assert!(text.starts_with("{\"ok\":false,\"error\":\""), "{label}: {text}");
    }
}

#[test]
fn partial_header_at_eof_is_error_and_exit_one() {
    // EOF inside a header line (no terminating newline) is malformed framing,
    // not a clean boundary.
    let (text, code) = serve_raw(b"{\"path\":\"/tmp/pw-x.txt\",\"bytes\":3");
    assert_eq!(code, Some(1));
    assert!(text.starts_with("{\"ok\":false,\"error\":\""), "{text}");
}

#[test]
fn io_failure_drains_body_and_continues() {
    let dir = scratch("iofail").join("d");
    fs::create_dir_all(&dir).expect("mkdir");
    let good = scratch("iofail").join("good.txt");
    // The first body must be drained (not desync framing) before the second
    // request is parsed.
    let mut input = request(dir.to_str().expect("utf-8 path"), b"junk");
    input.extend_from_slice(&request(good.to_str().expect("utf-8 path"), b"still alive"));
    let (text, code) = serve_raw(&input);
    assert_eq!(code, Some(0));
    let responses = responses(&text);
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0], json!({"ok": false, "error": "Is a directory (os error 21)"}));
    assert_eq!(responses[1]["ok"], json!(true));
    assert_eq!(fs::read(&good).expect("written"), b"still alive");
}

#[test]
fn body_larger_than_the_default_pipe_round_trips() {
    // 200 KB of cycled bytes: larger than the kernel's 64 KiB default pipe
    // buffer, so the write side blocks until the daemon drains — the shape
    // real feeders hit.
    let f = scratch("big").join("big.bin");
    let body: Vec<u8> = (0..=255u8).cycle().take(200_000).collect();
    let input = request(f.to_str().expect("utf-8 path"), &body);
    let (text, code) = serve_raw(&input);
    assert_eq!(code, Some(0));
    assert!(text.starts_with("{\"ok\":true,"), "{text}");
    assert_eq!(fs::read(&f).expect("written"), body);
}

// Linux `fcntl(fd, F_GETPIPE_SZ)`: the pipe's capacity in bytes. The pipe
// size is a property of the pipe itself, so the parent can observe what
// the daemon did to the shared stdin pipe from its own write end.
#[cfg(target_os = "linux")]
unsafe extern "C" {
    #[link_name = "fcntl"]
    fn libc_fcntl(fd: i32, cmd: i32, ...) -> i32;
}

#[cfg(target_os = "linux")]
fn pipe_size(fd: i32) -> i32 {
    const F_GETPIPE_SZ: i32 = 1032;
    // SAFETY: a pure capacity query on a live fd; no pointers.
    let rc = unsafe { libc_fcntl(fd, F_GETPIPE_SZ) };
    assert!(rc > 0, "F_GETPIPE_SZ failed: {}", std::io::Error::last_os_error());
    rc
}

#[cfg(target_os = "linux")]
#[test]
fn serve_grows_the_stdin_pipe_to_the_read_buffer_size() {
    use std::io::BufRead;
    use std::os::fd::AsRawFd;
    let f = scratch("pipesz").join("f.txt");
    let path = f.to_str().expect("utf-8 path").to_owned();
    let mut child = Command::new(env!("CARGO_BIN_EXE_piwrite"))
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn piwrite --serve");
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    // One tiny request/response round trip proves the daemon is past
    // startup, so the pipe resize has already been attempted.
    stdin
        .write_all(request(&path, b"").as_slice())
        .expect("write request");
    let mut line = String::new();
    let mut reader = std::io::BufReader::new(stdout);
    reader.read_line(&mut line).expect("read response");
    assert!(line.starts_with("{\"ok\":true,"), "{line}");
    let size = pipe_size(stdin.as_raw_fd());
    assert!(size >= 1 << 20, "stdin pipe still at {size} bytes");
    drop(stdin); // EOF at a header boundary
    drop(reader);
    let out = child.wait_with_output().expect("wait for daemon");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&f).expect("written"), b"");
}
