//! pidx — incremental index/extract for pi session logs.
//!
//! Parses `<sessions-dir>/<project>/<ISO-ts>_<uuid>.jsonl` transcripts into
//! compact per-session extracts (turns, tool calls with param hashes, tool
//! results, compactions, skill loads). Files are keyed by (size, mtime_ns);
//! unchanged files reuse the cached extract from the store, so runs are
//! O(changes), not O(archive). The store keeps a small header of byte ranges
//! plus the raw extract bytes, so a warm run replays unchanged sessions
//! without re-parsing or re-serializing them. OS-agnostic: std only + mtime, no watchers.
//!
//! Output: one JSON line per session (newest first) to --out (default
//! stdout); a summary JSON line to stderr. Exit 0 on success even with
//! individually unparseable files (they yield an extract with zero turns).
//!
//! Extract schema (consumed by session-audit's fast path; mirrors
//! parser.mjs semantics exactly — see PARITY notes inline):
//!   {v:2, sessionId, project, path, turns:[{rid,ts,model,usage}],
//!    calls:[{id,name,ts,rid,ph,path,cmd}], results:[{id,ts,err,bytes,blk?}],
//!    compactions, skills:{name:uses}}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ACTIVE_SESSION_MS: u128 = 5 * 60 * 1000; // parity: discover.mjs invariant 5
const IMAGE_BYTES_ESTIMATE: u64 = 4_000;

// ---------------------------------------------------------------- time

/// tsMs parity (parser.mjs): number >1e12 as-is else ×1000; digit-strings
/// same; ISO strings parsed; everything else None (JS NaN).
fn ts_ms(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().and_then(|f| {
            if f.is_finite() {
                Some((if f > 1e12 { f } else { f * 1000.0 }) as i64)
            } else {
                None
            }
        }),
        Value::String(s) => {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                let n: f64 = s.parse().ok()?;
                Some((if n > 1e12 { n } else { n * 1000.0 }) as i64)
            } else {
                parse_iso_ms(s)
            }
        }
        _ => None,
    }
}

/// Date.parse subset: YYYY-MM-DD[ T]HH:MM[:SS[.fff…]][Z|±HH(:MM|MM)|±HHMM].
/// Date-only = UTC midnight (JS spec). Unhandled shapes → None (NaN).
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 || !b[..4].iter().all(u8::is_ascii_digit) || b[4] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let sl = s.get(r)?;
        if sl.bytes().all(|c| c.is_ascii_digit()) && !sl.is_empty() {
            sl.parse().ok()
        } else {
            None
        }
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let mut ms = days_from_civil(y, mo, d)? * 86_400_000;
    if b.len() == 10 {
        return Some(ms);
    }
    if b[10] != b'T' && b[10] != b't' && b[10] != b' ' {
        return None;
    }
    let mut i = 11;
    let need = |i: &mut usize, len: usize| -> Option<String> {
        let start = *i;
        if b.len() < start + len || !b[start..start + len].iter().all(|c| c.is_ascii_digit()) {
            return None;
        }
        *i += len;
        s.get(start..start + len).map(|x| x.to_string())
    };
    let hh: i64 = need(&mut i, 2)?.parse().ok()?;
    if b.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    let mi: i64 = need(&mut i, 2)?.parse().ok()?;
    let mut sec = 0i64;
    let mut frac = 0i64;
    if b.get(i) == Some(&b':') {
        i += 1;
        sec = need(&mut i, 2)?.parse().ok()?;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let digits = &s[start..i];
            let take: String = digits.chars().take(3).collect();
            frac = if take.is_empty() {
                0
            } else {
                let v: i64 = take.parse().ok()?;
                v * 10i64.pow(3 - take.len() as u32)
            };
        }
    }
    ms += ((hh * 60 + mi) * 60 + sec) * 1000 + frac;
    // timezone
    let mut off_min: i64 = 0;
    match b.get(i) {
        None => return None, // JS treats bare datetime w/o tz as local — sessions are always Z; NaN keeps parity honest
        Some(b'Z') | Some(b'z') => {}
        Some(b'+') | Some(b'-') => {
            let sign = if b[i] == b'+' { -1 } else { 1 };
            i += 1;
            let oh: i64 = need(&mut i, 2)?.parse().ok()?;
            let om = if b.get(i) == Some(&b':') {
                i += 1;
                need(&mut i, 2)?.parse().ok()?
            } else if b.len() >= i + 2 && b[i..].len() == 2 {
                need(&mut i, 2)?.parse().ok()?
            } else {
                0
            };
            off_min = sign * (oh * 60 + om);
        }
        _ => return None,
    }
    Some(ms + off_min * 60_000)
}

