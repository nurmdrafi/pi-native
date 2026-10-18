//! pibash — native shell-output pipeline for the pi agent.
//!
//! The built-in bash tool (TypeScript, `dist/core/tools/bash.js`) is the
//! oracle: this crate owns spawn + streaming + capping + truncation + spill +
//! envelope. The extension layer owns the session-sensitive parts (env and
//! PI_* injection, cancellation, TUI renderers).

mod accumulator;
mod cli;
mod compress;
mod envelope;
mod procgroup;
mod render;
mod runner;
mod serve;
mod truncate;

use std::io::Write;
use std::process::ExitCode;

use accumulator::{cap_full_output, OutputAccumulator};
use cli::{Mode, Request};
use envelope::Success;
use render::{format_output, structured_limit};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(Mode::Version) => {
            println!("pibash {VERSION}");
            ExitCode::SUCCESS
        }
        Ok(Mode::Help) => {
            println!("{}", cli::USAGE);
            ExitCode::SUCCESS
        }
        Ok(Mode::Serve) => match serve::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("pibash --serve: {message}");
                ExitCode::from(3)
            }
        },
        Ok(Mode::OneShot(request)) => one_shot(&request),
        Err(message) => {
            eprintln!("{message}\n{}", cli::USAGE);
            ExitCode::from(2)
        }
    }
}

/// Execute one request and print the envelope. Exit 0 on a completed run
/// (even a non-zero shell exit — the caller reads `exit_code`), 3 on a
/// spawn/IO failure.
fn one_shot(request: &Request) -> ExitCode {
    let response = execute(request);
    let (json, ok) = match &response {
        Ok(success) => (serde_json::to_string(success).unwrap_or_default(), true),
        Err(failure) => (serde_json::to_string(failure).unwrap_or_default(), false),
    };
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{json}");
    let _ = stdout.flush();
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}

/// The whole pipeline for one request: spawn → collect → cap → envelope.
pub fn execute(request: &Request) -> Result<Success, envelope::Failure> {
    execute_with(request, false)
}

/// `omit_truncation_content`: daemon-only wire dedup (see the call site).
pub fn execute_with(
    request: &Request,
    omit_truncation_content: bool,
) -> Result<Success, envelope::Failure> {
    execute_observed(request, omit_truncation_content, &mut runner::NoObserver)
}

