//! CLI parsing: `piread --path <P> [--offset <N>] [--limit <N>]`.

/// A fully validated invocation.
pub struct Run {
    /// Path exactly as the caller supplied it (the built-in renders notes with
    /// the raw path; resolution happens at I/O time).
    pub path: String,
    /// 1-based first line (CLI contract: ≥ 1; the extension maps the tool's
    /// `offset < 1` / unset semantics before invoking).
    pub offset: Option<u64>,
    /// Maximum number of lines (≥ 1).
    pub limit: Option<u64>,
    /// Optional per-line character cap. When `Some(n)`, any selected line
    /// longer than `n` chars is truncated to `n` chars plus a
    /// `...[+M chars]` marker; `None` (default) leaves every line untouched,
    /// preserving byte parity with the built-in read.
    pub line_cap: Option<u64>,
}

/// Non-`Run` outcomes that still exit 0.
pub enum Parsed {
    Run(Run),
    /// Long-lived NDJSON request/response loop over stdio (daemon mode).
    Serve,
    Version,
    Help,
}

pub const HELP: &str = "\
piread — native read pipeline for the pi agent harness

usage: piread --path <P> [--offset <N>] [--limit <N>] [--line-cap <N>]
       piread --serve

  --path <P>    file to read; ~ and relative paths resolve against the
                process working directory, mirroring the built-in read tool
  --offset <N>  1-based first line to read (default: 1)
  --limit <N>   maximum number of lines to read
  --line-cap <N>
                cap each line at <N> characters, appending a
                ...[+M chars] marker; omitted = no cap (byte parity)
  --serve       daemon mode: newline-delimited JSON requests on stdin, one
                response line per request (same envelope plus an echoed
                `id`); exits on stdin EOF

Prints one JSON object on stdout:
  success: {ok, content, truncation, binary, totalBytes}
  failure: {ok, error: {kind, message}}

Exit codes: 0 ok · 2 usage (stderr) · 3 I/O error (JSON on stdout)
";

/// Parse `--flag value` and `--flag=value` forms. Unknown flags, positional
/// arguments, missing values, and offset/limit < 1 are usage errors (exit 2).
pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut path: Option<String> = None;
    let mut offset: Option<u64> = None;
    let mut limit: Option<u64> = None;
    let mut line_cap: Option<u64> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let (flag, inline): (&str, Option<&str>) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (arg, None),
        };
        // Known flags decide their value handling; anything else errors
        // immediately without consuming the next argument.
        let takes_value = matches!(flag, "--path" | "--offset" | "--limit" | "--line-cap");
        if !takes_value && inline.is_none() {
            return match flag {
                "--serve" => Ok(Parsed::Serve),
                "--version" => Ok(Parsed::Version),
                "--help" | "-h" => Ok(Parsed::Help),
                other => Err(format!("unknown flag '{other}'")),
            };
        }
        let value: String = match inline {
            Some(v) => v.to_string(),
            None => {
                i += 1;
                let v = args.get(i).ok_or_else(|| format!("{arg} requires a value"))?;
                v.clone()
            }
        };
        match flag {
            "--path" => path = Some(value),
            "--offset" => offset = Some(parse_count(flag, &value)?),
            "--limit" => limit = Some(parse_count(flag, &value)?),
            "--line-cap" => line_cap = Some(parse_count(flag, &value)?),
            "--serve" | "--version" | "--help" | "-h" => return Err(format!("{flag} takes no value")),
            other => return Err(format!("unknown flag '{other}'")),
        }
        i += 1;
    }
    let path = path.ok_or_else(|| "missing required flag --path".to_string())?;
    Ok(Parsed::Run(Run { path, offset, limit, line_cap }))
}

/// Flag values must be integers ≥ 1 (the tool-level 0/negative semantics are
/// handled by the extension; the CLI contract is strict).
fn parse_count(flag: &str, value: &str) -> Result<u64, String> {
    let n: u64 = value
        .parse()
        .map_err(|_| format!("{flag} must be an integer ≥ 1, got '{value}'"))?;
    if n < 1 {
        return Err(format!("{flag} must be an integer ≥ 1, got '{value}'"));
    }
    Ok(n)
}
