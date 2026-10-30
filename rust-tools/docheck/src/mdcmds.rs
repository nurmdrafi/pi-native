//! Family 1 (md-commands) — port of `checkMdCommands` from scripts/doc-check.mjs
//! (mdcmdcheck v2 carried over). Byte-parity with the JS on this repo is the
//! acceptance bar (docs/plans/permission_gate_implementation_plan.md §13).
//!
//! Split into pure parsers (unit-tested here, no spawns) and the two-process
//! probes (`bash -n`, `--help`), which are exercised by the parity diff and the
//! Node fixture tests rather than unit tests.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const SHELL_LANGS: &[&str] = &["sh", "bash", "shell", "console", "zsh"];
const BUILTINS: &[&str] = &[
    "echo", "cd", "printf", "export", "set", "unset", "source", "alias", "local", "return",
    "exit", "read", "test", "[", "eval", "true", "false", "pwd", "shift", "command", "type",
    "wait", "trap", "umask", "pushd", "popd", "dirs", "hash", "let", "declare", "readonly",
    "getopts", "shopt", "ulimit", "jobs", "fg", "bg", "kill", "times", "break", "continue",
    "then", "else", "fi", "do", "done", "if", "while", "for", "until", "case", "esac",
    "function", "in", "select", "time", "coproc", "exec",
];
const INTERPRETERS: &[&str] = &["node", "npm", "npx", "python", "python3", "bash", "sh", "env", "deno", "bun"];
const MAC_ONLY: &[&str] = &[
    "pbcopy", "pbpaste", "osascript", "launchctl", "security", "codesign", "mdfind", "open",
    "defaults", "brew", "say", "caffeinate", "networksetup", "screencapture", "textutil",
    "pluid", "xcodebuild", "swift", "sw_vers", "softwareupdate", "pmset", "system_profiler",
    "diskutil", "hdiutil", "installer", "port",
];
const SOURCED: &[&str] = &["nvm"];
const OPTIONAL_TOOLCHAINS: &[&str] = &[
    "cargo", "rustc", "rustup", "rustfmt", "perf", "valgrind", "hyperfine", "llvm-profdata",
    "llvm-bolt", "inferno-collapse-perf", "inferno-flamegraph", "loom",
];
// KNOWN regex alternation, in JS order (order is irrelevant to the boolean test).
const KNOWN: &[&str] = &[
    "rg", "grep", "egrep", "fgrep", "find", "xargs", "jq", "sed", "cut", "sort", "uniq", "wc",
    "head", "tail", "ast-grep", "git", "npm", "npx", "node", "tvly", "pi", "fd", "awk", "tr",
    "chmod", "ls", "cat", "curl", "sh", "bash", "command", "skillcheck.sh",
];
const FLAG_WAIVERS: &[&str] = &[
    "git --hard",
    "git reset --hard",
    // subcommand flags the base `git --help` never lists
    "git --porcelain",
    "curl --proto",
    "curl --tlsv1",
];

// ---------- pure parsers (JS parity: see scripts/doc-check.mjs) ----------

/// JS `line.split(/\s+/)[0]` on a string that is trimmed / has no leading run.
pub fn first_word(t: &str) -> &str {
    t.split_whitespace().next().unwrap_or("")
}

/// Strip a leading `$ ` / `# ` / `> ` prompt (JS `^[$#>]\s+`).
fn strip_prompt(t: &str) -> &str {
    let first = t.chars().next();
    if matches!(first, Some('$') | Some('#') | Some('>')) {
        let after = t[1..].chars().next();
        if matches!(after, Some(c) if c.is_whitespace()) {
            return t[1..].trim_start();
        }
    }
    t
}

/// Quote-aware split on `||`, `&&`, `|`, `;` (fenced lines).
fn char_len(b: u8) -> usize {
    match b {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Copy one full UTF-8 char starting at byte `i`, advancing past it.
fn push_char(seg: &mut String, line: &str, i: usize) -> usize {
    let l = char_len(line.as_bytes()[i]);
    seg.push_str(&line[i..i + l]);
    l
}

pub fn seg_split(line: &str) -> Vec<String> {
    let b = line.as_bytes();
    let mut segs: Vec<String> = vec![String::new()];
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' || c == b'"' {
            // copy the quoted region verbatim; operators inside never split
            let mut j = i + 1;
            while j < b.len() && b[j] != c {
                j += char_len(b[j]);
            }
            let seg = segs.last_mut().unwrap();
            seg.push_str(&line[i..j.min(b.len())]);
            if j < b.len() {
                seg.push(c as char);
                i = j + 1;
            } else {
                i = j; // unterminated quote: JS keeps appending to the end
            }
            continue;
        }
        if c == b'|' && i + 1 < b.len() && b[i + 1] == b'|' {
            segs.push(String::new());
            i += 2;
            continue;
        }
        if c == b'&' && i + 1 < b.len() && b[i + 1] == b'&' {
            segs.push(String::new());
            i += 2;
            continue;
        }
        if c == b'|' || c == b';' {
            segs.push(String::new());
            i += 1;
            continue;
        }
        i += push_char(segs.last_mut().unwrap(), line, i);
    }
    segs
}

