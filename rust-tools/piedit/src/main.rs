//! piedit — native edit pipeline for the pi agent harness (S8).
//!
//! One invocation reads a JSON request (`{edits:[{oldText,newText}],
//! renderDiff?}`) from stdin, applies the edits to `--path` with the
//! built-in `edit` tool's exact matching semantics, writes the file, and
//! prints one JSON envelope:
//!
//!   success: {ok, baseContent, newContent}           (renderDiff absent)
//!   success: {ok, diff, patch, firstChangedLine}     (renderDiff true —
//!             natively rendered, byte-identical to the TS helpers; the
//!             content pair never crosses the boundary)
//!   failure: {ok, error: {kind, message}}
//!
//! Parity is enforced by `tests/piedit-parity.test.mjs` (deterministic
//! corpus + seeded differential fuzz against the exported TS helpers).
//!
//! Exit codes: 0 ok · 2 usage (stderr message, no JSON) · 3 I/O or validation
//! error (JSON on stdout).

use std::fmt;
use std::io::Read;
use std::process::ExitCode;

mod cli;
mod diff;
mod envelope;
mod pipeline;
mod procgroup;
mod serve;

use cli::{parse_args, Parsed};
use envelope::{ErrorKind, Request, fail_envelope, success_envelope, success_rendered_envelope};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&argv) {
        Err(msg) => {
            eprintln!("piedit: {msg}");
            eprintln!("usage: piedit --path <P>  (edits on stdin; try --help)");
            ExitCode::from(2)
        }
        Ok(Parsed::Help) => {
            print!("{}", cli::HELP);
            ExitCode::SUCCESS
        }
        Ok(Parsed::Version) => {
            println!("piedit {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Parsed::Serve) => serve::serve(),
        Ok(Parsed::Run(run)) => {
            let request = match read_request() {
                Ok(req) => req,
                Err(err) => {
                    println!("{}", fail_envelope(&err));
                    return ExitCode::from(3);
                }
            };
            let display = request.path.as_deref().unwrap_or(&run.path);
            if request.render_diff == Some(true) {
                match pipeline::edit_file_rendered(display, &run.path, &request.edits) {
                    Ok(rendered) => {
                        println!("{}", success_rendered_envelope(&rendered));
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        println!("{}", fail_envelope(&err));
                        ExitCode::from(3)
                    }
                }
            } else {
                match pipeline::edit_file(display, &run.path, &request.edits) {
                    Ok(applied) => {
                        println!("{}", success_envelope(&applied.base_content, &applied.new_content));
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        println!("{}", fail_envelope(&err));
                        ExitCode::from(3)
                    }
                }
            }
        }
    }
}

/// Read and parse the stdin request. Malformed JSON or a missing/invalid
/// `edits` array is a tool-level failure (exit 3), not a usage error — the
/// extension reports it exactly as the built-in would.
fn read_request() -> Result<Request, ToolError> {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|err| ToolError {
            kind: ErrorKind::Io,
            message: format!("could not read stdin request: {err}"),
        })?;
    let request: Request = serde_json::from_str(&raw).map_err(|err| ToolError {
        kind: ErrorKind::Io,
        message: format!("Edit tool input is invalid. {err}"),
    })?;
    if request.edits.is_empty() {
        return Err(ToolError {
            kind: ErrorKind::Io,
            message: "Edit tool input is invalid. edits must contain at least one replacement."
                .into(),
        });
    }
    Ok(request)
}

/// Tool-level failure mapped to the JSON envelope.
#[derive(Debug)]
pub struct ToolError {
    pub kind: ErrorKind,
    pub message: String,
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_error_display() {
        let e = ToolError { kind: ErrorKind::NotFound, message: "nope".into() };
        assert_eq!(e.to_string(), "NOT_FOUND: nope");
    }

    #[test]
    fn error_kind_strings() {
        assert_eq!(ErrorKind::Enoent.as_str(), "ENOENT");
        assert_eq!(ErrorKind::Eacces.as_str(), "EACCES");
        assert_eq!(ErrorKind::Enotdir.as_str(), "ENOTDIR");
        assert_eq!(ErrorKind::EmptyOldText.as_str(), "EMPTY_OLDTEXT");
        assert_eq!(ErrorKind::NotFound.as_str(), "NOT_FOUND");
        assert_eq!(ErrorKind::Duplicate.as_str(), "DUPLICATE");
        assert_eq!(ErrorKind::Overlap.as_str(), "OVERLAP");
        assert_eq!(ErrorKind::NoChange.as_str(), "NO_CHANGE");
        assert_eq!(ErrorKind::Io.as_str(), "io");
    }
}