/// Like execute_with, with a runner::RunObserver the daemon uses to report the
/// child pid and throttled partial output while the command runs.
pub fn execute_observed(
    request: &Request,
    omit_truncation_content: bool,
    observer: &mut dyn runner::RunObserver,
) -> Result<Success, envelope::Failure> {
    // Same tempFilePrefix the built-in bash tool passes (pi-bash), so a spill
    // path is byte-identical modulo the unique suffix.
    let mut accumulator = OutputAccumulator::new("pi-bash");
    let outcome = runner::run_observed(request, &mut accumulator, observer);
    accumulator.finish();

    if let Some(message) = outcome.spawn_error {
        let snapshot = accumulator.snapshot(false);
        let (text, _) = format_output(&mut accumulator, snapshot, "");
        let detail = if text.trim().is_empty() {
            message
        } else {
            format!("{text}\n\n{message}")
        };
        return Err(envelope::failure("spawn", detail));
    }
    if outcome.timed_out {
        let snapshot = accumulator.snapshot(false);
        let (text, _) = format_output(&mut accumulator, snapshot, "");
        let secs = request.timeout_seconds.unwrap_or_default();
        let status = format!("Command timed out after {secs} seconds");
        return Err(envelope::failure(
            "timeout",
            render::append_status(&text, &status),
        ));
    }
    let Some(exit_code) = outcome.exit_code else {
        return Err(envelope::failure(
            "io",
            "Command terminated without an exit code",
        ));
    };

    // Single materialization of the stream: the spill file (or raw buffer) is
    // read exactly once, and the structured output is derived from that same
    // buffer after compression instead of re-reading it a second time.
    let structured_output_path = accumulator.temp_output_path();
    let last_line_bytes = accumulator.last_line_bytes();
    let full_text = accumulator.into_full_text();
    let full_output_path = structured_output_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());

    // ---- Option B: Tier-1 shadow pre-pass over the FULL stream ----
    // Compress the complete output (from the spill file when one exists, else
    // the in-memory raw buffer) so errors buried in the middle of a huge
    // failing stream survive. Then feed the compressed text through the legacy
    // tail-truncation/parity path, unchanged, so the envelope shape is intact.
    let kind = compress::classify(&request.command);
    let success = exit_code == 0;
    // Prune to the model-visible budget (40 lines / 2 KB), not the accumulator's
    // 2000 / 50 KB spill cap, so the gate's H1 can pass the result through.
    let compressed = compress::compress_output(
        &full_text,
        kind,
        success,
        compress::COMPRESS_MAX_LINES,
        compress::COMPRESS_MAX_BYTES,
    );

    // Parity-shaped display + truncation over the (cleaned/pruned) stream, using
    // a scratch accumulator so the original's spill writer/raw stay intact.
    let mut scratch = OutputAccumulator::new("pi-bash-shadow");
    scratch.append(compressed.content.as_bytes());
    scratch.finish();
    let snapshot = scratch.snapshot(false);
    let truncated = snapshot.truncation.truncated;
    let (text, mut truncation) = format_output(&mut scratch, snapshot, "(no output)");
    // `truncation.content` duplicates `text` on the wire; drop it for the daemon
    // exactly as before (the extension restores it from `text`).
    if omit_truncation_content
        && let Some(t) = truncation.as_mut()
    {
        t.content = String::new();
    }
    // If the shadow pre-pass still overflows, the scratch accumulator wrote its
    // OWN spill; the model-visible reference must point at the ORIGINAL full
    // spill (which holds the untouched stream), not the scratch copy.
    let shadow_spill = scratch.temp_output_path();
    drop(scratch);
    if let Some(path) = shadow_spill {
        let _ = std::fs::remove_file(path);
    }

    // `truncated`, `truncation`, and `fullOutputPath` mirror the built-in oracle
    // exactly (based on the ORIGINAL stream's 2000-line / 50 KB window).
    // Compression is a separate, additive signal (`compression` metadata + the
    // omission marker in `text`), so machine-readable parity is preserved even
    // though the display text diverges by design.
    //
    // The scratch accumulator ran over the compressed (fitting) text, so its own
    // `truncated` is false. To keep the envelope consistent with the original
    // window, recompute from the accumulator's real spill state.
    let original_truncated = full_output_path.is_some();
    let truncated = original_truncated || truncated;
    if truncation.is_none() && original_truncated {
        // The original spilled: surface an oracle-shaped truncation object so the
        // extension's `details` carries the spill reference.
        let original_lines = full_text.lines().count();
        truncation = Some(crate::truncate::Truncation {
            content: String::new(),
            truncated: true,
            truncated_by: Some("bytes"),
            total_lines: original_lines,
            total_bytes: full_text.len(),
            output_lines: compressed.content.lines().count(),
            output_bytes: compressed.content.len(),
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines: compress::COMPRESS_MAX_LINES,
            max_bytes: compress::COMPRESS_MAX_BYTES,
        });
    }
    let compression = if compressed.strategy == compress::Strategy::None {
        None
    } else {
        Some(compress::CompressionMeta {
            strategy: compressed.strategy.as_str(),
            original_chars: full_text.chars().count(),
            visible_chars: compressed.content.chars().count(),
            omitted_chars: compressed.omitted_chars,
            spill_used: full_output_path.is_some(),
            full_output_path: full_output_path.clone(),
        })
    };
    let token_estimate = compress::token_estimate(&text);

    // Derive the programmatic payload from the already-materialized stream:
    // under the 1 MiB cap the buffer moves through with no second copy, past
    // it the middle is replaced by the oracle's omission marker.
    let (structured_output, structured_truncated) =
        cap_full_output(full_text, structured_limit());

    Ok(Success {
        ok: true,
        text,
        truncated,
        full_output_path,
        exit_code,
        wall_time_seconds: outcome.wall_time_seconds,
        structured_output,
        structured_truncated,
        truncation,
        last_line_bytes,
        compression,
        token_estimate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Request;

    fn run_command(command: &str) -> Success {
        run_command_env(command, None)
    }

    fn run_command_env(command: &str, env: Option<std::collections::HashMap<String, String>>) -> Success {
        let request = Request {
            command: command.to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: None,
            env,
        };
        execute(&request).expect("command runs")
    }

    /// Strip the trailing `[... Showing ... Full output: <path>]` / `[output
    /// capped ... <path>]` note, leaving only the compressed content — the
    /// note carries a unique spill filename and is not part of the payload.
    fn body_without_spill_note(text: &str) -> &str {
        match text.find("\n\n[") {
            Some(idx) => &text[..idx],
            None => text,
        }
    }

    #[test]
    fn small_output_has_no_spill_and_no_compression() {
        let env = run_command("printf 'hello\\nworld\\n'");
        // Within budget: byte-identical passthrough (trailing newline kept,
        // matching the built-in oracle).
        assert_eq!(env.text, "hello\nworld\n");
        assert!(env.full_output_path.is_none());
        assert!(env.compression.is_none());
        assert!(env.token_estimate > 0);
    }

    #[test]
    fn oversized_successful_output_is_compressed_within_budget() {
        // seq 1 5000 (~24 KB) compresses into the 2 KB model budget, so the
        // display fits and no envelope-level spill reference is emitted
        // (requirement: spill only when the compressed result still overflows).
        let env = run_command("seq 1 5000");
        let c = env.compression.expect("compression meta");
        assert_eq!(c.strategy, "head-tail");
        assert!(c.omitted_chars > 0);
        assert!(env.text.contains("omitted"), "carries an omission marker");
        assert!(
            env.text.split('\n').count() <= compress::COMPRESS_MAX_LINES + 4,
            "fits the model-visible line budget"
        );
    }

    #[test]
    fn output_beyond_the_spill_cap_still_spills() {
        // Beyond the accumulator's 50 KB spill cap the original stream is kept
        // in a spill file, referenced from the envelope.
        let env = run_command("seq 1 20000");
        assert!(env.full_output_path.is_some(), "spill reference kept");
        assert!(env.compression.is_some(), "compression meta present");
    }

    #[test]
    fn oversized_failing_test_preserves_middle_error_lines() {
        // Errors sit in the MIDDLE of a huge failing stream. Option B must
        // surface them even though legacy tail truncation would drop them.
        // A stub `cargo` on PATH forces the Test classification while emitting
        // a deterministic failing stream.
        let dir = std::env::temp_dir().join(format!("pibash-stub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("cargo");
        std::fs::write(
            &stub,
            "#!/bin/sh\n\
             i=0; while [ $i -lt 5000 ]; do echo \"   Compiling dep$i\"; i=$((i+1)); done; \
             echo 'error[E0308]: mismatched types'; \
             echo '  --> src/main.rs:42:5'; \
             echo 'test result: FAILED. 3 passed; 1 failed'; \
             i=0; while [ $i -lt 5000 ]; do echo \"   trailing noise $i\"; i=$((i+1)); done; \
             exit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut env_map = std::collections::HashMap::new();
        env_map.insert(
            "PATH".to_string(),
            format!("{}:/usr/bin:/bin", dir.display()),
        );
        let env = run_command_env("cargo test", Some(env_map));
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(env.exit_code, 1);
        let c = env.compression.expect("compression meta");
        assert_eq!(c.strategy, "error-priority");
        assert!(
            env.text.contains("error[E0308]: mismatched types"),
            "middle error line must survive: {}",
            &env.text[..env.text.len().min(200)]
        );
        assert!(env.text.contains("--> src/main.rs:42:5"));
        assert!(env.text.contains("test result: FAILED. 3 passed; 1 failed"));
    }

    #[test]
    fn multibyte_output_stays_valid_utf8() {
        let env = run_command("sh -c 'for i in $(seq 1 5000); do echo \"\u{8a9e}\u{8a9e}\u{8a9e}\u{8a9e}\"; done'");
        assert!(!env.text.contains('\u{FFFD}'));
        assert!(env.text.is_char_boundary(0));
        assert!(env.text.is_char_boundary(env.text.len()));
    }

    #[test]
    fn timeout_output_keeps_the_timeout_status() {
        let request = Request {
            command: "sleep 5".to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: Some(0.2),
            env: None,
        };
        match execute(&request) {
            Err(failure) => assert_eq!(failure.error.kind, "timeout"),
            Ok(_) => panic!("expected timeout failure"),
        }
    }

    #[test]
    fn compression_is_deterministic_across_runs() {
        let a = run_command("seq 1 5000");
        let b = run_command("seq 1 5000");
        // The spill note carries a unique temp path per run; the compressed
        // payload itself must be byte-identical.
        assert_eq!(
            body_without_spill_note(&a.text),
            body_without_spill_note(&b.text)
        );
        assert_eq!(
            a.compression.map(|c| c.omitted_chars),
            b.compression.map(|c| c.omitted_chars)
        );
    }
}