/// Days-from-civil (Howard Hinnant) — valid 1970±, no leap-year tables.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_string(ms: i64) -> Option<String> {
    let day = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(day);
    if !(0..=9999).contains(&y) {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        mo,
        d,
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1000) % 60,
        rem % 1000
    ))
}

fn iso_of(v: &Value) -> Option<String> {
    iso_string(ts_ms(v)?)
}

// ---------------------------------------------------------------- extract

/// contentBytes parity (parser.mjs): string → utf8 len; array → text bytes
/// + flat 4000/image; anything else 0.
fn content_bytes(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.len() as u64,
        Value::Array(a) => {
            let mut n = 0u64;
            for b in a {
                if let Some(Value::String(t)) = b.get("text") {
                    n += t.len() as u64;
                } else if b.get("type").and_then(Value::as_str) == Some("image") {
                    n += IMAGE_BYTES_ESTIMATE;
                }
            }
            n
        }
        _ => 0,
    }
}

/// Gate block family. The permission gate's synthesized block reasons always
/// BEGIN with a stable family prefix; a session that merely reads the gate's
/// own source must not look blocked, so the match is anchored at the start of
/// the text rather than searching mid-stream.
fn gate_family(content: &Value) -> Option<&'static str> {
    const FAMILIES: [(&str, &str); 9] = [
        ("Permission Gate", "gate"),
        ("Anchor Guard", "anchor"),
        ("Token Economy", "tokens"),
        ("Loop Guard", "loop"),
        ("Phase (PH1)", "phase"),
        ("Commit Message", "commit"),
        ("Toolchain", "toolchain"),
        ("Search", "search"),
        ("Destructive", "destructive"),
    ];
    let text = match content {
        Value::String(s) => s.as_str(),
        Value::Array(blocks) => blocks
            .iter()
            .find_map(|b| b.get("text").and_then(Value::as_str))?,
        _ => return None,
    };
    let head = text.trim_start();
    FAMILIES
        .iter()
        .find(|(prefix, _)| head.starts_with(prefix))
        .map(|(_, tag)| *tag)
}

#[cfg(test)]
mod gate_family_tests {
    use super::*;

    #[test]
    fn classifies_block_reasons() {
        let c = json!([{"type":"text","text":"Anchor Guard (Unread): 'x' not read this session"}]);
        assert_eq!(gate_family(&c), Some("anchor"));
        let c = json!([{"type":"text","text":"Token Economy (Re-run): blocked"}]);
        assert_eq!(gate_family(&c), Some("tokens"));
        let c = json!([{"type":"text","text":"    Loop Guard (R11): stop retrying"}]);
        assert_eq!(gate_family(&c), Some("loop"));
    }

    #[test]
    fn ignores_mid_stream_mentions_and_plain_output() {
        let c = json!([{"type":"text","text":"index.ts:88: // Anchor Guard blocks this"}]);
        assert_eq!(gate_family(&c), None);
        let c = json!([{"type":"text","text":"ok\n"}]);
        assert_eq!(gate_family(&c), None);
        assert_eq!(gate_family(&Value::Null), None);
    }
}

