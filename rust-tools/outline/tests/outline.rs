//! Integration tests for `outline`: a definition index (start, end, kind,
//! name) used to aim bounded read windows at a file without re-walking it.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn run(args: &[&str]) -> (String, String, Option<i32>) {
    let out = Command::new(env!("CARGO_BIN_EXE_outline"))
        .args(args)
        .output()
        .expect("spawn outline");
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code(),
    )
}

fn tmp_fixture(name: &str, body: &str) -> PathBuf {
    let p = std::env::temp_dir().join(name);
    fs::write(&p, body).unwrap();
    p
}

#[test]
fn rust_definitions_report_brace_matched_spans() {
    let src = "mod a {\n    fn one() {\n        let x = 1;\n    }\n}\n\nfn two() -> u32 {\n    2\n}\n";
    let p = tmp_fixture("outline-rs-defs.rs", src);
    let (stdout, stderr, code) = run(&[p.to_str().unwrap()]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert_eq!(stdout, "1\t5\tmod\ta\n2\t4\tfn\tone\n7\t9\tfn\ttwo\n");
}

#[test]
fn python_definitions_end_at_next_definition_and_trim_blanks() {
    let src = "class A:\n    def one(self):\n        return 1\n\ndef two():\n    return 2\n";
    let p = tmp_fixture("outline-py-defs.py", src);
    let (stdout, stderr, code) = run(&[p.to_str().unwrap()]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert_eq!(
        stdout,
        "1\t3\tclass\tA\n2\t3\tdef\tone\n5\t6\tdef\ttwo\n"
    );
}

#[test]
fn unsupported_extension_fails_and_names_the_extension() {
    let p = tmp_fixture("outline-plain-notes.txt", "hello\n");
    let (stdout, stderr, code) = run(&[p.to_str().unwrap()]);
    assert_eq!(code, Some(1));
    assert!(stdout.is_empty());
    assert!(stderr.contains(".txt"), "stderr: {stderr}");
}

#[test]
fn missing_file_fails_with_path_in_message() {
    let (stdout, stderr, code) = run(&["/nonexistent/outline-missing.rs"]);
    assert_eq!(code, Some(1));
    assert!(stdout.is_empty());
    assert!(stderr.contains("outline-missing.rs"), "stderr: {stderr}");
}

#[test]
fn missing_argument_prints_usage_and_exits_two() {
    let (stdout, stderr, code) = run(&[]);
    assert_eq!(code, Some(2));
    assert!(stdout.is_empty());
    assert!(stderr.contains("usage"), "stderr: {stderr}");
}

#[test]
fn closed_stdout_pipe_exits_zero_instead_of_panicking() {
    use std::process::{Command, Stdio};
    // Enough rows to overflow the 64 KiB pipe buffer after the read end closes.
    let src = (0..4000).map(|i| format!("fn f{i}() {{}}\n")).collect::<String>();
    let p = tmp_fixture("outline-pipe-overflow.rs", &src);
    let mut child = Command::new(env!("CARGO_BIN_EXE_outline"))
        .arg(p.to_str().unwrap())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn outline");
    drop(child.stdout.take());
    let status = child.wait().expect("wait outline");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn self_closed_definition_does_not_swallow_following_blocks() {
    let src = "const one = f({ a: 1 });\n\nrun(() => {\n  bar();\n});\n";
    let p = tmp_fixture("outline-js-selfclosed.mjs", src);
    let (stdout, stderr, code) = run(&[p.to_str().unwrap()]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert_eq!(stdout, "1\t1\tconst\tone\n");
}

#[test]
fn show_prints_header_then_exact_body() {
    let src = "fn alpha() {\n    1\n}\n\nfn target() {\n    let x = 2;\n}\n";
    let p = tmp_fixture("outline-show-body.rs", src);
    let (stdout, stderr, code) = run(&["--show", p.to_str().unwrap(), "target"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert_eq!(stdout, "5-7 fn target\nfn target() {\n    let x = 2;\n}\n");
}

#[test]
fn show_unknown_symbol_lists_known_names() {
    let src = "fn alpha() {\n    1\n}\n\nfn target() {\n    2\n}\n";
    let p = tmp_fixture("outline-show-unknown.rs", src);
    let (stdout, stderr, code) = run(&["--show", p.to_str().unwrap(), "nope"]);
    assert_eq!(code, Some(1));
    assert!(stdout.is_empty());
    assert!(stderr.contains("alpha") && stderr.contains("target"), "stderr: {stderr}");
}

#[test]
fn show_oversized_span_prints_head_marker_tail() {
    let mut src = String::from("fn big() {\n");
    for i in 0..248 {
        src.push_str(&format!("    let v{i} = {i};\n"));
    }
    src.push_str("}\n");
    let p = tmp_fixture("outline-show-oversized.rs", &src);
    let (stdout, stderr, code) = run(&["--show", p.to_str().unwrap(), "big"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    // span 1-250: head = lines 1-100, marker = 101-230 (130 lines), tail = 231-250 (20 lines).
    let mut want = String::from("1-250 fn big\nfn big() {\n");
    for i in 0..99 {
        want.push_str(&format!("    let v{i} = {i};\n"));
    }
    want.push_str("... omitted 130 lines (lines 101-230) ...\n");
    for i in 229..248 {
        want.push_str(&format!("    let v{i} = {i};\n"));
    }
    want.push_str("}\n");
    assert_eq!(stdout, want);
}

#[test]
fn show_multiple_same_name_symbols_prints_all() {
    let src = "function dup() {\n    1;\n}\nconst mid = 2;\nfunction dup() {\n    3;\n}\n";
    let p = tmp_fixture("outline-show-dup.mjs", src);
    let (stdout, stderr, code) = run(&["--show", p.to_str().unwrap(), "dup"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert_eq!(stdout, "1-3 function dup\nfunction dup() {\n    1;\n}\n5-7 function dup\nfunction dup() {\n    3;\n}\n");
}

#[test]
fn exported_and_async_definitions_are_indexed() {
    let src = "import x from \"y\";\n\
               export function foo() {\n    1;\n}\n\
               export default function App() {\n    2;\n}\n\
               export const bar = () => 3;\n\
               async function baz() {\n    4;\n}\n\
               export async function qux() {\n    5;\n}\n\
               export type Thing = { a: 1 };\n";
    let p = tmp_fixture("outline-exported.tsx", src);
    let (stdout, stderr, code) = run(&[p.to_str().unwrap()]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    for name in ["foo", "App", "bar", "baz", "qux", "Thing"] {
        assert!(
            stdout.lines().any(|l| l.trim_end().ends_with(name)),
            "index misses {name}; stdout: {stdout}"
        );
    }
}

#[test]
fn show_finds_exported_symbol() {
    let src = "export function Comp() {\n    return 1;\n}\n";
    let p = tmp_fixture("outline-show-exported.tsx", src);
    let (stdout, stderr, code) = run(&["--show", p.to_str().unwrap(), "Comp"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    assert!(stdout.starts_with("1-3 function Comp\n"), "stdout: {stdout}");
}