/// Inline-prose split: `;` / `&&` / `||` always, single `|` only when spaced
/// both sides (prose alternation `git commit|push` must stay one segment).
pub fn inline_seg_split(line: &str) -> Vec<String> {
    let b = line.as_bytes();
    let mut segs: Vec<String> = vec![String::new()];
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' || c == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != c {
                j += char_len(b[j]);
            }
            let seg = segs.last_mut().unwrap();
            seg.push_str(&line[i..j.min(b.len())]);
            if j < b.len() {
                seg.push(c as char);
                i = j + 1;
            } else {
                i = j;
            }
            continue;
        }
        if c == b';' || (c == b'&' && i + 1 < b.len() && b[i + 1] == b'&') || (c == b'|' && i + 1 < b.len() && b[i + 1] == b'|') {
            segs.push(String::new());
            if c != b';' {
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == b'|' {
            let prev_ws = line[..i].chars().last().is_some_and(|c| c.is_whitespace());
            let next_ws = line[i + 1..].chars().next().is_some_and(|c| c.is_whitespace());
            if prev_ws && next_ws {
                segs.push(String::new());
                i += 1;
                continue;
            }
        }
        i += push_char(segs.last_mut().unwrap(), line, i);
    }
    segs
}

/// Strip leading `VAR=value` assignments (quote/paren aware).
/// `None` = unterminated `$(…` substitution (JS returns null).
/// `^[A-Za-z_][A-Za-z0-9_]*=` — returns the index just past `=`.
fn assignment_prefix_len(t: &str) -> Option<usize> {
    let b = t.as_bytes();
    let first = *b.first()?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    if i < b.len() && b[i] == b'=' {
        Some(i + 1)
    } else {
        None
    }
}

pub fn strip_assignments(t: &str) -> Option<String> {
    let mut t = t.to_string();
    loop {
        let Some(start) = assignment_prefix_len(&t) else {
            return Some(t);
        };
        let mut q: Option<char> = None;
        let mut depth = 0usize;
        let mut cut: Option<usize> = None;
        for (idx, c) in t[start..].char_indices() {
            if let Some(qc) = q {
                if c == qc {
                    q = None;
                }
                continue;
            }
            if c == '\'' || c == '"' {
                q = Some(c);
            } else if c == '(' {
                depth += 1;
            } else if c == ')' && depth > 0 {
                depth -= 1;
            } else if c.is_whitespace() && depth == 0 {
                cut = Some(start + idx);
                break;
            }
        }
        if depth > 0 {
            return None; // unterminated $(… substitution
        }
        let cut = cut.unwrap_or(t.len());
        t = t[cut..].trim_start().to_string();
    }
}

fn strip_leaders(t: &str) -> &str {
    let head = first_word(t);
    if head == "sudo" || head == "command" || head == "nohup" {
        let rest = &t[head.len()..];
        let trimmed = rest.trim_start();
        if trimmed.len() != rest.len() {
            return trimmed; // the regex requires trailing whitespace
        }
    }
    t
}

pub fn head_tok(seg: &str) -> Option<String> {
    let t = strip_prompt(seg.trim());
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let t = strip_assignments(t).unwrap_or_default();
    if t.is_empty() {
        return None;
    }
    let t = strip_leaders(&t);
    let tok = first_word(t);
    if tok.is_empty() {
        return None;
    }
    let first = tok.chars().next().unwrap();
    if "-{(<>} \"#`$%&*".contains(first) {
        return None;
    }
    if is_bare_assignment(tok) {
        return None;
    }
    if BUILTINS.contains(&tok) {
        return None;
    }
    Some(tok.trim_end_matches([';', '\'', '"']).to_string())
}

pub fn sub_cmd(seg: &str, tok: &str) -> Option<String> {
    let t = strip_prompt(seg.trim());
    let t = strip_assignments(t).unwrap_or_default();
    let mut it = t.split_whitespace();
    if it.next()? != tok {
        return None;
    }
    let s = it.next().unwrap_or("");
    let mut chars = s.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    (first_ok && rest_ok && !s.starts_with('-')).then(|| s.to_string())
}

/// KNOWN.test(line + ' ') — head token must be a known command followed by
/// whitespace (the appended space makes a bare head token still match).
pub fn is_known(line: &str) -> bool {
    let s = format!("{line} ");
    KNOWN.iter().any(|alt| {
        s.starts_with(alt) && s[alt.len()..].chars().next().is_some_and(|c| c.is_whitespace())
    })
}

