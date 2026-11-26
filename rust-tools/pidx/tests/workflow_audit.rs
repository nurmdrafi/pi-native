use serde_json::{json, Value};
use std::fs::{self, File, FileTimes};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn workflow_audit_classifies_results_and_never_prints_payloads() {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("pidx-workflow-{}-{nonce}", std::process::id()));
    let project = root.join("private-project-marker");
    fs::create_dir_all(&project).unwrap();
    let path = project.join("2026-01-01T00-00-00Z_private-session-marker.jsonl");
    let call = |id, name, arguments| json!({"type":"toolCall","id":id,"name":name,"arguments":arguments});
    let assistant = |content| json!({"role":"assistant","content":content,"usage":{"input":11,"output":2,"cacheRead":40}});
    let result = |id, error, texts: &[&str]| json!({"role":"toolResult","toolCallId":id,"isError":error,"content":texts.iter().map(|t| json!({"type":"text","text":t})).collect::<Vec<_>>()});
    let bash = |id, command| call(id, "pibash", json!({"command":command}));
    let records = [
        assistant(vec![bash("a", "cat private-path-marker")]),
        result("a", true, &["Hygiene (Reader-bypass): private-block-marker"]),
        assistant(vec![call("b", "piread", json!({"path":"private-path-marker"}))]),
        result("b", false, &["private-output-marker", "Token Economy (Re-read): private-warning-marker"]),
        assistant(vec![bash("c", "rg needle files"), bash("d", "false"), bash("e", "sleep 5"), bash("f", "sleep 5"), bash("g", "true"), bash("h", "rg needle files || false"), bash("i", "true"), bash("j", "cat private-path-marker")]),
        result("c", true, &["Command exited with code 1"]),
        result("d", true, &["Command exited with code 1"]),
        result("e", true, &["Command timed out after 1 seconds"]),
        result("f", true, &["private-output-marker\n\nCommand aborted"]),
        result("g", true, &["pibash: native execution failed (private-transport-marker)"]),
        result("h", true, &["Command exited with code 1"]),
        result("i", false, &["Hygiene (Reader-bypass): plain shell stdout"]),
        result("j", true, &["Hygiene (Reader-bypass): private-block-marker"]),
        assistant(vec![bash("k", "cat private-path-marker"), bash("l", "false")]),
        result("k", true, &["Hygiene (Reader-bypass): private-block-marker"]),
        result("l", true, &["Command exited with code 1"]),
        json!({"role":"user","content":"private-prompt-marker"}),
        assistant(vec![bash("m", "true")]),
        result("m", false, &["ok"]),
    ];
    let payload = records.into_iter().map(|message| json!({"type":"message","message":message}).to_string()).collect::<Vec<_>>().join("\n");
    fs::write(&path, payload).unwrap();
    File::options().write(true).open(&path).unwrap().set_times(FileTimes::new().set_modified(UNIX_EPOCH)).unwrap();
    let run = || Command::new(env!("CARGO_BIN_EXE_pidx"))
        .arg("--sessions-dir").arg(&root)
        .arg("--state").arg(root.join("state"))
        .args(["--max", "10", "--report", "audit"])
        .output().unwrap();
    let output = run();
    let warm = run();
    fs::remove_dir_all(&root).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(warm.status.success());
    assert_eq!(output.stdout, warm.stdout);
    let cache: Value = serde_json::from_slice(&warm.stderr).unwrap();
    assert_eq!(cache["reused"], 1);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("private-"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-"));
    let report: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["sessions"], 1);
    assert_eq!(report["usage"]["input"], 55);
    assert_eq!(report["usage"]["cacheRead"], 200);
    assert_eq!(report["tools"]["pibash"]["calls"], 12);
    assert_eq!(report["tools"]["pibash"]["warnings"], json!({}));
    assert_eq!(report["tools"]["pibash"]["outcomes"], json!({"gate_block":3,"no_match":1,"shell_nonzero":3,"timeout":1,"cancelled":1,"native_failure":1,"ok":2}));
    assert_eq!(report["tools"]["piread"]["warnings"]["re_read"], 1);
    assert!(report["tools"]["piread"]["resultBytes"].as_u64().unwrap() > 0);
    assert_eq!(report["recovery"]["reader_bypass"], json!({"batch_ok":1,"same_family_block":1,"no_next_batch":1}));
}