fn js_stringify(v: &Value) -> String {
    // serde_json compact output matches JS JSON.stringify for shared shapes
    // (preserve_order keeps object key insertion order; ryu shortest == JS
    // shortest round-trip floats).
    match v {
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// paramHash parity (parser.mjs NORMALIZERS): identical hash = mechanically
/// duplicate invocation.
fn param_hash(name: &str, input: &Value) -> String {
    let norm: String = match name {
        "read" => {
            let g = |k: &str, d: &str| match input.get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => d.to_string(),
            };
            format!("{}\u{0}{}\u{0}{}", g("path", ""), g("offset", "1"), g("limit", "\u{221e}"))
        }
        "bash" => input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        "edit" => format!(
            "{}\u{0}{}",
            input.get("path").and_then(Value::as_str).unwrap_or(""),
            js_stringify(input.get("edits").unwrap_or(&Value::String(String::new())))
        ),
        "write" => format!(
            "{}\u{0}{}",
            input.get("path").and_then(Value::as_str).unwrap_or(""),
            js_stringify(input.get("content").unwrap_or(&Value::String(String::new())))
        ),
        _ => {
            let empty = json!({});
            js_stringify(if input.is_null() { &empty } else { input })
        }
    };
    let mut h = Sha1::new();
    h.update(format!("{name}{norm}").as_bytes());
    let dig = h.finalize();
    let mut out = String::with_capacity(12);
    for b in dig.iter().take(6) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Per-model spend over every assistant message with usage, before rid dedupe.
#[derive(Default)]
struct UsageAgg {
    turns: u64,
    input: i64,
    output: i64,
    reasoning: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
}

/// `--report usage`: per-model token profile, cost tail and prefix trend, over the
/// same extracts the JSONL stream carries. Replaces the Python walker that used to
/// parse ~110 MB of session JSONL to derive the same table.
fn report_usage(
    found: &[(PathBuf, String, u128)],
    parsed: &HashMap<String, (FileId, Value)>,
    store: &Store,
) -> Result<(), Box<dyn Error>> {
    let mut per_model: BTreeMap<String, UsageAgg> = BTreeMap::new();
    let mut sessions: Vec<(String, u64, f64)> = Vec::new();
    let mut prefix: Vec<(String, i64)> = Vec::new();

    for (path, _, _) in found {
        let key = path.to_string_lossy().to_string();
        let extract: Option<Value> = match parsed.get(&key) {
            Some((_, v)) => Some(v.clone()),
            None => store
                .files
                .get(&key)
                .and_then(|e| serde_json::from_slice::<Value>(store.extract(e)).ok()),
        };
        let Some(v) = extract else { continue };
        let Some(agg) = v.get("usage").and_then(Value::as_object) else { continue };
        if agg.is_empty() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let ts: String = name.chars().take(16).collect::<String>().replace('T', " ");
        let mut turns = 0u64;
        let mut cost = 0.0f64;
        for (model, u) in agg {
            let a = per_model.entry(model.clone()).or_default();
            let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
            a.turns += u.get("turns").and_then(Value::as_u64).unwrap_or(0);
            a.input += n("input");
            a.output += n("output");
            a.reasoning += n("reasoning");
            a.cache_read += n("cacheRead");
            a.cache_write += n("cacheWrite");
            let c = u.get("costTotal").and_then(Value::as_f64).unwrap_or(0.0);
            a.cost += c;
            turns += u.get("turns").and_then(Value::as_u64).unwrap_or(0);
            cost += c;
        }
        if turns > 0 {
            sessions.push((ts.clone(), turns, (cost * 100.0).round() / 100.0));
            let first = v.get("firstTurnTokens").and_then(Value::as_i64).unwrap_or(0);
            prefix.push((ts, first));
        }
    }

    println!("{:<26}{:>6}{:>7}{:>7}{:>7}{:>7}{:>8}", "model", "turns", "in/t", "out/t", "rsn/t", "cache%", "cost$");
    let mut ranked: Vec<(&String, &UsageAgg)> = per_model.iter().collect();
    ranked.sort_by(|a, b| b.1.cost.total_cmp(&a.1.cost));
    for (model, a) in ranked {
        let t = a.turns.max(1) as i64;
        let cache_pct = a.cache_read as f64 / (a.input + a.cache_read).max(1) as f64 * 100.0;
        println!(
            "{:<26}{:>6}{:>7}{:>7}{:>7}{:>6.0}%{:>8.2}",
            model.chars().take(26).collect::<String>(),
            a.turns,
            a.input / t,
            a.output / t,
            a.reasoning / t,
            cache_pct,
            a.cost
        );
    }

    sessions.sort_by(|a, b| b.2.total_cmp(&a.2));
    println!("\nTop expensive sessions (the cost tail):");
    for (ts, turns, cost) in sessions.iter().take(5) {
        println!("  {ts}  {turns:>4} turns  ${cost}");
    }

    prefix.sort_by(|a, b| a.0.cmp(&b.0));
    println!("\nFirst-turn prompt size (prefix trend, last 8):");
    let start = prefix.len().saturating_sub(8);
    for (ts, first) in &prefix[start..] {
        println!("  {ts}  {first:>6} tok");
    }
    println!(
        "\nFlags: reasoning/output > 0.5 -> consider non-reasoning model; sessions > 200 turns -> prefer compaction/new session."
    );
    Ok(())
}

/// Parse one transcript into an extract Value. Tolerant: any line may fail.
fn extract_file(path: &Path, project_fallback: &str) -> Value {
    let f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return empty_extract(path, project_fallback),
    };
    let mut reader = io::BufReader::new(f);
    let mut cwd: Option<String> = None;

    // turns: dedupe by rid, LAST occurrence wins (apiTurns parity); entries
    // without responseId never dedupe (JS Symbol per entry).
    let mut turns: Vec<(Option<String>, Value)> = Vec::new();
    let mut rid_seen: HashMap<String, usize> = HashMap::new();
    let mut calls: Vec<Value> = Vec::new();
    let mut call_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut results: Vec<Value> = Vec::new();
    let mut result_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut compactions = 0u64;
    let mut skills: HashMap<String, u64> = HashMap::new();
    let mut uts: Vec<i64> = Vec::new(); // user-entry timestamps (ms) — classifyGap parity
    // Spend aggregates over EVERY assistant message with usage, computed before
    // the rid dedupe below. `turns` keeps one entry per responseId (apiTurns
    // parity), so a session that retried or streamed twice reports fewer turns
    // there than it actually paid for; audits need the full number.
    let mut usage_agg: BTreeMap<String, UsageAgg> = BTreeMap::new();
    let mut first_turn_tokens: Option<i64> = None;

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let e: Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if e.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(c) = e.get("cwd").and_then(Value::as_str) {
                cwd = Some(c.to_string());
            }
            continue;
        }
        if e.get("type").and_then(Value::as_str) == Some("compaction") {
            compactions += 1;
            continue;
        }
        if e.get("type") != Some(&Value::String("message".into())) {
            continue;
        }
        let msg = match e.get("message") {
            Some(m) => m,
            None => continue,
        };
        let role = msg.get("role").and_then(Value::as_str);
        match role {
            Some("assistant") => {
                let usage = msg.get("usage");
                if usage.map(|u| !u.is_null()).unwrap_or(false) {
                    let rid = msg.get("responseId").and_then(Value::as_str).map(String::from);
                    let ts = iso_of(msg.get("timestamp").unwrap_or(&Value::Null));
                    let model = msg
                        .get("model")
                        .and_then(Value::as_str)
                        .map(String::from);
                    let agg = usage_agg
                        .entry(model.clone().unwrap_or_else(|| "?".to_string()))
                        .or_default();
                    let num = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_i64).unwrap_or(0);
                    agg.turns += 1;
                    agg.input += num("input");
                    agg.output += num("output");
                    agg.reasoning += num("reasoning");
                    agg.cache_read += num("cacheRead");
                    agg.cache_write += num("cacheWrite");
                    agg.cost += usage
                        .and_then(|u| u.get("cost"))
                        .and_then(|c| c.get("total"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    if first_turn_tokens.is_none() {
                        first_turn_tokens = Some(num("totalTokens"));
                    }
                    let turn = json!({
                        "rid": rid,
                        "ts": ts,
                        "model": model,
                        "usage": usage,
                    });
                    match &turn["rid"] {
                        Value::String(r) => {
                            if let Some(i) = rid_seen.get(r) {
                                turns[*i] = (Some(r.clone()), turn);
                            } else {
                                rid_seen.insert(r.clone(), turns.len());
                                turns.push((Some(r.clone()), turn));
                            }
                        }
                        _ => turns.push((None, turn)),
                    }
                }
                if let Some(Value::Array(blocks)) = msg.get("content") {
                    let ts = iso_of(msg.get("timestamp").unwrap_or(&Value::Null));
                    let rid = msg.get("responseId").and_then(Value::as_str).map(String::from);
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) != Some("toolCall") {
                            continue;
                        }
                        let id = match b.get("id").and_then(Value::as_str) {
                            Some(i) => i.to_string(),
                            None => continue, // parity: no id → skipped
                        };
                        if !call_ids.insert(id.clone()) {
                            continue;
                        }
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
                        let input = b.get("arguments").cloned().unwrap_or(json!({}));
                        let ph = param_hash(&name, &input);
                        let path_ = input.get("path").and_then(Value::as_str).map(String::from);
                        let cmd = input.get("command").and_then(Value::as_str).map(String::from);
                        calls.push(json!({
                            "id": id, "name": name, "ts": ts, "rid": rid,
                            "ph": ph, "path": path_, "cmd": cmd,
                        }));
                    }
                }
            }
            Some("user") => {
                if let Some(ms) = ts_ms(msg.get("timestamp").unwrap_or(&Value::Null)) {
                    uts.push(ms);
                }
                // skill loads: user text starting `<skill name="…"`
                let text = match msg.get("content") {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Array(a)) => Some(
                        a.iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join(""),
                    ),
                    _ => None,
                };
                if let Some(t) = text {
                    if let Some(rest) = t.strip_prefix("<skill ") {
                        if let Some(q1) = rest.find("name=\"") {
                            let after = &rest[q1 + 6..];
                            if let Some(end) = after.find('"') {
                                *skills.entry(after[..end].to_string()).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
            Some("toolResult") => {
                let id = match msg.get("toolCallId").and_then(Value::as_str) {
                    Some(i) => i.to_string(),
                    None => continue,
                };
                if !result_ids.insert(id.clone()) {
                    continue;
                }
                let content = msg.get("content").unwrap_or(&Value::Null);
                let bytes = content_bytes(content);
                let mut rec = json!({
                    "id": id,
                    "ts": iso_of(msg.get("timestamp").unwrap_or(&Value::Null)),
                    "err": msg.get("isError") == Some(&Value::Bool(true)),
                    "bytes": bytes,
                });
                // a gate block is recognizable by its leading family prefix
                if let Some(fam) = gate_family(content) {
                    rec["blk"] = Value::String(fam.to_string());
                }
                results.push(rec);
            }
            _ => {}
        }
    }

    // sort turns by tsMs stable (NaN → 0 parity: `tsMs(a) || 0`)
    turns.sort_by_key(|(_, t)| {
        t.get("ts")
            .and_then(Value::as_str)
            .and_then(|s| ts_ms(&Value::String(s.to_string())))
            .unwrap_or(0)
    });
    let turns_v: Vec<Value> = turns.into_iter().map(|(_, t)| t).collect();
    let mut skills_map: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    for (k, v) in skills {
        skills_map.insert(k, json!(v));
    }

    let mut usage_map = serde_json::Map::new();
    for (k, a) in &usage_agg {
        usage_map.insert(
            k.clone(),
            json!({
                "turns": a.turns, "input": a.input, "output": a.output,
                "reasoning": a.reasoning, "cacheRead": a.cache_read,
                "cacheWrite": a.cache_write, "costTotal": a.cost,
            }),
        );
    }

    json!({
        "v": 2,
        // discover.mjs parity: session id is filename-derived (uuid after
        // first '_'), never the header id — l1_findings keys on it.
        "sessionId": fallback_session_id(path),
        "project": cwd.unwrap_or_else(|| project_fallback.to_string()),
        "path": path.to_string_lossy(),
        "turns": turns_v,
        "calls": calls,
        "results": results,
        "compactions": compactions,
        "uts": uts,
        "skills": skills_map,
        "usage": usage_map,
        "firstTurnTokens": first_turn_tokens,
    })
}

fn empty_extract(path: &Path, project_fallback: &str) -> Value {
    json!({
        "v": 2,
        "sessionId": fallback_session_id(path),
        "project": project_fallback,
        "path": path.to_string_lossy(),
        "turns": [], "calls": [], "results": [],
        "compactions": 0, "skills": {}, "usage": {}, "firstTurnTokens": Value::Null,
    })
}

fn fallback_session_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    // filename: <ISO-ts>_<uuid> → session id is everything after first '_'
    match stem.find('_') {
        Some(i) => stem[i + 1..].to_string(),
        None => stem.to_string(),
    }
}

// ---------------------------------------------------------------- state

#[derive(Clone, Copy, PartialEq)]
struct FileId {
    size: u64,
    mtime_ns: i64,
}

fn stat_id(p: &Path) -> Option<FileId> {
    let md = fs::metadata(p).ok()?;
    let ns = md
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos() as i64;
    Some(FileId { size: md.len(), mtime_ns: ns })
}

/// One cached session: (size, mtime_ns) freshness key plus the byte range of
/// its pre-serialized extract inside the store's data section. Warm runs copy
/// the range straight to output — no JSON parse or re-serialize of unchanged
/// sessions.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Entry {
    size: u64,
    mtime_ns: i64,
    off: u64,
    len: u64,
}