/// Cut the line at the first `…` or `...` (JS split + [0]).
pub fn truncate_ellipsis(line: &str) -> &str {
    match (line.find('…'), line.find("...")) {
        (Some(a), Some(b)) => &line[..a.min(b)],
        (Some(a), None) => &line[..a],
        (None, Some(b)) => &line[..b],
        (None, None) => line,
    }
}

/// `<placeholder>` → `"<placeholder>"` before `bash -n` (JS `<([a-zA-Z][^<>\n]*)>`).
pub fn quote_placeholders(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' && body[i + 1..].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            let first = body[i + 1..].chars().next().unwrap();
            let inner_start = i + 1 + first.len_utf8();
            let mut end = None;
            for (idx, c) in body[inner_start..].char_indices() {
                if c == '>' {
                    end = Some(inner_start + idx);
                    break;
                }
                if c == '<' || c == '\n' {
                    break;
                }
            }
            if let Some(e) = end {
                out.push('"');
                out.push_str(&body[i..=e]);
                out.push('"');
                i = e + 1;
                continue;
            }
        }
        i += push_char(&mut out, body, i);
    }
    out
}

/// Drop a `#`-comment that starts the line or follows whitespace (JS `(^|\s)#.*$`).
fn strip_comment(l: &str) -> &str {
    let mut prev_ws_or_start = true;
    for (i, c) in l.char_indices() {
        if c == '#' && prev_ws_or_start {
            return &l[..i];
        }
        prev_ws_or_start = c.is_whitespace();
    }
    l
}

/// Comment strip + backslash-continuation join (JS `joined` reducer).
pub fn join_lines(body: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut carried = String::new();
    for l in body.split('\n') {
        let clean = strip_comment(l).trim_end();
        if clean.trim().is_empty() {
            continue;
        }
        if let Some(stripped) = clean.strip_suffix('\\') {
            carried.push_str(stripped);
            carried.push(' ');
        } else {
            let mut s = std::mem::take(&mut carried);
            s.push_str(clean);
            lines.push(s);
        }
    }
    if !carried.is_empty() {
        lines.push(carried);
    }
    lines
}

/// ```` ```([a-zA-Z0-9]*)\n([\s\S]*?)``` ```` — non-overlapping, lazy body.
pub fn fenced_blocks(text: &str) -> Vec<(String, String)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = find_sub(b, b"```", i) {
        let mut j = rel + 3;
        let lang_start = j;
        while j < b.len() && b[j].is_ascii_alphanumeric() {
            j += 1;
        }
        if j < b.len() && b[j] == b'\n' {
            let lang = &text[lang_start..j];
            let body_start = j + 1;
            match find_sub(b, b"```", body_start) {
                Some(end) => {
                    out.push((lang.to_string(), text[body_start..end].to_string()));
                    i = end + 3;
                }
                None => return out, // no closing fence: regex exec ends the scan
            }
        } else {
            i = rel + 1; // regex retries from the next start position
        }
    }
    out
}

/// `` `([^`\n]+)` `` — non-empty single-backtick spans on one line.
pub fn inline_spans(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = find_sub(b, b"`", i) {
        let mut j = rel + 1;
        let mut found = None;
        while j < b.len() {
            let c = b[j];
            if c == b'`' {
                found = Some(j);
                break;
            }
            if c == b'\n' {
                break;
            }
            j += char_len(c);
        }
        match found {
            Some(e) if e > rel + 1 => {
                out.push(text[rel + 1..e].to_string());
                i = e + 1;
            }
            _ => i = rel + 1, // empty span: regex advances one position
        }
    }
    out
}

/// Remove `X\b` overstrike pairs (JS `.\x08` — `.` never matches a newline).
pub fn strip_overstrike(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\n' && c != '\r' && it.peek() == Some(&'\u{08}') {
            it.next(); // drop the backstroke too
        } else {
            out.push(c);
        }
    }
    out
}

/// All `--?[a-zA-Z][a-zA-Z0-9-]*` tokens of `--help` output (help side).
pub fn extract_help_flags(out: &str) -> Vec<String> {
    let b = out.as_bytes();
    let mut res = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'-' {
            // `--?` greedy: two dashes first, backtracking to one
            let two = i + 2 < b.len() && b[i + 1] == b'-' && b[i + 2].is_ascii_alphabetic();
            let one = b.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic());
            if two || one {
                let letter = if two { i + 2 } else { i + 1 };
                let mut k = letter + 1;
                while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'-') {
                    k += 1;
                }
                res.push(out[i..k].to_string());
                i = k;
                continue;
            }
        }
        i += char_len(b[i]);
    }
    res
}

