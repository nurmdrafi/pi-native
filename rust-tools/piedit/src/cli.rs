//! CLI parsing: `piedit --path <P>` (edits arrive on stdin as JSON).

/// A fully validated invocation.
pub struct Run {
    /// Path exactly as the caller supplied it (the extension resolves it
    /// against the tool cwd before invoking; the crate uses it verbatim).
    pub path: String,
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
piedit — native edit pipeline for the pi agent harness

usage: piedit --path <P>
       piedit --serve

  --path <P>    file to edit; the request object is read from stdin:
                { \"edits\": [ { \"oldText\": \"…\", \"newText\": \"…\" } ],
                  \"renderDiff\"?: boolean }
  --serve       daemon mode: newline-delimited JSON requests on stdin, one
                response line per request (same envelope plus an echoed
                `id`); exits on stdin EOF

Prints one JSON object on stdout:
  success: {ok, baseContent, newContent}              (renderDiff absent)
  success: {ok, diff, patch, firstChangedLine}        (renderDiff true)
  failure: {ok, error: {kind, message}}

Exit codes: 0 ok · 2 usage (stderr) · 3 I/O or validation error (JSON on stdout)
";

/// Parse `--flag value` and `--flag=value` forms. Unknown flags, positional
/// arguments, and missing values are usage errors (exit 2).
pub fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut path: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let (flag, inline): (&str, Option<&str>) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (arg, None),
        };
        let takes_value = flag == "--path";
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
            "--serve" | "--version" | "--help" | "-h" => return Err(format!("{flag} takes no value")),
            other => return Err(format!("unknown flag '{other}'")),
        }
        i += 1;
    }
    let path = path.ok_or_else(|| "missing required flag --path".to_string())?;
    Ok(Parsed::Run(Run { path }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn ok(v: &[&str]) -> Run {
        match parse_args(&args(v)).expect("should parse") {
            Parsed::Run(r) => r,
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn parses_minimal_invocation() {
        assert_eq!(ok(&["--path", "/tmp/x"]).path, "/tmp/x");
    }

    #[test]
    fn parses_equals_form_and_last_wins() {
        assert_eq!(ok(&["--path=/tmp/x"]).path, "/tmp/x");
        assert_eq!(ok(&["--path", "/a", "--path", "/b"]).path, "/b");
    }

    #[test]
    fn rejects_unknown_flag_positional_and_missing_path() {
        assert!(parse_args(&args(&["--paths", "/x"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "extra"])).is_err());
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["--path"])).is_err());
    }

    #[test]
    fn recognizes_version_help_and_serve() {
        assert!(matches!(parse_args(&args(&["--version"])).unwrap(), Parsed::Version));
        assert!(matches!(parse_args(&args(&["--help"])).unwrap(), Parsed::Help));
        assert!(matches!(parse_args(&args(&["--serve"])).unwrap(), Parsed::Serve));
        assert!(matches!(parse_args(&args(&["--path", "/x", "--version"])).unwrap(), Parsed::Version));
    }
}