// State store: `MAGIC | version u32 | header_len u32 | header JSON | data`.
// Header = {key: Entry}; data = concatenated compact extract JSON. A single
// file keeps the header and its offsets atomic under one rename.
const STORE_MAGIC: [u8; 8] = *b"PIDXST02";
const STORE_VERSION: u32 = 4;
const STORE_PREFIX: usize = 16;

struct Store {
    bytes: Vec<u8>,
    data_off: usize,
    files: HashMap<String, Entry>,
}

impl Store {
    fn empty() -> Self {
        Store { bytes: Vec::new(), data_off: 0, files: HashMap::new() }
    }

    fn data_len(&self) -> usize {
        self.bytes.len().saturating_sub(self.data_off)
    }

    fn extract<'a>(&'a self, e: &Entry) -> &'a [u8] {
        let start = self.data_off + e.off as usize;
        let end = self.data_off + (e.off + e.len) as usize;
        &self.bytes[start..end]
    }
}

fn load_store(path: &Path) -> Store {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return Store::empty(),
    };
    if bytes.len() < STORE_PREFIX || bytes[..8] != STORE_MAGIC {
        return Store::empty(); // absent or pre-v2 JSON state → full reparse
    }
    let version = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    let header_len = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    let data_off = STORE_PREFIX + header_len;
    if version != STORE_VERSION || bytes.len() < data_off {
        return Store::empty();
    }
    let files = match serde_json::from_slice(&bytes[STORE_PREFIX..data_off]) {
        Ok(f) => f,
        Err(_) => return Store::empty(),
    };
    Store { bytes, data_off, files }
}