/// All `--[a-zA-Z][a-zA-Z0-9-]*` tokens of a command segment (doc side,
/// double dash only — unlike the help side there is no `-x` form).
pub fn extract_seg_flags(seg: &str) -> Vec<String> {
    let b = seg.as_bytes();
    let mut res = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'-'
            && b.get(i + 1) == Some(&b'-')
            && b.get(i + 2).is_some_and(|c| c.is_ascii_alphabetic())
        {
            let mut k = i + 3;
            while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'-') {
                k += 1;
            }
            res.push(seg[i..k].to_string());
            i = k;
        } else {
            i += char_len(b[i]);
        }
    }
    res
}

/// `^(\.\/|\.\.\/|scripts\/|bin\/)` or `*.sh`.
fn is_script_path(tok: &str) -> bool {
    tok.starts_with("./")
        || tok.starts_with("../")
        || tok.starts_with("scripts/")
        || tok.starts_with("bin/")
        || tok.ends_with(".sh")
}

/// `[a-z_]+=\S*$` — a bare assignment remainder, never a command.
fn is_bare_assignment(tok: &str) -> bool {
    let Some(eq) = tok.find('=') else {
        return false;
    };
    let (name, val) = tok.split_at(eq);
    let val = &val[1..];
    !name.is_empty()
        && name.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
        && !val.chars().any(|c| c.is_whitespace())
}

fn is_handoff_or_ignored(rel_md: &str) -> bool {
    if rel_md == "CHANGELOG.md" {
        return true;
    }
    if let Some(rest) = rel_md.strip_prefix("HANDOFF-") {
        if let Some(name) = rest.strip_suffix(".md") {
            if !name.contains('/') {
                return true;
            }
        }
    }
    rel_md.starts_with("handoff/") || rel_md.starts_with("audit-reports/")
}

fn truncate_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

// ---------- filesystem + spawn layer (parity: PATH walk, probes, buckets) ----------

fn push_uniq(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

fn rel_of(md: &Path, root: &Path) -> String {
    md.strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| md.display().to_string())
}

/// Markdown walk: skip `node_modules`, `.git`, and a root-level `git/`
/// (external clones). readdirSync sorts entries (libuv qsorts scandir results),
/// so the walk sorts each directory's entries by name bytes to match.
fn walk_mds(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        if name == "node_modules" || name == ".git" || (dir == root && name == "git") {
            continue;
        }
        let p = dir.join(&name);
        let Ok(meta) = fs::metadata(&p) else {
            continue;
        };
        if meta.is_dir() {
            walk_mds(root, &p, out);
        } else if name.ends_with(".md") {
            out.push(p);
        }
    }
}

#[cfg(unix)]
fn is_executable(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_m: &fs::Metadata) -> bool {
    true
}

/// In-process `command -v`: walk $PATH, require a regular file with an exec
/// bit. A path-looking token (contains `/`) just needs to exist.
fn has_bin(tok: &str, cache: &mut HashMap<String, bool>) -> bool {
    if let Some(v) = cache.get(tok) {
        return *v;
    }
    let ok = if tok.contains('/') {
        Path::new(tok).exists()
    } else {
        let path = std::env::var("PATH").unwrap_or_default();
        path.split(':')
            .filter(|d| !d.is_empty())
            .any(|dir| {
                let p = Path::new(dir).join(tok);
                fs::metadata(&p)
                    .map(|m| m.is_file() && is_executable(&m))
                    .unwrap_or(false)
            })
    };
    cache.insert(tok.to_string(), ok);
    ok
}

/// Bare script name resolvable under any skills/*/scripts/ (sibling-skill refs).
fn harness_script(root: &Path, tok: &str) -> bool {
    let Ok(entries) = fs::read_dir(root.join("skills")) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().join("scripts").join(tok).exists())
}

fn is_reference_doc(md: &Path, root: &Path) -> bool {
    let rel = rel_of(md, root);
    rel.contains("/reference/") || rel.contains("/references/")
}

/// `bash -n` syntax probe. stdout/stderr are discarded — only the exit status
/// matters, and null streams make the stdin write deadlock-free.
fn bash_n_ok(input: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("bash")
        .arg("-n")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(input.as_bytes());
    }
    matches!(child.wait(), Ok(s) if s.success())
}

