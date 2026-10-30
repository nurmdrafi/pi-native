//! doc-check — repo doc-consistency validator, the Rust port of the former
//! scripts/doc-check.mjs (four families, byte-parity output):
//!
//!   md-commands          markdown fenced-block shell validation (syntax,
//!                       binary exists on PATH, script paths, flags in --help;
//!                       mac-only/optional-toolchain/artifact/tmp classes are
//!                       info-only)
//!   skills-inventory     README skills table rows <-> skills/*/SKILL.md dirs
//!   extensions-inventory README Extensions section <-> extensions/* dirs with .ts
//!   env-vars             PI_* vars in code <-> docs, or allowlisted
//!
//! Everything is derived from the repo — no expected counts or inventories live
//! here. No dependencies: the JS used regexes on small inputs where a
//! hand-rolled scan is both simpler to audit and allocation-light.
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

mod mdcmds;

struct Family {
    name: &'static str,
    label: &'static str,
    findings: Vec<String>,
    stats: Option<(usize, Vec<String>)>,
    info: Vec<(&'static str, Vec<String>)>,
}

impl Family {
    fn new(name: &'static str, label: &'static str, findings: Vec<String>) -> Family {
        Family {
            name,
            label,
            findings,
            stats: None,
            info: Vec::new(),
        }
    }

    fn status(&self) -> &'static str {
        if self.findings.is_empty() {
            "PASS"
        } else {
            "FAIL"
        }
    }
}

/// Recursive file walk; unreadable entries are skipped (the JS throws, but a
/// missing directory is the only realistic case and it yields "no files").
fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    // readdirSync sorts (libuv qsorts scandir results); match it, and follow
    // symlinks like statSync does.
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        match fs::metadata(&p) {
            Ok(m) if m.is_dir() => out.extend(walk_files(&p)),
            Ok(_) => out.push(p),
            Err(_) => {}
        }
    }
    out
}

fn dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

/// markdown table row -> trimmed cells (None when the line is not a table row).
fn table_cells(line: &str) -> Option<Vec<String>> {
    let t = line.trim();
    if !t.starts_with('|') {
        return None;
    }
    let inner = t.trim_start_matches('|').trim_end_matches('|');
    Some(inner.split('|').map(|c| c.trim().to_string()).collect())
}