fn save_store(path: &Path, files: &HashMap<String, Entry>, data: &[u8]) -> Result<(), Box<dyn Error>> {
    // Sorted keys: a HashMap's iteration order made two identical runs write
    // different store bytes, which rules out comparing stores or keying any
    // future cache on their content.
    let ordered: BTreeMap<&String, &Entry> = files.iter().collect();
    let header = serde_json::to_vec(&ordered)?;
    let mut buf = Vec::with_capacity(STORE_PREFIX + header.len() + data.len());
    buf.extend_from_slice(&STORE_MAGIC);
    buf.extend_from_slice(&STORE_VERSION.to_le_bytes());
    buf.extend_from_slice(&(header.len() as u32).to_le_bytes());
    buf.extend_from_slice(&header);
    buf.extend_from_slice(data);
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("pidx-state")
    ));
    fs::write(&tmp, &buf)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------- walk

fn discover(sessions_dir: &Path, now_ms: u128) -> (Vec<(PathBuf, String, u128)>, Vec<String>) {
    let mut found = Vec::new();
    let mut excluded = Vec::new();
    let Ok(rd) = fs::read_dir(sessions_dir) else {
        return (found, excluded);
    };
    for proj in rd.flatten() {
        let ppath = proj.path();
        if !ppath.is_dir() {
            continue;
        }
        let pname = proj.file_name().to_string_lossy().to_string();
        let Ok(files) = fs::read_dir(&ppath) else { continue };
        for f in files.flatten() {
            let fpath = f.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(md) = f.metadata() else { continue };
            let mtime = md
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let sid = fallback_session_id(&fpath);
            if now_ms.saturating_sub(mtime) < ACTIVE_SESSION_MS {
                excluded.push(sid);
                continue;
            }
            found.push((fpath, pname.clone(), mtime));
        }
    }
    found.sort_by_key(|e| std::cmp::Reverse(e.2)); // newest first (discover.mjs parity)
    (found, excluded)
}

