//! `outline` prints a file's definition index: one `start end kind name` row
//! per definition (tab-separated, 1-based inclusive spans), so later lookups
//! aim one bounded read window by line number instead of re-walking the file.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

#[path = "bounds.gen.rs"]
mod bounds;

const USAGE: &str = "usage: outline <file>\n       outline --show <file> <symbol>\nindex mode: one row per definition, start<TAB>end<TAB>kind<TAB>name\nshow mode: the symbol's span header, then its body (head+marker+tail over 200 lines)";

struct Lang {
    keywords: &'static [&'static str],
    /// Word-boundary prefixes stripped before keyword matching (`export`,
    /// `async`, ...) — modifiers that sit in front of a definition keyword.
    modifiers: &'static [&'static str],
    brace_matched: bool,
}

fn lang_for(ext: &str) -> Option<Lang> {
    let lang = match ext {
        "rs" => Lang {
            keywords: &["fn", "struct", "enum", "trait", "impl", "mod", "type", "const", "static"],
            modifiers: &[],
            brace_matched: true,
        },
        "py" => Lang { keywords: &["def", "class"], modifiers: &[], brace_matched: false },
        "go" => Lang { keywords: &["func", "type"], modifiers: &[], brace_matched: true },
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" => Lang {
            keywords: &["function", "class", "interface", "enum", "type", "const", "let"],
            modifiers: &["export", "default", "declare", "abstract", "async"],
            brace_matched: true,
        },
        _ => return None,
    };
    Some(lang)
}

struct Def {
    start: usize,
    indent: usize,
    kind: &'static str,
    name: String,
}

/// Strips `m` when it opens `s` as a whole word followed by whitespace —
/// `default:` labels and identifiers like `exporter` stay untouched.
fn strip_modifier<'a>(s: &'a str, m: &str) -> Option<&'a str> {
    let after = s.strip_prefix(m)?;
    after.chars().next()?.is_whitespace().then(|| after.trim_start())
}

/// Returns (indent, keyword, name) when `line` opens a definition.
/// Naive by design: no string/comment awareness in this first cut.
/// Leading modifier words (`export default` etc.) are stripped first —
/// without this, exported definitions (most of a JS/TS codebase) never index.
fn line_def(
    line: &str,
    keywords: &[&'static str],
    modifiers: &[&str],
) -> Option<(usize, &'static str, String)> {
    let mut trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    while let Some(rest) = modifiers.iter().find_map(|m| strip_modifier(trimmed, m)) {
        trimmed = rest;
    }
    for &kw in keywords {
        let Some(after) = trimmed.strip_prefix(kw) else { continue };
        if !after.starts_with(|c: char| c.is_whitespace() || c == '<') {
            continue;
        }
        let mut rest = after.trim_start();
        if rest.starts_with('<') {
            let Some(close) = rest.find('>') else { continue };
            rest = rest[close + 1..].trim_start();
        }
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }
        return Some((indent, kw, name));
    }
    None
}

/// Span end for each def: brace languages close at the matched `}`; indent
/// languages end before the next def at the same or lower indent, trailing
/// blank lines trimmed.
fn spans(defs: &[Def], lines: &[&str], brace_matched: bool) -> Vec<usize> {
    let last = lines.len();
    defs.iter()
        .enumerate()
        .map(|(i, d)| {
            let limit = defs[i + 1..]
                .iter()
                .find(|n| n.indent <= d.indent)
                .map_or(last, |n| n.start - 1);
            let mut end = limit;
            if brace_matched {
                let mut depth: i64 = 0;
                let mut opened = false;
                for (idx, &line) in lines[d.start - 1..limit].iter().enumerate() {
                    let opens = line.matches('{').count() as i64;
                    depth += opens;
                    depth -= line.matches('}').count() as i64;
                    if opens > 0 {
                        opened = true;
                    }
                    if opened && depth <= 0 {
                        end = d.start + idx;
                        break;
                    }
                }
            } else {
                while end > d.start && lines[end - 1].trim().is_empty() {
                    end -= 1;
                }
            }
            end
        })
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let (path_arg, show_name) = match args.len() {
        2 => (args[1].as_str(), None),
        4 if args[1] == "--show" => (args[2].as_str(), Some(args[3].as_str())),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let path = Path::new(path_arg);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let Some(lang) = lang_for(ext) else {
        eprintln!("outline: unsupported extension '.{ext}' (supported: rs, py, go, js/ts family)");
        return ExitCode::FAILURE;
    };
    let src = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("outline: cannot read {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
    };
    let lines: Vec<&str> = src.lines().collect();
    let defs: Vec<Def> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| {
            line_def(line, lang.keywords, lang.modifiers).map(|(indent, kind, name)| Def {
                start: i + 1,
                indent,
                kind,
                name,
            })
        })
        .collect();
    let ends = spans(&defs, &lines, lang.brace_matched);
    let mut rows = String::new();
    if let Some(name) = show_name {
        const SHOW_MAX_SPAN: usize = bounds::OUTLINE_SHOW_MAXSPAN as usize;
        const SHOW_HEAD: usize = bounds::OUTLINE_SHOW_HEAD as usize;
        const SHOW_TAIL: usize = bounds::OUTLINE_SHOW_TAIL as usize;
        let hits: Vec<(&Def, &usize)> = defs
            .iter()
            .zip(&ends)
            .filter(|(d, _)| d.name == name)
            .collect();
        if hits.is_empty() {
            let mut known: Vec<&str> = Vec::new();
            for d in &defs {
                if !known.contains(&d.name.as_str()) {
                    known.push(&d.name);
                }
            }
            let listed = if known.len() > 40 {
                format!("{} ...", known[..40].join(", "))
            } else {
                known.join(", ")
            };
            eprintln!(
                "outline: no definition named '{name}' in {}; known: {listed}",
                path.display()
            );
            return ExitCode::FAILURE;
        }
        for (d, &end) in hits {
            let _ = writeln!(rows, "{}-{} {} {}", d.start, end, d.kind, d.name);
            let body = &lines[d.start - 1..end];
            if body.len() <= SHOW_MAX_SPAN {
                for line in body {
                    let _ = writeln!(rows, "{line}");
                }
            } else {
                for line in &body[..SHOW_HEAD] {
                    let _ = writeln!(rows, "{line}");
                }
                let om_start = d.start + SHOW_HEAD;
                let om_end = end - SHOW_TAIL;
                let _ = writeln!(
                    rows,
                    "... omitted {} lines (lines {}-{}) ...",
                    om_end - om_start + 1,
                    om_start,
                    om_end
                );
                for line in &body[body.len() - SHOW_TAIL..] {
                    let _ = writeln!(rows, "{line}");
                }
            }
        }
    } else {
        for (d, &end) in defs.iter().zip(&ends) {
            let _ = writeln!(rows, "{}\t{}\t{}\t{}", d.start, end, d.kind, d.name);
        }
    }
    // A closed consumer (`| head`) is a normal exit, not an error.
    if let Err(e) = io::stdout().write_all(rows.as_bytes()) {
        if e.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("outline: write failed: {e}");
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        }
    } else {
        ExitCode::SUCCESS
    }
}
