//! Integration tests for the CLI contract (Step 1): arg parsing exit codes,
//! JSON envelope shape, error kinds, exit 0/2/3 mapping.
//!
//! The pipeline itself is unit-tested in src/pipeline.rs and oracle-pinned by
//! the harness suite tests/piread-parity.test.mjs.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_piread");

fn tmp_fixture(name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piread-it-{}-{name}", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    let file = dir.join("f");
    fs::write(&file, bytes).expect("fixture write");
    file
}

fn run(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(BIN).args(args).output().expect("spawn piread");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn run_json(args: &[&str]) -> (i32, Value, String) {
    let (code, stdout, stderr) = run(args);
    let json: Value = serde_json::from_str(stdout.trim()).expect("stdout is one JSON object");
    (code, json, stderr)
}

// ---- informational flags ----

#[test]
fn version_exits_zero() {
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, 0);
    assert!(stdout.starts_with("piread "), "got: {stdout}");
}

#[test]
fn help_exits_zero() {
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("usage: piread --path"));
}

// ---- usage errors: exit 2, stderr message, NO JSON on stdout ----

#[test]
fn missing_path_flag_is_usage_error() {
    let (code, stdout, stderr) = run(&["--offset", "2"]);
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
    assert!(stderr.contains("piread:"), "stderr: {stderr}");
}

#[test]
fn unknown_flag_is_usage_error() {
    let (code, stdout, stderr) = run(&["--path", "/definitely/missing", "--wat"]);
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
    assert!(stderr.contains("unknown flag"), "stderr: {stderr}");
}

#[test]
fn offset_and_limit_below_one_are_usage_errors() {
    for flag in ["--offset", "--limit"] {
        for bad in ["0", "-1"] {
            let (code, stdout, _) = run(&["--path", "/x", flag, bad]);
            assert_eq!(code, 2, "{flag} {bad}");
            assert_eq!(stdout, "", "{flag} {bad}");
        }
    }
}

#[test]
fn non_numeric_value_is_usage_error() {
    let (code, stdout, _) = run(&["--path", "/x", "--offset", "1.5"]);
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
}

#[test]
fn dangling_value_is_usage_error() {
    let (code, stdout, _) = run(&["--path", "/x", "--limit"]);
    assert_eq!(code, 2);
    assert_eq!(stdout, "");
}

// ---- I/O failures: exit 3, JSON envelope on stdout ----

#[test]
fn missing_file_is_enoent_with_node_style_message() {
    let missing = "/definitely/not/here/piread-it";
    let (code, json, _) = run_json(&["--path", missing]);
    assert_eq!(code, 3);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["kind"], "ENOENT");
    assert_eq!(
        json["error"]["message"].as_str().unwrap(),
        format!("ENOENT: no such file or directory, access '{missing}'")
    );
}

#[test]
fn directory_is_eisdir() {
    let dir = tmp_fixture("eisdir", b"x").parent().unwrap().to_path_buf();
    let (code, json, _) = run_json(&["--path", &dir.to_string_lossy()]);
    assert_eq!(code, 3);
    assert_eq!(json["error"]["kind"], "EISDIR");
    assert_eq!(
        json["error"]["message"].as_str().unwrap(),
        "EISDIR: illegal operation on a directory, read"
    );
}

#[test]
fn unreadable_file_is_eacces_when_not_root() {
    // chmod 000 is meaningless for root; skip there instead of failing.
    if nix_uid() == 0 {
        return;
    }
    let file = tmp_fixture("eacces", b"secret");
    let mut perms = fs::metadata(&file).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o000);
    fs::set_permissions(&file, perms).unwrap();
    let (code, json, _) = run_json(&["--path", &file.to_string_lossy()]);
    assert_eq!(code, 3);
    assert_eq!(json["error"]["kind"], "EACCES");
    assert_eq!(
        json["error"]["message"].as_str().unwrap(),
        format!("EACCES: permission denied, access '{}'", file.to_string_lossy())
    );
}

fn nix_uid() -> u32 {
    // best-effort without a libc dep: stat the temp dir owner via /proc is
    // overkill — use the id(1) tool, present on macOS and Linux alike.
    let out = Command::new("id").arg("-u").output().expect("run id");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(1)
}

// ---- success envelope shape ----

#[test]
fn tiny_file_success_envelope_shape() {
    let file = tmp_fixture("ok", b"hello piread\n");
    let (code, json, _) = run_json(&["--path", &file.to_string_lossy()]);
    assert_eq!(code, 0);
    assert_eq!(json["ok"], true);
    assert_eq!(json["content"], "hello piread\n");
    assert_eq!(json["truncation"], Value::Null);
    assert_eq!(json["binary"], false);
    assert_eq!(json["totalBytes"], 13);
    // Compaction diagnostics ride in the envelope rather than on stderr; a
    // read that fits the budget reports `null`.
    assert_eq!(json["compaction"], Value::Null);
    // exactly the documented keys, in the documented order
    let keys: Vec<&str> =
        json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        ["ok", "content", "truncation", "binary", "totalBytes", "compaction"]
    );
}
