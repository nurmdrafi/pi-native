//! piread — native read pipeline for the pi agent harness (S6).
//!
//! One invocation runs the whole text-read pipeline the built-in `read` tool
//! performs in TypeScript (open → slice → render → truncate) and prints a
//! single JSON envelope on stdout. Byte-for-byte parity with the built-in is
//! enforced by the oracle suite `tests/piread-parity.test.mjs` in the harness
//! repo; this crate owns the mechanics.
//!
//! Exit codes: 0 ok · 2 usage (stderr message, no JSON) · 3 I/O error (JSON).

use std::fmt;
use std::process::ExitCode;

#[path = "bounds.gen.rs"]
mod bounds;
mod cli;
mod compress;
mod envelope;
mod locate;
mod pipeline;
mod procgroup;
mod serve;

use cli::{parse_args, Parsed};
use envelope::{fail_envelope, success_envelope};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&argv) {
        Err(msg) => {
            eprintln!("piread: {msg}");
            eprintln!("usage: piread --path <P> [--offset <N>] [--limit <N>] [--hits <S>]  (try --help)");
            ExitCode::from(2)
        }
        Ok(Parsed::Help) => {
            print!("{}", cli::HELP);
            ExitCode::SUCCESS
        }
        Ok(Parsed::Version) => {
            println!("piread {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Parsed::Serve) => serve::serve(),
        Ok(Parsed::Run(run)) => {
            let resolved = pipeline::resolve_path(&run.path);
            let read = match &run.hits {
                Some(needle) => locate::read_hits(&resolved, &run.path, needle, run.line_cap),
                None => pipeline::read_text_compacted(
                    &resolved,
                    &run.path,
                    run.offset,
                    run.limit,
                    run.line_cap,
                ),
            };
            match read {
                Ok(out) => {
                    let json = success_envelope(
                        &out.content,
                        out.truncation.as_ref(),
                        out.binary,
                        out.total_bytes,
                        out.compaction.as_ref(),
                        out.locate.as_ref(),
                    );
                    println!("{json}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    let json = fail_envelope(&err);
                    println!("{json}");
                    ExitCode::from(3)
                }
            }
        }
    }
}

/// Tool-level failure mapped to the JSON envelope.
#[derive(Debug)]
pub struct ToolError {
    pub kind: envelope::ErrorKind,
    pub message: String,
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

#[cfg(test)]
mod tests {
    use crate::cli::{self, parse_args, Parsed};

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn ok(v: &[&str]) -> cli::Run {
        match parse_args(&args(v)).expect("should parse") {
            Parsed::Run(r) => r,
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn parses_minimal_invocation() {
        let r = ok(&["--path", "/tmp/x"]);
        assert_eq!(r.path, "/tmp/x");
        assert_eq!(r.offset, None);
        assert_eq!(r.limit, None);
    }

    #[test]
    fn parses_full_invocation_and_equals_form() {
        let r = ok(&["--path", "/tmp/x", "--offset", "5", "--limit", "10"]);
        assert_eq!(r.offset, Some(5));
        assert_eq!(r.limit, Some(10));
        assert_eq!(r.line_cap, None);
        let r = ok(&["--path=/tmp/x", "--offset=7"]);
        assert_eq!(r.path, "/tmp/x");
        assert_eq!(r.offset, Some(7));
    }

    #[test]
    fn parses_line_cap_and_defaults_off() {
        assert_eq!(ok(&["--path", "/x"]).line_cap, None);
        assert_eq!(ok(&["--path", "/x", "--line-cap", "1000"]).line_cap, Some(1000));
        assert_eq!(ok(&["--path", "/x", "--line-cap=50"]).line_cap, Some(50));
        assert!(parse_args(&args(&["--path", "/x", "--line-cap", "0"])).is_err());
    }

    #[test]
    fn duplicate_flag_last_wins() {
        let r = ok(&["--path", "/a", "--path", "/b"]);
        assert_eq!(r.path, "/b");
    }

    #[test]
    fn rejects_offset_below_one() {
        assert!(parse_args(&args(&["--path", "/x", "--offset", "0"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "--offset", "-3"])).is_err());
    }

    #[test]
    fn rejects_limit_below_one() {
        assert!(parse_args(&args(&["--path", "/x", "--limit", "0"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "--limit", "-1"])).is_err());
    }

    #[test]
    fn rejects_non_numeric_and_garbled_values() {
        assert!(parse_args(&args(&["--path", "/x", "--offset", "abc"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "--offset", "1.5"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "--offset"])).is_err());
    }

    #[test]
    fn rejects_unknown_flag_positional_and_missing_path() {
        assert!(parse_args(&args(&["--paths", "/x"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "extra"])).is_err());
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["--offset", "2"])).is_err());
    }

    #[test]
    fn recognizes_version_help_and_serve() {
        assert!(matches!(parse_args(&args(&["--version"])).unwrap(), Parsed::Version));
        assert!(matches!(parse_args(&args(&["--help"])).unwrap(), Parsed::Help));
        assert!(matches!(parse_args(&args(&["--serve"])).unwrap(), Parsed::Serve));
        // even alongside other flags (informational flags win)
        assert!(matches!(parse_args(&args(&["--path", "/x", "--version"])).unwrap(), Parsed::Version));
    }

    // ---- --hits: fused locate+read selector ----

    #[test]
    fn parses_hits_selector() {
        let r = ok(&["--path", "/x", "--hits", "read_text"]);
        assert_eq!(r.hits.as_deref(), Some("read_text"));
        assert_eq!(r.offset, None);
        assert_eq!(r.limit, None);
    }

    #[test]
    fn hits_inline_form_and_line_cap_compose() {
        let r = ok(&["--path", "/x", "--hits=sym", "--line-cap", "80"]);
        assert_eq!(r.hits.as_deref(), Some("sym"));
        assert_eq!(r.line_cap, Some(80));
    }

    #[test]
    fn hits_rejects_offset_and_limit() {
        assert!(parse_args(&args(&["--path", "/x", "--hits", "s", "--offset", "5"])).is_err());
        assert!(parse_args(&args(&["--path", "/x", "--hits", "s", "--limit", "5"])).is_err());
    }

    #[test]
    fn hits_rejects_empty_needle() {
        assert!(parse_args(&args(&["--path", "/x", "--hits", ""])).is_err());
    }

    #[test]
    fn hits_requires_a_value() {
        assert!(parse_args(&args(&["--path", "/x", "--hits"])).is_err());
    }
}
