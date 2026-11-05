//! CLI parsing: `piwrite --path <P>` (raw bytes on stdin) or `piwrite --serve`.

/// Non-`Run` outcomes that still exit 0.
#[derive(Debug)]
pub enum Parsed {
    /// One-shot write of raw stdin bytes to `Run.0`.
    Run(String),
    /// Long-lived raw-framing request/response loop over stdio (daemon mode).
    Serve,
    Version,
    Help,
}

pub const HELP: &str = "\
piwrite — native file-write tool for the pi agent harness

usage: piwrite --path <P>
       piwrite --serve

  --path <P>    file to write; stdin is read to EOF as raw bytes and written
                verbatim (binary-safe, no newline translation); missing parent
                directories are created recursively
  --serve       daemon mode: raw framing on stdio — each request is one
                header line {\"path\":<string>,\"bytes\":<N>} followed
                immediately by exactly N raw body bytes (binary-safe, no
                trailing newline; the next header follows the body);
                missing parent directories are created; one response line
                per request in request order (same envelope); exits 0 on
                stdin EOF at a header boundary or after a truncated-body
                error, 1 on malformed framing

Prints one JSON object on stdout:
  success: {ok, path, bytes}
  failure: {ok, error}

Exit codes: 0 ok · 2 usage (JSON) · 3 I/O error (JSON)
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
        // `--path` decides its own value handling; everything else must be a
        // known no-value flag and errors (or serves) without consuming the
        // next argument.
        if flag != "--path" {
            return match (flag, inline) {
                ("--serve", None) => Ok(Parsed::Serve),
                ("--version", None) => Ok(Parsed::Version),
                ("--help", None) | ("-h", None) => Ok(Parsed::Help),
                ("--serve" | "--version" | "--help" | "-h", Some(_)) => {
                    Err(format!("{flag} takes no value"))
                }
                (other, _) => Err(format!("unknown flag '{other}'")),
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
        path = Some(value);
        i += 1;
    }
    let path = path.ok_or_else(|| "missing required flag --path".to_string())?;
    Ok(Parsed::Run(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn run_path(a: &[&str]) -> String {
        match parse_args(&args(a)).expect("parses") {
            Parsed::Run(p) => p,
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parses_path_with_value() {
        assert_eq!(run_path(&["--path", "/x"]), "/x");
    }

    #[test]
    fn parses_inline_value_form() {
        assert_eq!(run_path(&["--path=/y"]), "/y");
    }

    #[test]
    fn last_path_wins() {
        assert_eq!(run_path(&["--path", "/a", "--path", "/b"]), "/b");
    }

    #[test]
    fn serve_wins_when_present() {
        assert!(matches!(
            parse_args(&args(&["--path", "/x", "--serve"])),
            Ok(Parsed::Serve)
        ));
    }

    #[test]
    fn serve_help_version_take_no_value() {
        assert!(matches!(parse_args(&args(&["--serve"])), Ok(Parsed::Serve)));
        assert!(matches!(parse_args(&args(&["--help"])), Ok(Parsed::Help)));
        assert!(matches!(parse_args(&args(&["-h"])), Ok(Parsed::Help)));
        assert!(matches!(parse_args(&args(&["--version"])), Ok(Parsed::Version)));
        for flag in ["--serve=x", "--help=x", "--version=x"] {
            assert!(parse_args(&args(&[flag])).is_err(), "{flag}");
        }
    }

    #[test]
    fn missing_path_flag_is_a_usage_error() {
        let err = parse_args(&args(&[])).expect_err("must fail");
        assert!(err.contains("--path"), "{err}");
    }

    #[test]
    fn path_requires_a_value() {
        let err = parse_args(&args(&["--path"])).expect_err("must fail");
        assert!(err.contains("requires a value"), "{err}");
    }

    #[test]
    fn unknown_flag_is_a_usage_error() {
        let err = parse_args(&args(&["--path", "/x", "--wat"])).expect_err("must fail");
        assert!(err.contains("unknown flag"), "{err}");
    }

    #[test]
    fn positional_argument_is_a_usage_error() {
        assert!(parse_args(&args(&["stray"])).is_err());
    }
}
