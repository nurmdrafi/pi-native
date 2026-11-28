use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

const USAGE_FIELDS: [&str; 6] = ["turns", "input", "output", "reasoning", "cacheRead", "cacheWrite"];
const UNKNOWN_TOOL: &str = "(unknown)";

type Counts = BTreeMap<String, u64>;

fn count(counts: &mut Counts, name: &str) {
    *counts.entry(name.into()).or_default() += 1;
}

pub(super) fn family(text: &str) -> Option<&'static str> {
    const FAMILIES: &[(&str, &str)] = &[
        ("Hygiene (Reader-bypass)", "reader_bypass"),
        ("Token Economy (Re-read)", "re_read"),
        ("Permission Gate", "gate"),
        ("Anchor Guard", "anchor"),
        ("Token Economy", "tokens"),
        ("Loop Guard", "loop"),
        ("Phase", "phase"),
        ("Commit Message", "commit"),
        ("Commitlint", "commit"),
        ("Toolchain", "toolchain"),
        ("Search", "search"),
        ("Search Guard", "search"),
        ("SearchGuard", "search"),
        ("Destructive", "destructive"),
        ("Locate-first", "locate_first"),
        ("Hygiene", "hygiene"),
        ("Bash cap", "bash_cap"),
        ("Output scrub", "output_scrub"),
    ];
    FAMILIES.iter().find_map(|(prefix, tag)| {
        let rest = text.trim_start().strip_prefix(prefix)?;
        (rest.starts_with(':') || rest.starts_with(" (")).then_some(*tag)
    })
}

pub(super) fn annotate(result: &mut Value, content: &Value, error: bool) {
    let mut texts = items(content)
        .iter()
        .filter_map(|block| block.get("text")?.as_str());
    let first = content.as_str().or_else(|| texts.next()).unwrap_or_default();
    if !error {
        // Gate advisories append a text block after the original result. A
        // prefix in the original block alone is not evidence of a warning.
        let warnings: BTreeSet<_> = texts.filter_map(family).collect();
        if !warnings.is_empty() {
            result["warnings"] = serde_json::json!(warnings);
        }
    } else if let Some(tag) = family(first) {
        result["blk"] = Value::from(tag);
    } else {
        let last = first.lines().last().unwrap_or_default().trim();
        let kind = if last == "Command aborted" || first.trim() == "Aborted" {
            "cancelled"
        } else if last.starts_with("Command timed out after ") {
            "timeout"
        } else if last == "Command exited with code 1" {
            "shell_exit_1"
        } else if last.starts_with("Command exited with code ") {
            "shell_nonzero"
        } else if ["pibash", "piread", "piedit", "piwrite", "pidx"].iter().any(|name| {
            first.trim_start().strip_prefix(name).is_some_and(|rest| {
                rest.starts_with(": native execution failed (")
            })
        }) {
            "native_failure"
        } else {
            "other_error"
        };
        result["class"] = Value::from(kind);
    }
}

fn literal_rg(command: &str) -> bool {
    // Only a simple literal invocation: shell operators, expansions, globs
    // and command chains make the owner of exit code 1 ambiguous.
    !command.contains(['\n', '\r'])
        && command.trim_start().starts_with("rg ")
        && command.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b" \t_./:-".contains(&b)
        })
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    calls: u64,
    results: u64,
    result_bytes: u64,
    outcomes: Counts,
    gate_blocks: Counts,
    warnings: Counts,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Report {
    sessions: u64,
    usage: BTreeMap<&'static str, i64>,
    tools: BTreeMap<String, Tool>,
    recovery: BTreeMap<String, Counts>,
}

fn items(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn tool_name(v: &Value) -> &str {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b"_-.:".contains(&b)
        }))
        .unwrap_or(UNKNOWN_TOOL)
}

fn outcome<'a>(result: &'a Value, call: Option<&Value>) -> &'a str {
    if result["err"] != true {
        "ok"
    } else if result["blk"].is_string() {
        "gate_block"
    } else {
        match result["class"].as_str() {
            Some("shell_exit_1") if call.and_then(|c| c["cmd"].as_str()).is_some_and(literal_rg) => "no_match",
            Some("shell_exit_1") => "shell_nonzero",
            Some(kind) => kind,
            None => "other_error",
        }
    }
}

fn recovery(family: &str, next: Option<&Vec<Option<&Value>>>) -> &'static str {
    let Some(next) = next else { return "no_next_batch" };
    if next.iter().all(|r| r.is_some_and(|r| r["err"] == false)) {
        "batch_ok"
    } else if next.iter().flatten().any(|r| r["blk"] == family) {
        "same_family_block"
    } else if next.iter().flatten().any(|r| r["blk"].is_string()) {
        "different_gate_block"
    } else if next.iter().flatten().any(|r| r["err"] == true) {
        "batch_error"
    } else {
        "missing_result"
    }
}

impl Report {
    pub(super) fn observe(&mut self, session: &Value) {
        self.sessions += 1;
        if let Some(usage) = session["usage"].as_object() {
            for key in USAGE_FIELDS {
                let total = usage.values().filter_map(|model| model[key].as_i64()).sum::<i64>();
                *self.usage.entry(key).or_default() += total;
            }
        }
        let results: HashMap<_, _> = items(&session["results"])
            .iter().filter_map(|r| Some((r["id"].as_str()?, r))).collect();
        let mut calls = HashMap::new();
        let mut batches: HashMap<u64, Vec<Option<&Value>>> = HashMap::new();
        for call in items(&session["calls"]) {
            let Some(id) = call["id"].as_str() else { continue };
            let tool = self.tools.entry(tool_name(&call["name"]).into()).or_default();
            tool.calls += 1;
            let result = results.get(id).copied();
            if result.is_none() {
                count(&mut tool.outcomes, "missing_result");
            }
            if let Some(batch) = call["batch"].as_u64() {
                batches.entry(batch).or_default().push(result);
            }
            calls.insert(id, call);
        }
        for (id, result) in results {
            let call = calls.get(id).copied();
            let name = call.map_or(UNKNOWN_TOOL, |c| tool_name(&c["name"]));
            let tool = self.tools.entry(name.into()).or_default();
            tool.results += 1;
            tool.result_bytes += result["bytes"].as_u64().unwrap_or(0);
            count(&mut tool.outcomes, outcome(result, call));
            for warning in items(&result["warnings"]).iter().filter_map(Value::as_str) {
                count(&mut tool.warnings, warning);
            }
            if let Some(family) = result["blk"].as_str() {
                count(&mut tool.gate_blocks, family);
                let next = result["batch"].as_u64().and_then(|n| batches.get(&(n + 1)));
                count(self.recovery.entry(family.into()).or_default(), recovery(family, next));
            }
        }
    }
}