fn eq_ci(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// PI_* token scan with the JS lookbehind's intent: a match must not be the tail
/// of a longer uppercase identifier (ZAI_API_KEY must not yield PI_API_KEY).
fn scan_env_vars(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < b.len() {
        if b[i] == b'P' && b[i + 1] == b'I' && b[i + 2] == b'_' {
            let prev_ok = i == 0 || !(b[i - 1].is_ascii_uppercase() || b[i - 1].is_ascii_digit() || b[i - 1] == b'_');
            if prev_ok {
                let mut j = i + 3;
                while j < b.len() && (b[j].is_ascii_uppercase() || b[j].is_ascii_digit() || b[j] == b'_') {
                    j += 1;
                }
                if j > i + 3 {
                    out.push(text[i..j].to_string());
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn allowlisted(var: &str) -> bool {
    const ALLOW: [&str; 17] = [
        "PI_SUBAGENT_ID",
        "PI_SUBAGENT_NAME",
        "PI_SUBAGENT_AGENT",
        "PI_SUBAGENT_ALLOWED",
        "PI_SUBAGENT_AUTO_EXIT",
        "PI_SUBAGENT_SESSION",
        "PI_SUBAGENT_ACTIVITY_FILE",
        "PI_SUBAGENT_SURFACE",
        "PI_SUBAGENT_PARENT_SESSION",
        "PI_SUBAGENT_START_MS",
        "PI_SUBAGENT_TASK",
        "PI_CLAUDE_SENTINEL",
        "PI_DENY_TOOLS",
        "PI_SESSIONS_DIR",
        "PI_READ_COMPRESS",
        "PI_READ_LINE_CAP",
        "PI_BASH_SHELL",
    ];
    ALLOW.contains(&var)
}

fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

// ---------- family 2: skills-inventory ----------

fn check_skills(root: &Path) -> Family {
    let mut findings = Vec::new();
    let skills_dir = root.join("skills");
    let derived: Vec<String> = dir_names(&skills_dir)
        .into_iter()
        .filter(|d| skills_dir.join(d).join("SKILL.md").exists())
        .collect();

    let candidates = [
        (root.join("README.md"), "README.md"),
        (root.join("docs").join("skills.md"), "docs/skills.md"),
    ];
    let mut src: Option<(&str, Vec<String>, usize)> = None;
    for (path, label) in candidates {
        let Some(text) = read(&path) else { continue };
        let lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
        for (i, line) in lines.iter().enumerate() {
            if let Some(cells) = table_cells(line) {
                let last = cells.len() - 1;
                if eq_ci(&cells[0], "Skill") && eq_ci(&cells[last], "Invocation") {
                    src = Some((label, lines, i));
                    break;
                }
            }
        }
        if src.is_some() {
            break;
        }
    }

    let Some((src_label, lines, header_idx)) = src else {
        findings.push(
            "skills table not found in README.md or docs/skills.md — expected a header row like `| Skill | … | Invocation |`"
                .to_string(),
        );
        return Family::new("skills-inventory", "SKILLS INVENTORY", findings);
    };

    let mut rows: Vec<(String, String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(header_idx + 1) {
        if !line.trim().starts_with('|') {
            break;
        }
        let t = line.trim();
        if !t.is_empty() && t.chars().all(|c| matches!(c, '-' | ':' | ' ' | '|')) {
            continue; // separator row
        }
        if let Some(cells) = table_cells(line) {
            if cells.len() >= 2 {
                let last = cells.len() - 1;
                rows.push((
                    cells[0].replace('`', ""),
                    cells[last].replace('`', ""),
                    i + 1,
                ));
            }
        }
    }

    let mut by_name: HashMap<String, (String, usize)> = HashMap::new();
    for (name, invocation, line) in &rows {
        if let Some((_, first)) = by_name.get(name) {
            findings.push(format!(
                "{src_label}:{line}: duplicate skills table row '{name}' (first at line {first})"
            ));
            continue;
        }
        by_name.insert(name.clone(), (invocation.clone(), *line));
    }
    let mut ordered: Vec<(&String, &(String, usize))> = by_name.iter().collect();
    ordered.sort_by_key(|(_, (_, line))| *line);
    for dir in &derived {
        if !by_name.contains_key(dir) {
            findings.push(format!(
                "skills/{dir}/ has SKILL.md but the skills table ({src_label}) has no row for '{dir}'"
            ));
        }
    }
    for (name, (invocation, line)) in ordered {
        if !derived.iter().any(|d| d == name) {
            findings.push(format!(
                "{src_label}:{line}: skills table row '{name}' has no skills/{name}/SKILL.md"
            ));
        } else if invocation != &format!("/skill:{name}") {
            findings.push(format!(
                "{src_label}:{line}: row '{name}' invocation '{invocation}' ≠ '/skill:{name}'"
            ));
        }
    }
    Family::new("skills-inventory", "SKILLS INVENTORY", findings)
}

// ---------- family 3: extensions-inventory ----------

fn check_extensions(root: &Path) -> Family {
    let mut findings = Vec::new();
    let ext_dir = root.join("extensions");
    let derived: Vec<String> = dir_names(&ext_dir)
        .into_iter()
        .filter(|d| walk_files(&ext_dir.join(d)).iter().any(|f| f.extension().map(|x| x == "ts").unwrap_or(false)))
        .collect();

    let candidates = [
        (root.join("README.md"), "README.md", true),
        (root.join("extensions").join("README.md"), "extensions/README.md", false),
    ];
    let mut src: Option<(&str, Vec<String>, usize, usize, bool)> = None;
    for (path, label, needs_section) in candidates {
        let Some(text) = read(&path) else { continue };
        let lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
        let mut start = 0usize;
        if needs_section {
            match lines
                .iter()
                .position(|l| l.trim_end() == "## Extensions" || l.trim_end().replace("  ", " ") == "## Extensions")
            {
                Some(i) => start = i + 1,
                None => continue,
            }
        }
        let mut end = lines.len();
        if needs_section {
            for (i, l) in lines.iter().enumerate().skip(start) {
                if l.starts_with("## ") {
                    end = i;
                    break;
                }
            }
        }
        src = Some((label, lines, start, end, needs_section));
        break;
    }

    let Some((src_label, lines, start, end, _)) = src else {
        findings.push(
            "`## Extensions` section not found in README.md and extensions/README.md missing — extension inventory cannot be verified".to_string(),
        );
        return Family::new("extensions-inventory", "EXTENSIONS INVENTORY", findings);
    };

    // `extensions/` itself names the section subject, not a unit; a bare file
    // name (no slash) never matches. Machine-local dirs are not units either.
    const NON_EXTENSION_DIRS: [&str; 3] = ["bin", "npm", "git"];
    let mut claimed: BTreeMap<String, usize> = BTreeMap::new();
    for (i, line) in lines.iter().enumerate().take(end).skip(start) {
        let bytes = line.as_bytes();
        let mut k = 0;
        while k < bytes.len() {
            if bytes[k] == b'`' {
                if let Some(rel) = line[k + 1..].find('`') {
                    let token = &line[k + 1..k + 1 + rel];
                    let ok = token.ends_with('/')
                        && token[..token.len() - 1]
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                        && !token[..token.len() - 1].is_empty();
                    if ok {
                        let name = token[..token.len() - 1].to_string();
                        if name != "extensions" && !NON_EXTENSION_DIRS.contains(&name.as_str()) {
                            claimed.entry(name).or_insert(i + 1);
                        }
                    }
                    k += 1 + rel + 1;
                    continue;
                }
                break;
            }
            k += 1;
        }
    }

    for dir in &derived {
        if !claimed.contains_key(dir) {
            findings.push(format!(
                "extensions/{dir}/ contains TypeScript but the extensions inventory ({src_label}) never mentions `{dir}/`"
            ));
        }
    }
    for (name, line) in &claimed {
        if !derived.iter().any(|d| d == name) {
            findings.push(format!(
                "{src_label}:{line}: extensions inventory mentions `{name}/` but extensions/{name}/ has no .ts files"
            ));
        }
    }
    Family::new("extensions-inventory", "EXTENSIONS INVENTORY", findings)
}

// ---------- family 4: env-vars ----------

fn check_env(root: &Path) -> Family {
    let mut findings = Vec::new();
    let doc_set = "README.md / extensions READMEs";

    let mut code_files = Vec::new();
    for f in walk_files(&root.join("extensions")) {
        if f.extension().map(|x| x == "ts").unwrap_or(false) {
            code_files.push(f);
        }
    }
    if let Ok(entries) = fs::read_dir(root.join("scripts")) {
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort(); // readdirSync parity
        for p in paths {
            if p.extension().map(|x| x == "mjs").unwrap_or(false) {
                code_files.push(p);
            }
        }
    }
    for d in dir_names(&root.join("skills")) {
        code_files.extend(walk_files(&root.join("skills").join(d).join("scripts")));
    }
    // The dashboard server reads its own PI_DASH_* knobs and lives outside the
    // extension/script trees above; without this its documented vars read as
    // "documented but not found".
    code_files.extend(walk_files(&root.join("dashboard").join("scripts")));

    let mut in_code: BTreeMap<String, String> = BTreeMap::new();
    for f in &code_files {
        let Some(text) = read(f) else { continue };
        let rel = f.to_string_lossy();
        let rel = rel.get(root.to_string_lossy().len() + 1..).unwrap_or(&rel).to_string();
        for v in scan_env_vars(&text) {
            in_code.entry(v).or_insert_with(|| rel.clone());
        }
    }

    let mut doc_files = vec![root.join("README.md"), root.join("extensions").join("README.md")];
    for d in dir_names(&root.join("extensions")) {
        let p = root.join("extensions").join(d).join("README.md");
        if p.exists() {
            doc_files.push(p);
        }
    }
    let mut in_docs: BTreeMap<String, String> = BTreeMap::new();
    for f in &doc_files {
        let Some(text) = read(f) else { continue };
        let rel = f.to_string_lossy();
        let rel = rel.get(root.to_string_lossy().len() + 1..).unwrap_or(&rel).to_string();
        for v in scan_env_vars(&text) {
            in_docs.entry(v).or_insert_with(|| rel.clone());
        }
    }

    for (v, loc) in &in_code {
        if in_docs.contains_key(v) || allowlisted(v) {
            continue;
        }
        findings.push(format!(
            "{v} used in {loc} but not documented in {doc_set} (and not allowlisted — document it or classify it in ENV_VAR_ALLOWLIST)"
        ));
    }
    for (v, loc) in &in_docs {
        if in_code.contains_key(v) {
            continue;
        }
        findings.push(format!(
            "{v} documented in {loc} but not found in scanned code (extensions/**/*.ts, scripts/*.mjs, skills/*/scripts/**)"
        ));
    }
    Family::new("env-vars", "ENV-VARS", findings)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|a| a == "--json");
    let root = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let md = mdcmds::check_md_commands(&root);
    let families = vec![
        Family {
            name: "md-commands",
            label: "MD-COMMANDS",
            findings: md.findings,
            stats: Some((md.md_scanned, md.binaries_ok)),
            info: md.info,
        },
        check_skills(&root),
        check_extensions(&root),
        check_env(&root),
    ];

    let failed = families.iter().any(|f| f.status() == "FAIL");
    if json {
        println!("{}", to_json(&families));
    } else {
        println!("{}", render_human(&families, failed));
    }
    std::process::exit(if failed { 1 } else { 0 });
}

/// Byte-parity with the JS renderHuman: label line, two-space stats, two-space
/// `(info, N)` headers, four-space items, two-space findings, blank line per
/// family, then the summary line.
fn render_human(families: &[Family], failed: bool) -> String {
    let mut out: Vec<String> = Vec::new();
    for f in families {
        out.push(format!("{} ({})", f.label, f.status()));
        if let Some((scanned, bins)) = &f.stats {
            out.push(format!("  md files scanned: {scanned}"));
            out.push(format!(
                "  binaries OK: {}",
                if bins.is_empty() { "(none)".to_string() } else { bins.join(" ") }
            ));
        }
        for (label, items) in &f.info {
            out.push(format!("  {label} (info, {}):", items.len()));
            for x in items {
                out.push(format!("    {x}"));
            }
        }
        for x in &f.findings {
            out.push(format!("  {x}"));
        }
        out.push(String::new());
    }
    let failed_count = families.iter().filter(|f| f.status() == "FAIL").count();
    let total: usize = families.iter().map(|f| f.findings.len()).sum();
    out.push(if failed {
        format!("summary: {failed_count}/{} families failed, {total} finding(s)", families.len())
    } else {
        format!("summary: all {} families passed", families.len())
    });
    out.join("\n")
}

/// JSON.stringify(toJson(result), null, 2) — name/status/findings per family.
fn to_json(families: &[Family]) -> String {
    let mut out = String::from("{\n  \"families\": [");
    for (i, f) in families.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("\n    {\n");
        out.push_str(&format!("      \"name\": \"{}\",\n", json_escape(f.name)));
        out.push_str(&format!("      \"status\": \"{}\",\n", f.status()));
        if f.findings.is_empty() {
            out.push_str("      \"findings\": []\n");
        } else {
            out.push_str("      \"findings\": [\n");
            let last = f.findings.len() - 1;
            for (j, x) in f.findings.iter().enumerate() {
                out.push_str(&format!(
                    "        \"{}\"{}\n",
                    json_escape(x),
                    if j < last { "," } else { "" }
                ));
            }
            out.push_str("      ]\n");
        }
        out.push_str("    }");
    }
    out.push_str("\n  ]\n}");
    out
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_cells_splits_and_trims() {
        assert_eq!(
            table_cells("| Skill | Notes | Invocation |"),
            Some(vec!["Skill".to_string(), "Notes".to_string(), "Invocation".to_string()])
        );
        assert_eq!(table_cells("not a row"), None);
    }

    #[test]
    fn env_scan_respects_left_boundary() {
        assert_eq!(scan_env_vars("PI_FOO and PI_BAR_2"), vec!["PI_FOO", "PI_BAR_2"]);
        // the PI_ tail of a longer identifier is not a var reference
        assert!(scan_env_vars("ZAI_API_KEY").is_empty());
        assert!(scan_env_vars("XPI_FOO").is_empty());
    }
}
