//! Argument parsing — `pibash [--command <C>] [--cwd <DIR>] [--timeout <SEC>]`.
//! `--serve` selects the NDJSON daemon. Unknown flags exit 2 with usage.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub enum Mode {
    OneShot(Request),
    Serve,
    Version,
    Help,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub command: String,
    pub cwd: PathBuf,
    pub timeout_seconds: Option<f64>,
    /// Explicit child environment. None inherits the daemon's own environment;
    /// the daemon client sends the full map so PI_* injection and the managed
    /// PATH match the built-in's getShellEnv() + resolveSpawnContext().
    pub env: Option<std::collections::HashMap<String, String>>,
}

pub const USAGE: &str = "usage: pibash --command <C> [--cwd <DIR>] [--timeout <SEC>]\n       pibash --serve\n       pibash --version | --help";

pub fn parse(args: &[String]) -> Result<Mode, String> {
    let mut command: Option<String> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut timeout: Option<f64> = None;
    let mut serve = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--version" => return Ok(Mode::Version),
            "--help" => return Ok(Mode::Help),
            "--serve" => {
                serve = true;
                index += 1;
            }
            "--command" | "--cwd" | "--timeout" => {
                let Some(value) = args.get(index + 1) else {
                    return Err(format!("missing value for {arg}"));
                };
                match arg {
                    "--command" => command = Some(value.clone()),
                    "--cwd" => cwd = Some(PathBuf::from(value)),
                    _ => match value.parse::<f64>() {
                        Ok(secs) if secs.is_finite() && secs > 0.0 => timeout = Some(secs),
                        _ => {
                            return Err(
                                "invalid timeout: must be a finite positive number of seconds"
                                    .to_string(),
                            );
                        }
                    },
                }
                index += 2;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if serve {
        return Ok(Mode::Serve);
    }
    let Some(command) = command else {
        return Err("missing required --command".to_string());
    };
    Ok(Mode::OneShot(Request {
        command,
        cwd: cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
        timeout_seconds: timeout,
        env: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parses_a_command_with_cwd_and_timeout() {
        let mode = parse(&args(&["--command", "echo hi", "--cwd", "/tmp", "--timeout", "2.5"]))
            .expect("parses");
        let Mode::OneShot(req) = mode else {
            panic!("expected one-shot mode");
        };
        assert_eq!(req.command, "echo hi");
        assert_eq!(req.cwd, PathBuf::from("/tmp"));
        assert_eq!(req.timeout_seconds, Some(2.5));
    }

    #[test]
    fn serve_wins_even_without_a_command() {
        assert!(matches!(parse(&args(&["--serve"])).unwrap(), Mode::Serve));
    }

    #[test]
    fn missing_command_is_a_usage_error() {
        assert!(parse(&args(&["--cwd", "/tmp"])).is_err());
    }

    #[test]
    fn unknown_flag_is_a_usage_error() {
        assert!(parse(&args(&["--nope"])).is_err());
    }

    #[test]
    fn default_cwd_is_the_process_cwd_when_omitted() {
        let mode = parse(&args(&["--command", "ls"])).unwrap();
        let Mode::OneShot(req) = mode else { panic!("one-shot") };
        assert_eq!(req.cwd, std::env::current_dir().unwrap());
    }

    #[test]
    fn missing_flag_value_is_a_usage_error() {
        assert!(parse(&args(&["--command"])).is_err());
        assert!(parse(&args(&["--cwd"])).is_err());
        assert!(parse(&args(&["--timeout"])).is_err());
    }

    #[test]
    fn non_numeric_timeout_is_rejected() {
        assert!(parse(&args(&["--command", "ls", "--timeout", "soon"])).is_err());
    }

    #[test]
    fn command_may_contain_flag_like_text_after_the_value() {
        // The value is taken positionally, so a `--`-looking command is fine.
        let mode = parse(&args(&["--command", "echo --help"])).unwrap();
        let Mode::OneShot(req) = mode else { panic!("one-shot") };
        assert_eq!(req.command, "echo --help");
    }

    #[test]
    fn version_and_help_are_recognized() {
        assert!(matches!(parse(&args(&["--version"])).unwrap(), Mode::Version));
        assert!(matches!(parse(&args(&["--help"])).unwrap(), Mode::Help));
    }

    #[test]
    fn non_positive_timeout_is_rejected() {
        assert!(parse(&args(&["--command", "ls", "--timeout", "0"])).is_err());
    }

    #[test]
    fn infinite_and_nan_timeouts_are_rejected() {
        assert!(parse(&args(&["--command", "ls", "--timeout", "inf"])).is_err());
        assert!(parse(&args(&["--command", "ls", "--timeout", "NaN"])).is_err());
        assert!(parse(&args(&["--command", "ls", "--timeout", "-1"])).is_err());
    }

    #[test]
    fn repeated_flags_use_the_last_value() {
        let mode = parse(&args(&["--command", "a", "--command", "b"])).unwrap();
        let Mode::OneShot(req) = mode else { panic!("one-shot") };
        assert_eq!(req.command, "b");
    }

    #[test]
    fn relative_cwd_is_preserved_verbatim() {
        let mode = parse(&args(&["--command", "ls", "--cwd", "sub/dir"])).unwrap();
        let Mode::OneShot(req) = mode else { panic!("one-shot") };
        assert_eq!(req.cwd, PathBuf::from("sub/dir"));
    }
}