// ---------------------------------------------------------------- main

/// Append one record to the extract stream, when a stream is open. A warm
/// no-op run emits exactly what the store already holds, so the caller may keep
/// the existing file untouched instead of rewriting it.
fn emit_line(w: &mut Option<Box<dyn Write>>, bytes: &[u8]) -> io::Result<()> {
    if let Some(w) = w.as_mut() {
        w.write_all(bytes)?;
        w.write_all(b"\n")?;
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mut sessions_dir = dirs_sessions_default();
    let mut state_path: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut max: usize = usize::MAX;
    let mut force = false;
    let mut report: Option<String> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--sessions-dir" => sessions_dir = PathBuf::from(args.next().ok_err("--sessions-dir needs a value")?),
            "--state" => state_path = Some(PathBuf::from(args.next().ok_err("--state needs a value")?)),
            "--out" => out_path = Some(PathBuf::from(args.next().ok_err("--out needs a value")?)),
            "--max" => max = args.next().ok_err("--max needs a value")?.parse()?,
            "--force" => force = true,
            "--report" => report = Some(args.next().ok_err("--report needs a value")?),
            "--help" | "-h" => {
                println!("usage: pidx [--sessions-dir DIR] [--state PATH] [--out PATH] [--max N] [--force] [--report usage]");
                return Ok(());
            }
            other => return Err(format!("unknown arg: {other}").into()),
        }
    }
    let state_path = state_path.unwrap_or_else(|| {
        dirs_state_default()
    });
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let t0 = std::time::Instant::now();

    let store = load_store(&state_path);

    let (found, excluded) = discover(&sessions_dir, now_ms);
    let found: Vec<(PathBuf, String, u128)> = found.into_iter().take(max).collect();

    // classify: reuse (fresh cache range) vs parse
    let mut to_parse: Vec<(String, PathBuf, String, FileId)> = Vec::new();
    let mut reused = 0usize;
    for (path, proj, _) in &found {
        let key = path.to_string_lossy().to_string();
        let id = stat_id(path);
        let cached = if force { None } else { store.files.get(&key).copied() };
        let fresh = id.zip(cached).filter(|(fid, e)| {
            e.size == fid.size
                && e.mtime_ns == fid.mtime_ns
                && (e.off + e.len) as usize <= store.data_len()
        });
        match fresh {
            Some(_) => reused += 1,
            None => to_parse.push((
                key.clone(),
                path.clone(),
                proj.clone(),
                id.unwrap_or(FileId { size: 0, mtime_ns: 0 }),
            )),
        }
    }

    // parse changed files on N threads
    let chunks = split_chunks(to_parse, std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    let mut parsed: Vec<(String, FileId, Value)> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .into_iter()
                        .map(|(key, path, proj, id)| (key, id, extract_file(&path, &proj)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            parsed.extend(h.join().unwrap_or_default());
        }
    });
    let parsed_map: HashMap<String, (FileId, Value)> =
        parsed.into_iter().map(|(k, i, v)| (k, (i, v))).collect();

    // Analysis reports read the same extracts and print a summary instead of the
    // JSONL stream, so the skill scripts that used to re-walk every session file
    // become one call into this binary.
    if let Some(which) = report {
        match which.as_str() {
            "usage" => report_usage(&found, &parsed_map, &store)?,
            other => return Err(format!("unknown report: {other}").into()),
        }
        return Ok(());
    }

    // When every found session is fresh and the store holds no extra keys, the
    // stored data is already exactly what we emit — skip rebuilding and rewriting.
    let needs_write = !parsed_map.is_empty() || reused != found.len() || store.files.len() != found.len();

    // A warm run with nothing to parse emits byte-for-byte what the store
    // already contains, so an up-to-date extract file needs no rewrite. That
    // rewrite (15 MB on this corpus) is the whole cost of a warm run; stdout and
    // a missing/short file still stream normally.
    let expected_out_len = if needs_write {
        None
    } else {
        Some(store.data_len() as u64 + found.len() as u64) // one '\n' per record
    };
    let out_is_current = match (&out_path, expected_out_len) {
        (Some(p), Some(n)) => fs::metadata(p).map(|m| m.len() == n).unwrap_or(false),
        _ => false,
    };
    let mut out_writer: Option<Box<dyn Write>> = if out_is_current {
        None
    } else {
        Some(match &out_path {
            Some(p) => Box::new(io::BufWriter::new(fs::File::create(p)?)),
            None => Box::new(io::BufWriter::new(io::stdout().lock())),
        })
    };
    // data section for the rewritten store; left empty on a no-op warm run
    let mut new_data: Vec<u8> = if needs_write {
        Vec::with_capacity(store.data_len())
    } else {
        Vec::new()
    };
    let mut new_files: HashMap<String, Entry> = HashMap::with_capacity(found.len());
    let mut emitted = 0usize;
    for (path, _, _) in &found {
        let key = path.to_string_lossy().to_string();
        if let Some((fid, extract)) = parsed_map.get(&key) {
            // serialize once; same bytes go to output and to the store
            let off = new_data.len() as u64;
            serde_json::to_writer(&mut new_data, extract)?;
            let len = new_data.len() as u64 - off;
            emit_line(&mut out_writer, &new_data[off as usize..])?;
            new_files.insert(key, Entry { size: fid.size, mtime_ns: fid.mtime_ns, off, len });
            emitted += 1;
        } else if let Some(e) = store.files.get(&key).copied() {
            let bytes = store.extract(&e);
            emit_line(&mut out_writer, bytes)?;
            if needs_write {
                let off = new_data.len() as u64;
                new_data.extend_from_slice(bytes);
                let len = new_data.len() as u64 - off;
                new_files.insert(key, Entry { size: e.size, mtime_ns: e.mtime_ns, off, len });
            }
            emitted += 1;
        }
    }
    if let Some(w) = out_writer.as_mut() {
        w.flush()?;
    }

    // persist store atomically (single file → header offsets stay consistent)
    if needs_write {
        save_store(&state_path, &new_files, &new_data)?;
    }

    let summary = json!({
        "sessions": emitted,
        "parsed": emitted - reused,
        "reused": reused,
        "excludedActive": excluded.len(),
        "elapsedMs": t0.elapsed().as_millis() as u64,
    });
    eprintln!("{summary}");
    let _ = io::stderr().flush();
    Ok(())
}

trait OkErr {
    fn ok_err(self, msg: &str) -> Result<String, Box<dyn Error>>;
}
impl OkErr for Option<String> {
    fn ok_err(self, msg: &str) -> Result<String, Box<dyn Error>> {
        self.ok_or_else(|| -> Box<dyn Error> { msg.to_string().into() })
    }
}

fn split_chunks<T>(v: Vec<T>, n: usize) -> Vec<Vec<T>> {
    if v.is_empty() {
        return vec![];
    }
    let n = n.max(1);
    let mut out: Vec<Vec<T>> = (0..n).map(|_| Vec::new()).collect();
    for (i, item) in v.into_iter().enumerate() {
        out[i % n].push(item);
    }
    out.retain(|c| !c.is_empty());
    out
}

fn dirs_sessions_default() -> PathBuf {
    if let Ok(p) = env::var("PI_SESSIONS_DIR") {
        return PathBuf::from(p);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".pi").join("agent").join("sessions")
}

fn dirs_state_default() -> PathBuf {
    if let Ok(p) = env::var("PIDX_STATE") {
        return PathBuf::from(p);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".pi").join("agent").join(".cache").join("pidx-state.json")
}
