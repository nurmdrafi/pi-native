//! One-shot CLI contract: `piwrite --path <P>` with raw stdin bytes.
//!
//! Byte parity is asserted exactly: the file must equal the stdin bytes (no
//! newline munging, binary-safe, invalid UTF-8 included) and stdout must be
//! the frozen envelope `{"ok":true,"path":…,"bytes":N}` plus one newline.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use serde_json::Value;

/// Unique scratch path per call; the tool under test creates the parents.
fn scratch(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "piwrite-oneshot-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Run bin/piwrite with `args`, feeding `input` as raw stdin bytes.
fn run(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_piwrite"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn piwrite");
    let mut stdin = child.stdin.take().expect("piped stdin");
    // The tool exits without draining stdin on usage/error paths; a broken
    // pipe here is the child rejecting input, not a transport failure.
    if let Err(e) = stdin.write_all(input) {
        assert_eq!(
            e.kind(),
            std::io::ErrorKind::BrokenPipe,
            "write stdin: {e}"
        );
    }
    // The taken stdin drops here: the pipe closes and the tool sees EOF.
    drop(stdin);
    child.wait_with_output().expect("wait for piwrite")
}

/// The frozen success envelope, built with serde_json so the expected path
/// escaping is itself the reference serialization.
fn ok_envelope(path: &str, bytes: u64) -> String {
    format!(
        "{{\"ok\":true,\"path\":{},\"bytes\":{bytes}}}\n",
        serde_json::to_string(path).expect("serialize path")
    )
}

/// Assert stdout is exactly one `ok:false` JSON line with a non-empty error;
/// returns the error string for optional substring checks.
fn fail_envelope(out: &Output) -> String {
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.trim_end();
    assert!(
        line.lines().count() <= 1,
        "expected one envelope line, got: {text:?}"
    );
    let v: Value = serde_json::from_str(line).expect("stdout is one JSON line");
    assert_eq!(v["ok"], Value::Bool(false), "envelope: {v}");
    let error = v["error"].as_str().expect("error is a string").to_owned();
    assert!(!error.is_empty());
    error
}

#[test]
fn creates_missing_file_with_nested_parents() {
    let file = scratch("nested").join("a/b/c/d.txt");
    let path = file.to_str().expect("utf-8 path");
    let out = run(&["--path", path], b"hello world");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), ok_envelope(path, 11));
    assert!(
        out.stderr.is_empty(),
        "stderr: {:?}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(fs::read(&file).expect("file written"), b"hello world");
}

#[test]
fn overwrites_existing_file() {
    let file = scratch("over").join("f.txt");
    fs::create_dir_all(file.parent().expect("parent")).expect("pre-create dir");
    fs::write(&file, "previous much longer content").expect("seed");
    let path = file.to_str().expect("utf-8 path");
    let out = run(&["--path", path], b"short");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file read"), b"short");
    assert_eq!(String::from_utf8_lossy(&out.stdout), ok_envelope(path, 5));
}

#[test]
fn empty_stdin_writes_zero_bytes() {
    let file = scratch("empty").join("e.txt");
    let path = file.to_str().expect("utf-8 path");
    let out = run(&["--path", path], b"");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), ok_envelope(path, 0));
    assert_eq!(fs::read(&file).expect("file written"), b"");
}

#[test]
fn byte_parity_multiline_with_trailing_newline() {
    let file = scratch("ml").join("m.txt");
    let path = file.to_str().expect("utf-8 path");
    let input = b"line one\nline two\nline three\n";
    let out = run(&["--path", path], input);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file written"), input);
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        ok_envelope(path, input.len() as u64)
    );
}

#[test]
fn byte_parity_without_trailing_newline() {
    let file = scratch("nonl").join("n.txt");
    let path = file.to_str().expect("utf-8 path");
    let input = b"no trailing newline";
    let out = run(&["--path", path], input);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file written"), input);
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        ok_envelope(path, input.len() as u64)
    );
}

#[test]
fn byte_parity_unicode_content() {
    let file = scratch("uni").join("u.txt");
    let path = file.to_str().expect("utf-8 path");
    let input = "héllo — 世界 \u{1F600}\n".as_bytes();
    let out = run(&["--path", path], input);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file written"), input);
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        ok_envelope(path, input.len() as u64)
    );
}

#[test]
fn byte_parity_latin1_and_invalid_utf8_bytes() {
    let file = scratch("bin").join("b.bin");
    let path = file.to_str().expect("utf-8 path");
    let input: &[u8] = &[0xE9, 0x31, 0xFF, 0xFE, 0x00, 0x0D, 0x0A, 0x1A, 0xC3, 0x28];
    let out = run(&["--path", path], input);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file written"), input);
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        ok_envelope(path, input.len() as u64)
    );
}

#[test]
fn envelope_escapes_weird_path_verbatim() {
    // A filename with JSON-hostile characters: the envelope must carry it
    // exactly as serde_json would (byte parity of the echo).
    let file = scratch("weird").join("we\"ird\\name.txt");
    let path = file.to_str().expect("utf-8 path");
    let out = run(&["--path", path], b"x");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), ok_envelope(path, 1));
    assert_eq!(fs::read(&file).expect("file written"), b"x");
}

#[test]
fn io_error_when_path_is_a_directory() {
    let dir = scratch("iodir").join("d");
    fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.to_str().expect("utf-8 path");
    let out = run(&["--path", path], b"x");
    assert_eq!(out.status.code(), Some(3));
    fail_envelope(&out);
}

#[test]
fn usage_missing_path_flag() {
    let out = run(&[], b"x");
    assert_eq!(out.status.code(), Some(2));
    let error = fail_envelope(&out);
    assert!(error.contains("--path"), "{error}");
}

#[test]
fn usage_unknown_flag() {
    let out = run(&["--wat"], b"");
    assert_eq!(out.status.code(), Some(2));
    fail_envelope(&out);
}

#[test]
fn usage_positional_argument() {
    let out = run(&["stray"], b"");
    assert_eq!(out.status.code(), Some(2));
    fail_envelope(&out);
}

#[test]
fn usage_path_without_value() {
    let out = run(&["--path"], b"");
    assert_eq!(out.status.code(), Some(2));
    fail_envelope(&out);
}

#[test]
fn help_prints_usage_and_exits_zero() {
    let out = run(&["--help"], b"");
    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("usage: piwrite --path"), "{text}");
}

#[test]
fn version_prints_package_version() {
    let out = run(&["--version"], b"");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!("piwrite {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn inline_path_form_writes() {
    let file = scratch("inline").join("i.txt");
    let arg = format!("--path={}", file.display());
    let out = run(&[arg.as_str()], b"inline");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(fs::read(&file).expect("file written"), b"inline");
}