/// Run `bin args --help`, capture stdout, kill after `timeout_secs`.
/// `None` = no output (spawn failure, nonzero exit, or timeout) — the JS folds
/// all of these into an unresolved probe, never a missing flag.
fn probe(bin: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return None,
        }
    }
    let buf = rx.recv_timeout(Duration::from_secs(5)).ok()?;
    let s = String::from_utf8_lossy(&buf).into_owned();
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Resolve every probe key, spread over the available cores. Each entry is an
/// independent process spawn (a tool's `--help`; git's help path runs `man` plus
/// its formatter), so the wall clock becomes the slowest chunk instead of the
/// sum. Results come back in input order, which keeps findings byte-identical.
fn resolve_help_flags(
    keys: &[(String, Vec<String>)],
) -> Vec<Option<std::collections::HashSet<String>>> {
    if keys.is_empty() {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(keys.len());
    let mut bounds = Vec::with_capacity(threads);
    let mut start = 0usize;
    for i in 0..threads {
        let end = start + (keys.len() - start) / (threads - i);
        bounds.push((start, end));
        start = end;
    }
    let mut parts: Vec<Vec<Option<std::collections::HashSet<String>>>> = Vec::with_capacity(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = bounds
            .iter()
            .map(|&(a, b)| {
                scope.spawn(move || {
                    keys[a..b].iter().map(|(k, _)| help_flags_one(k)).collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            parts.push(h.join().expect("probe worker"));
        }
    });
    parts.into_iter().flatten().collect()
}

/// One probe: `bin [arg] --help`, parsed into the flag set. `None` means the
/// probe produced no output (spawn failure, nonzero exit, timeout) — never a
/// missing flag.
fn help_flags_one(key: &str) -> Option<std::collections::HashSet<String>> {
    let (bin, args): (&str, Vec<&str>) = match key.split_once(' ') {
        Some((b, s)) => (b, vec![s, "--help"]),
        None => (key, vec!["--help"]),
    };
    let out = probe(bin, &args, 15).or_else(|| probe(bin, &args, 45))?;
    let stripped = strip_overstrike(&out);
    Some(extract_help_flags(&stripped).into_iter().collect())
}

fn add_flags(flag_by_key: &mut Vec<(String, Vec<String>)>, key: String, flags: Vec<String>) {
    if let Some((_, set)) = flag_by_key.iter_mut().find(|(k, _)| *k == key) {
        for f in flags {
            if !set.contains(&f) {
                set.push(f);
            }
        }
    } else {
        flag_by_key.push((key, flags));
    }
}

pub struct MdFamily {
    pub findings: Vec<String>,
    pub md_scanned: usize,
    pub binaries_ok: Vec<String>,
    pub info: Vec<(&'static str, Vec<String>)>,
}

pub fn check_md_commands(root: &Path) -> MdFamily {
    let mut bin_cache: HashMap<String, bool> = HashMap::new();
    let mut bin_seen: Vec<String> = Vec::new();
    let mut flag_by_key: Vec<(String, Vec<String>)> = Vec::new();
    let mut syntax_fail: Vec<String> = Vec::new();
    let mut bin_fail: Vec<String> = Vec::new();
    let mut mac_only_refs: Vec<String> = Vec::new();
    let mut script_missing: Vec<String> = Vec::new();
    let mut flag_fail: Vec<String> = Vec::new();
    let mut on_demand_refs: Vec<String> = Vec::new();
    let mut optional_toolchain_refs: Vec<String> = Vec::new();
    let mut artifact_refs: Vec<String> = Vec::new();
    let mut unresolved_probes: Vec<String> = Vec::new();

    let mut mds: Vec<PathBuf> = Vec::new();
    walk_mds(root, root, &mut mds);

    // pass 1: fenced shell blocks
    for md in &mds {
        let Ok(bytes) = fs::read(md) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for (lang, body) in fenced_blocks(&text) {
            if !SHELL_LANGS.contains(&lang.as_str()) {
                continue;
            }
            let rel = rel_of(md, root);
            let syntax_input = quote_placeholders(&body);
            if !bash_n_ok(&syntax_input) {
                let first = body
                    .split('\n')
                    .find(|l| !l.trim().is_empty())
                    .map(|l| truncate_chars(l, 60))
                    .unwrap_or("undefined");
                syntax_fail.push(format!("{rel} :: {first}"));
            }
            for line in join_lines(&body) {
                for seg in seg_split(&line) {
                    let Some(tok) = head_tok(&seg) else {
                        continue;
                    };
                    let entry = format!("{rel}: {tok}");
                    let snippet = format!("{entry}  <<< {}", truncate_chars(&line, 70));
                    if is_script_path(&tok) {
                        // candidates: md's dir, repo root, and skill root
                        // (nearest ancestor holding SKILL.md, up to root)
                        let md_dir = md.parent().unwrap_or(root);
                        let mut skill_root = md_dir;
                        let mut c2 = md_dir;
                        loop {
                            if c2.join("SKILL.md").exists() {
                                skill_root = c2;
                                break;
                            }
                            if c2 == root {
                                break;
                            }
                            match c2.parent() {
                                Some(p) => c2 = p,
                                None => break,
                            }
                        }
                        let cands = [md_dir.join(&tok), root.join(&tok), skill_root.join(&tok)];
                        if !cands.iter().any(|c| c.exists()) && !harness_script(root, &tok) {
                            if tok.contains("/target/")
                                || (is_reference_doc(md, root) && tok.starts_with("./"))
                            {
                                artifact_refs.push(snippet);
                            } else {
                                script_missing.push(snippet);
                            }
                        }
                        continue;
                    }
                    if let Some(rest) = tok.strip_prefix("~/") {
                        // home-relative harness shim — expand before probe
                        let home = std::env::var("HOME").unwrap_or_default();
                        if !home.is_empty() && Path::new(&home).join(rest).exists() {
                            push_uniq(&mut bin_seen, &tok);
                        } else {
                            bin_fail.push(snippet);
                        }
                        continue;
                    }
                    if SOURCED.contains(&tok.as_str()) {
                        push_uniq(&mut bin_seen, &tok);
                        continue;
                    }
                    if tok.starts_with("/tmp/") {
                        on_demand_refs.push(snippet);
                        continue;
                    }
                    if MAC_ONLY.contains(&tok.as_str()) {
                        mac_only_refs.push(snippet);
                        continue;
                    }
                    if OPTIONAL_TOOLCHAINS.contains(&tok.as_str()) {
                        optional_toolchain_refs.push(snippet);
                        continue;
                    }
                    if !has_bin(&tok, &mut bin_cache) {
                        if harness_script(root, &tok) {
                            push_uniq(&mut bin_seen, &tok);
                            continue;
                        }
                        bin_fail.push(snippet);
                        continue;
                    }
                    push_uniq(&mut bin_seen, &tok);
                    if INTERPRETERS.contains(&tok.as_str()) {
                        continue;
                    }
                    let sub = sub_cmd(&seg, &tok);
                    let key = match &sub {
                        Some(s) => format!("{tok} {s}"),
                        None => tok.clone(),
                    };
                    let flags = extract_seg_flags(&seg);
                    if flags.is_empty() {
                        continue;
                    }
                    add_flags(&mut flag_by_key, key, flags);
                }
            }
        }
    }

    // pass 2: inline `code` spans (history docs are skipped — quoting past
    // commands in prose is their job)
    for md in &mds {
        let rel_md = rel_of(md, root);
        if is_handoff_or_ignored(&rel_md) {
            continue;
        }
        let Ok(bytes) = fs::read(md) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for span in inline_spans(&text) {
            let mut line = span.trim().to_string();
            if !is_known(&line) {
                continue;
            }
            if line.contains('…') || line.contains("...") {
                line = truncate_ellipsis(&line).to_string();
            }
            for seg in inline_seg_split(&line) {
                let Some(tok) = head_tok(&seg) else {
                    continue;
                };
                if SOURCED.contains(&tok.as_str()) {
                    push_uniq(&mut bin_seen, &tok);
                    continue;
                }
                if OPTIONAL_TOOLCHAINS.contains(&tok.as_str()) {
                    optional_toolchain_refs.push(format!(
                        "{rel_md}: INLINE: {tok}  <<< {}",
                        truncate_chars(&line, 70)
                    ));
                    continue;
                }
                if !has_bin(&tok, &mut bin_cache) {
                    if harness_script(root, &tok) {
                        push_uniq(&mut bin_seen, &tok);
                        continue;
                    }
                    bin_fail.push(format!(
                        "{rel_md}: INLINE: {tok}  <<< {}",
                        truncate_chars(&line, 70)
                    ));
                    continue;
                }
                push_uniq(&mut bin_seen, &tok);
                if INTERPRETERS.contains(&tok.as_str()) || MAC_ONLY.contains(&tok.as_str()) {
                    continue;
                }
                let sub = sub_cmd(&seg, &tok);
                let key = match &sub {
                    Some(s) => format!("{tok} {s}"),
                    None => tok.clone(),
                };
                let flags = extract_seg_flags(&seg);
                if flags.is_empty() {
                    continue;
                }
                add_flags(&mut flag_by_key, key, flags);
            }
        }
    }

    let help_by_key = resolve_help_flags(&flag_by_key);
    for ((key, flags), help) in flag_by_key.iter().zip(help_by_key) {
        let Some(help) = help else {
            // never assert a flag against a probe that never ran
            unresolved_probes.push(key.clone());
            continue;
        };
        for f in flags {
            if f == "--help" {
                continue; // universal flag; git man pages don't list it
            }
            if FLAG_WAIVERS.contains(&format!("{key} {f}").as_str()) {
                continue;
            }
            if !help.contains(f) {
                flag_fail.push(format!("{key} {f}"));
            }
        }
    }

    let mut findings = Vec::new();
    for x in &syntax_fail {
        findings.push(format!("SYNTAX FAIL: {x}"));
    }
    for x in &bin_fail {
        findings.push(format!("BINARY NOT FOUND: {x}"));
    }
    for x in &script_missing {
        findings.push(format!("RELATIVE SCRIPT MISSING: {x}"));
    }
    for x in &flag_fail {
        findings.push(format!("FLAG NOT IN HELP: {x}"));
    }
    for x in &unresolved_probes {
        findings.push(format!(
            "HELP PROBE UNRESOLVED: {x} (retry; its flags were not verified)"
        ));
    }

    let mut info = Vec::new();
    for (label, arr) in [
        ("OPTIONAL TOOLCHAIN REFS", optional_toolchain_refs),
        ("BUILD/EXAMPLE ARTIFACT REFS", artifact_refs),
        ("MAC-ONLY REFS", mac_only_refs),
        ("ON-DEMAND /tmp REFS", on_demand_refs),
    ] {
        if !arr.is_empty() {
            info.push((label, arr));
        }
    }
    let mut binaries_ok = bin_seen;
    binaries_ok.sort();
    MdFamily {
        findings,
        md_scanned: mds.len(),
        binaries_ok,
        info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seg_split_operators_and_quotes() {
        assert_eq!(seg_split("a | b && c || d; e"), vec!["a ", " b ", " c ", " d", " e"]);
        assert_eq!(seg_split("git commit -m \"a | b\""), vec!["git commit -m \"a | b\""]);
        assert_eq!(seg_split("echo 'x;y'"), vec!["echo 'x;y'"]);
        assert_eq!(seg_split("a||b"), vec!["a", "b"]);
        assert_eq!(seg_split("plain"), vec!["plain"]);
    }

    #[test]
    fn inline_split_pipe_needs_spaces() {
        assert_eq!(inline_seg_split("git commit|push|branch"), vec!["git commit|push|branch"]);
        assert_eq!(inline_seg_split("git commit | push"), vec!["git commit ", " push"]);
        assert_eq!(inline_seg_split("a;b"), vec!["a", "b"]);
        assert_eq!(inline_seg_split("a && b"), vec!["a ", " b"]);
        assert_eq!(inline_seg_split("|a"), vec!["|a"]); // no whitespace before the pipe
    }

    #[test]
    fn assignments_stripped_with_quotes_and_subs() {
        assert_eq!(strip_assignments("FOO=1 cargo build").as_deref(), Some("cargo build"));
        assert_eq!(
            strip_assignments("RUSTFLAGS=\"-C target-cpu=native\" cargo b").as_deref(),
            Some("cargo b")
        );
        assert_eq!(
            strip_assignments("PGO_DIR=/tmp/pgo-$(date +%s) cargo").as_deref(),
            Some("cargo")
        );
        assert_eq!(strip_assignments("X='a b' cmd").as_deref(), Some("cmd"));
        assert_eq!(strip_assignments("no assign").as_deref(), Some("no assign"));
        assert_eq!(strip_assignments("$(unterminated cmd").as_deref(), Some("$(unterminated cmd")); // no VAR= prefix: untouched
        assert_eq!(strip_assignments("A=$(x"), None); // unterminated inside an assignment
    }

    #[test]
    fn head_tok_shapes() {
        assert_eq!(head_tok("$ rg --files").as_deref(), Some("rg"));
        assert_eq!(head_tok("# comment").as_deref(), Some("comment")); // `# ` is a prompt, not a comment
        assert_eq!(head_tok("## x"), None); // a real comment: no whitespace after #
        assert_eq!(head_tok("}"), None);
        assert_eq!(head_tok("{ echo hi"), None);
        assert_eq!(head_tok("(subshell)"), None);
        assert_eq!(head_tok("sudo git status").as_deref(), Some("git"));
        assert_eq!(head_tok("nohup curl -s").as_deref(), Some("curl"));
        assert_eq!(head_tok("git;").as_deref(), Some("git"));
        assert_eq!(head_tok("git commit"), Some("git".into()));
        assert_eq!(head_tok("echo hi"), None); // builtin
        assert_eq!(head_tok("foo=bar"), None); // bare assignment (no strip -> letters only)
        assert_eq!(head_tok("FOO=1 rg"), Some("rg".into()));
        assert_eq!(head_tok(""), None);
        assert_eq!(head_tok("git \"x\";").as_deref(), Some("git"));
    }

    #[test]
    fn sub_cmd_rules() {
        assert_eq!(sub_cmd("git reset --hard", "git").as_deref(), Some("reset"));
        assert_eq!(sub_cmd("git", "git"), None);
        assert_eq!(sub_cmd("git --hard", "git"), None);
        assert_eq!(sub_cmd("git Reset", "git"), None); // uppercase rejected
        assert_eq!(sub_cmd("git reset2", "git").as_deref(), Some("reset2"));
        assert_eq!(sub_cmd("sudo git status", "git"), None); // raw head differs
    }

    #[test]
    fn fenced_block_scan() {
        let t = "pre\n```bash\necho hi\n```\npost";
        assert_eq!(fenced_blocks(t), vec![("bash".to_string(), "echo hi\n".to_string())]);
        assert_eq!(fenced_blocks("```\nls\n```"), vec![("".to_string(), "ls\n".to_string())]);
        assert_eq!(fenced_blocks("```text\nhi\n```").len(), 1);
        assert_eq!(fenced_blocks("```bash x\necho\n```"), Vec::<(String, String)>::new());
        assert_eq!(fenced_blocks("```bash\necho"), Vec::<(String, String)>::new());
        // two blocks, non-overlapping
        let t2 = "```sh\na\n```\ntext\n```sh\nb\n```";
        assert_eq!(fenced_blocks(t2).len(), 2);
    }

    #[test]
    fn inline_span_scan() {
        assert_eq!(inline_spans("use `rg --files` here"), vec!["rg --files"]);
        assert_eq!(inline_spans("a `x` b `y`"), vec!["x", "y"]);
        assert_eq!(inline_spans("empty `` span"), Vec::<String>::new());
        assert_eq!(inline_spans("multi\n`line\nspan`"), Vec::<String>::new());
        assert_eq!(inline_spans("no backticks"), Vec::<String>::new());
    }

    #[test]
    fn known_head_tokens() {
        assert!(is_known("rg --files"));
        assert!(is_known("rg"));
        assert!(is_known("skillcheck.sh --all"));
        assert!(!is_known("rgfoo x"));
        assert!(!is_known("mycommand rg x"));
    }

    #[test]
    fn ellipsis_truncation() {
        assert_eq!(truncate_ellipsis("rg … --files"), "rg ");
        assert_eq!(truncate_ellipsis("npm run... x"), "npm run");
        assert_eq!(truncate_ellipsis("no ellipsis"), "no ellipsis");
    }

    #[test]
    fn comment_and_continuation() {
        assert_eq!(strip_comment("# full"), "");
        assert_eq!(strip_comment("echo a # b"), "echo a "); // the captured space stays; trimEnd happens later
        assert_eq!(strip_comment("a#b"), "a#b"); // # needs start or preceding whitespace
        let body = "cmd \\\n  arg # tail\n\nplain\n";
        assert_eq!(join_lines(body), vec!["cmd    arg", "plain"]);
        assert_eq!(join_lines("trailing \\"), vec!["trailing  "]); // slice(0,-1) keeps the space, + ' ' adds one
    }

    #[test]
    fn placeholders_quoted() {
        assert_eq!(quote_placeholders("cat <file>"), "cat \"<file>\"");
        assert_eq!(quote_placeholders("<1bad>"), "<1bad>");
        assert_eq!(quote_placeholders("a<b\nc>d"), "a<b\nc>d");
        assert_eq!(quote_placeholders("<skill-dir>/x"), "\"<skill-dir>\"/x");
    }

    #[test]
    fn overstrike_and_flag_extraction() {
        assert_eq!(strip_overstrike("g\x08git"), "git");
        assert_eq!(strip_overstrike("a\x08b\x08c"), "c");
        assert_eq!(strip_overstrike("\n\x08x"), "\n\x08x"); // `.` never matches \n, so the pair survives
        assert_eq!(extract_help_flags("--all -n x ---foo"), vec!["--all", "-n", "--foo"]);
        assert_eq!(extract_help_flags("[--] --x-ray"), vec!["--x-ray"]);
        assert_eq!(extract_seg_flags("--all -n x ---foo"), vec!["--all", "--foo"]);
        assert_eq!(extract_seg_flags("no flags"), Vec::<String>::new());
    }

    #[test]
    fn path_shapes() {
        assert!(is_script_path("./x"));
        assert!(is_script_path("../x"));
        assert!(is_script_path("scripts/x.mjs"));
        assert!(is_script_path("bin/docheck"));
        assert!(is_script_path("run.sh"));
        assert!(!is_script_path("script/x"));
        assert!(!is_script_path("git"));
        assert!(is_bare_assignment("foo=bar"));
        assert!(is_bare_assignment("a_b="));
        assert!(!is_bare_assignment("FOO=1 rg"));
        assert!(!is_bare_assignment("foo=bar baz"));
        assert!(is_handoff_or_ignored("HANDOFF-x.md"));
        assert!(!is_handoff_or_ignored("HANDOFF-x/y.md"));
        assert!(is_handoff_or_ignored("handoff/a.md"));
        assert!(is_handoff_or_ignored("audit-reports/b.md"));
        assert!(!is_handoff_or_ignored("docs/handoff.md"));
    }

    #[test]
    fn truncation_and_prompt() {
        assert_eq!(truncate_chars("abcdef", 3), "abc");
        assert_eq!(truncate_chars("ab", 10), "ab");
        assert_eq!(strip_prompt("$ rg x"), "rg x");
        assert_eq!(strip_prompt("# cmd"), "cmd");
        assert_eq!(strip_prompt("> git"), "git");
        assert_eq!(strip_prompt("$x"), "$x"); // needs whitespace after
        assert_eq!(first_word("a b"), "a");
    }
}
