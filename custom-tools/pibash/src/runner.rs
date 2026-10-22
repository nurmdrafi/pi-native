use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::accumulator::OutputAccumulator;
use crate::cli::Request;

/// Outcome of one shell run.
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub wall_time_seconds: f64,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
}

/// Resolve the shell binary the way the built-in does: `$SHELL` when it is a
/// known POSIX-ish shell, else `bash`, else `sh` from PATH.
#[must_use]
pub fn resolve_shell() -> String {
    let override_shell = std::env::var("PI_BASH_SHELL").ok();
    choose_shell(
        override_shell.as_deref(),
        Path::new("/bin/bash").exists(),
        which("bash"),
    )
}

/// The built-in's getShellConfig ignores $SHELL: a zsh login shell does not
/// change which shell tools run under. It prefers /bin/bash, then bash on PATH,
/// then sh. PI_BASH_SHELL is pibash's own test/deployment override.
fn choose_shell(override_shell: Option<&str>, bin_bash: bool, bash_on_path: bool) -> String {
    if let Some(shell) = override_shell.filter(|shell| !shell.is_empty()) {
        return shell.to_string();
    }
    if bin_bash {
        return "/bin/bash".to_string();
    }
    if bash_on_path {
        return "bash".to_string();
    }
    "sh".to_string()
}

/// Minimal PATH lookup for a bare executable name (the oracle shells out to
/// which; a stat per entry is cheaper and has no locale/timeout surface).
fn which(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(program).is_file())
}

/// Observer the runner notifies while a command runs. The daemon uses it to
/// report the child pid (so a client can cancel) and throttled partial output;
/// the one-shot path and unit tests pass NoObserver.
pub trait RunObserver {
    /// Called once, right after the shell spawns, with its pid.
    fn started(&mut self, _pid: u32) {}
    /// Called whenever new output was appended to the accumulator.
    fn update(&mut self, _accumulator: &mut OutputAccumulator) {}
}

/// A RunObserver that ignores everything.
pub struct NoObserver;

impl RunObserver for NoObserver {}

/// Convenience wrapper for tests: run with no observer.
#[cfg(test)]
pub fn run(req: &Request, accumulator: &mut OutputAccumulator) -> RunOutcome {
    run_observed(req, accumulator, &mut NoObserver)
}

/// Run with an observer, which may emit the pid and partial-output snapshots.
pub fn run_observed(
    req: &Request,
    accumulator: &mut OutputAccumulator,
    observer: &mut dyn RunObserver,
) -> RunOutcome {
    let started = Instant::now();
    if !req.cwd.is_dir() {
        return RunOutcome {
            exit_code: None,
            wall_time_seconds: 0.0,
            timed_out: false,
            spawn_error: Some(format!(
                "Working directory does not exist: {}",
                req.cwd.display()
            )),
        };
    }

    let shell = resolve_shell();
    let mut command = Command::new(&shell);
    command
        .arg("-c")
        .arg(&req.command)
        .current_dir(&req.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The daemon client sends the full environment (PI_* injection + managed
    // PATH); the one-shot CLI leaves it unset and inherits its own.
    if let Some(env) = &req.env {
        command.env_clear();
        command.envs(env);
    }
    // Put the shell in its own process group so a timeout can kill the whole
    // tree (shell + descendants) rather than just the direct child.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return RunOutcome {
                exit_code: None,
                wall_time_seconds: elapsed_seconds(started),
                timed_out: false,
                spawn_error: Some(format!("failed to spawn {shell}: {err}")),
            };
        }
    };

    let pid = child.id();
    observer.started(pid);
    // Drain both pipes on their own threads so a full pipe never deadlocks the
    // wait below; chunks are forwarded in arrival order.
    let (tx, rx) = mpsc::channel::<(Stream, Vec<u8>)>();
    if let Some(stdout) = child.stdout.take() {
        let _ = spawn_reader(stdout, Stream::Stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        let _ = spawn_reader(stderr, Stream::Stderr, tx.clone());
    }
    drop(tx);

    let mut pending_out: Vec<Vec<u8>> = Vec::new();
    let mut pending_err: Vec<Vec<u8>> = Vec::new();

    // Reap on a dedicated thread so we can block without a poll interval: the
    // previous 2 ms `try_wait` loop added up to 2 ms of dead time to commands
    // that finish in ~1 ms (the common case), which dominated the latency.
    let (done_tx, done_rx) = mpsc::channel::<std::process::ExitStatus>();
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = done_tx.send(status);
        }
    });

    let deadline = req
        .timeout_seconds
        .map(|secs| Instant::now() + Duration::from_secs_f64(secs));
    let mut timed_out = false;
    let mut status: Option<std::process::ExitStatus> = None;

    loop {
        while let Ok((stream, chunk)) = rx.try_recv() {
            match stream {
                Stream::Stdout => pending_out.push(chunk),
                Stream::Stderr => pending_err.push(chunk),
            }
        }
        if flush_pending(&mut pending_out, &mut pending_err, accumulator) {
            observer.update(accumulator);
        }

        match done_rx.recv_timeout(Duration::from_millis(1)) {
            Ok(exit_status) => {
                status = Some(exit_status);
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if let Some(deadline) = deadline
            && Instant::now() >= deadline
        {
            timed_out = true;
            kill_tree(pid);
            match done_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(exit_status) => status = Some(exit_status),
                Err(_) => kill_tree_hard(pid),
            }
            break;
        }
    }

    // A descendant the shell backgrounded can hold the pipe open (a background
    // sleep), so waiting for EOF would block until that process exits. The
    // built-in resolves the moment the shell exits; drain only in-flight bytes
    // and then abandon readers that never see EOF.
    drain_readers(&rx, &mut pending_out, &mut pending_err);
    // The final flush may be the ONLY flush for a fast command whose output
    // arrived after the loop broke on child exit. Notify the observer so the
    // last partial is streamed, not just accumulated (previously this flush
    // was silent: the observer never saw short-lived commands' output).
    if flush_pending(&mut pending_out, &mut pending_err, accumulator) {
        observer.update(accumulator);
    }

    let exit_code = status.map(|s| exit_code_of(&s));
    RunOutcome {
        exit_code,
        wall_time_seconds: elapsed_seconds(started),
        timed_out,
        spawn_error: None,
    }
}

/// Which pipe a chunk came from.
#[derive(Debug, Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

/// How long to keep draining reader threads that may never see EOF because a
/// detached descendant inherited the pipe. Readers on a normal command hit EOF
/// and disconnect the channel immediately, so this only bounds the rare case.
const READER_GRACE: Duration = Duration::from_millis(30);

/// Drain in-flight chunks until the readers finish or the grace period lapses.
fn drain_readers(
    rx: &mpsc::Receiver<(Stream, Vec<u8>)>,
    out: &mut Vec<Vec<u8>>,
    err: &mut Vec<Vec<u8>>,
) {
    let deadline = Instant::now() + READER_GRACE;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(remaining) {
            Ok((stream, chunk)) => match stream {
                Stream::Stdout => out.push(chunk),
                Stream::Stderr => err.push(chunk),
            },
            Err(_) => break,
        }
    }
    while let Ok((stream, chunk)) = rx.try_recv() {
        match stream {
            Stream::Stdout => out.push(chunk),
            Stream::Stderr => err.push(chunk),
        }
    }
}

/// Emit everything that has arrived. Within one drained batch stdout is kept
/// ahead of stderr so a command that prints then fails reads in that order;
/// both streams keep their own relative ordering.
fn flush_pending(
    out: &mut Vec<Vec<u8>>,
    err: &mut Vec<Vec<u8>>,
    accumulator: &mut OutputAccumulator,
) -> bool {
    let mut appended = false;
    for chunk in out.drain(..) {
        accumulator.append(&chunk);
        appended = true;
    }
    for chunk in err.drain(..) {
        accumulator.append(&chunk);
        appended = true;
    }
    appended
}

fn spawn_reader<R: Read + Send + 'static>(
    mut source: R,
    stream: Stream,
    tx: mpsc::Sender<(Stream, Vec<u8>)>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        // 64 KB matches the Linux pipe capacity: one read syscall drains a
        // full pipe buffer, cutting syscalls, per-read Vec allocations, and
        // channel sends ~8x for large streams (macOS pipes are 16 KB — a
        // larger read buffer simply never fills past that, still correct).
        let mut buffer = [0u8; 64 * 1024];
        loop {
            match source.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if tx.send((stream, buffer[..read].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    })
}

/// `exit(status)`, or `128 + signal` — the convention the built-in bash tool
/// applies to signal-killed shells.
#[cfg(unix)]
fn exit_code_of(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    if let Some(code) = status.code() {
        return code;
    }
    status.signal().map_or(1, |signal| 128 + signal)
}

#[cfg(not(unix))]
fn exit_code_of(status: &std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // Snapshot BEFORE the group signal: once the shell dies, group-escaped
    // survivors reparent to init and become unreachable by parent walk.
    let escapees = escaped_descendants(pid);
    signal_group(pid, "TERM");
    signal_each(&escapees, "TERM");
}

#[cfg(unix)]
fn kill_tree_hard(pid: u32) {
    let escapees = escaped_descendants(pid);
    signal_group(pid, "KILL");
    signal_each(&escapees, "KILL");
}

/// PIDs below `root` that left the shell's process group (setsid/setpgid
/// escapees) and will never see a group signal. The shell's pgid equals its
/// pid (`process_group(0)` at spawn), so a foreign pgrp marks an escapee.
#[cfg(target_os = "linux")]
fn escaped_descendants(root: u32) -> Vec<u32> {
    // pid -> (ppid, pgrp) from one /proc scan. `comm` may contain spaces and
    // parentheses, so parse the fields after the LAST ')'.
    let mut children: std::collections::HashMap<u32, Vec<u32>> =
        std::collections::HashMap::new();
    let mut pgrp_of: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for entry in dir.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let (Some(ppid), Some(pgrp)) = (fields.nth(1), fields.next()) else {
            continue;
        };
        let (Ok(ppid), Ok(pgrp)) = (ppid.parse::<u32>(), pgrp.parse::<u32>()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
        pgrp_of.insert(pid, pgrp);
    }
    // Breadth-first over the descendant tree; report foreign-pgrp members.
    let mut escapees = Vec::new();
    let mut frontier = vec![root];
    while let Some(p) = frontier.pop() {
        if let Some(kids) = children.get(&p) {
            for &pid in kids {
                frontier.push(pid);
                if pgrp_of.get(&pid).is_some_and(|&g| g != root) {
                    escapees.push(pid);
                }
            }
        }
    }
    escapees
}

#[cfg(all(unix, not(target_os = "linux")))]
fn escaped_descendants(_root: u32) -> Vec<u32> {
    // No /proc on macOS/BSD: group-escaped grandchildren stay a documented
    // limitation there (research/process-groups-cancellation.md §1.4).
    Vec::new()
}

#[cfg(unix)]
fn signal_each(pids: &[u32], signal: &str) {
    for pid in pids {
        // Dash form, like `signal_group`: procps `kill` rejects a bare
        // signal name as the first argument (exit 1, no signal sent).
        let _ = Command::new("kill")
            .arg(format!("-{signal}"))
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: &str) {
    // The child was spawned with process_group(0), so its pgid == its pid and a
    // negative pid targets the whole tree. Fall back to the direct pid.
    let group = format!("-{pid}");
    let sent = Command::new("kill")
        .args([format!("-{signal}"), group])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !sent {
        let _ = Command::new("kill")
            .args([format!("-{signal}"), pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(unix))]
fn kill_tree(_pid: u32) {}

#[cfg(not(unix))]
fn kill_tree_hard(_pid: u32) {}

fn elapsed_seconds(started: Instant) -> f64 {
    // The oracle rounds to 0.1s: `Math.round(ms / 100) / 10`.
    let millis = started.elapsed().as_millis() as f64;
    (millis / 100.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(command: &str) -> Request {
        Request {
            command: command.to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: None,
            env: None,
        }
    }

    #[test]
    fn captures_stdout_and_a_zero_exit() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let outcome = run(&request("printf 'hi\\n'"), &mut acc);
        acc.finish();
        let snapshot = acc.snapshot(false);
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(snapshot.content, "hi\n");
    }

    #[test]
    fn captures_stderr_and_a_non_zero_exit() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let outcome = run(&request("echo boom >&2; exit 3"), &mut acc);
        acc.finish();
        let snapshot = acc.snapshot(false);
        assert_eq!(outcome.exit_code, Some(3));
        assert!(snapshot.content.contains("boom"));
    }

    #[test]
    fn missing_working_directory_is_a_spawn_error() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let req = Request {
            command: "echo hi".to_string(),
            cwd: std::path::PathBuf::from("/definitely/not/here"),
            timeout_seconds: None,
            env: None,
        };
        let outcome = run(&req, &mut acc);
        assert!(outcome.spawn_error.is_some());
        assert_eq!(outcome.exit_code, None);
    }

    #[test]
    fn timeout_terminates_the_child_and_returns_promptly() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let req = Request {
            command: "sleep 30".to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: Some(0.4),
            env: None,
        };
        let started = Instant::now();
        let outcome = run(&req, &mut acc);
        assert!(outcome.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "timeout path must not block on the child"
        );
    }

    #[test]
    fn timeout_kills_descendants_too() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let req = Request {
            command: "sleep 45 & sleep 45".to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: Some(0.4),
            env: None,
        };
        let started = Instant::now();
        let outcome = run(&req, &mut acc);
        assert!(outcome.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timeout_kills_grandchildren_that_escape_the_process_group() {
        // `setsid` moves the grandchild into a new session, invisible to the
        // group signal — the exact orphan class the pre-TERM /proc snapshot
        // exists for. Skip where util-linux setsid is unavailable.
        if !Command::new("setsid")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return;
        }
        let mut acc = OutputAccumulator::new("pi-output-test");
        let req = Request {
            command: "setsid sleep 45 >/dev/null 2>&1 & sleep 0.3; sleep 45".to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: Some(1.2),
            env: None,
        };
        let outcome = run(&req, &mut acc);
        assert!(outcome.timed_out);
        // The escapee kill happens inside run(); allow scheduling slack only.
        std::thread::sleep(Duration::from_millis(300));
        let probe = Command::new("pgrep")
            .args(["-f", "sleep 45"])
            .output()
            .expect("pgrep available");
        let survivors = String::from_utf8_lossy(&probe.stdout);
        assert!(
            survivors.trim().is_empty(),
            "process-group escapee survived the timeout kill: {survivors}"
        );
    }

    #[test]
    fn shell_choice_prefers_bin_bash_and_ignores_shell_env() {
        // The built-in never consults $SHELL; a zsh login shell is irrelevant.
        assert_eq!(choose_shell(None, true, false), "/bin/bash");
        assert_eq!(choose_shell(Some(""), true, false), "/bin/bash");
        assert_eq!(choose_shell(None, false, true), "bash");
        assert_eq!(choose_shell(None, false, false), "sh");
    }

    #[test]
    fn shell_choice_honors_the_explicit_override() {
        assert_eq!(choose_shell(Some("/opt/bash"), true, true), "/opt/bash");
    }

    #[cfg(unix)]
    #[test]
    fn signal_killed_shell_reports_128_plus_signal() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let outcome = run(&request("kill -TERM $$"), &mut acc);
        acc.finish();
        assert_eq!(outcome.exit_code, Some(143)); // 128 + SIGTERM(15)
    }

    #[test]
    fn explicit_env_replaces_the_inherited_environment() {
        let mut acc = OutputAccumulator::new("pi-output-test");
        let mut env = std::collections::HashMap::new();
        env.insert("PIBASH_TEST".to_string(), "yes".to_string());
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        let req = Request {
            command: "printf '%s|%s' \"$PIBASH_TEST\" \"${HOME:-unset}\"".to_string(),
            cwd: std::env::temp_dir(),
            timeout_seconds: None,
            env: Some(env),
        };
        let outcome = run(&req, &mut acc);
        acc.finish();
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(acc.snapshot(false).content, "yes|unset");
    }

    #[test]
    fn detached_child_does_not_block_the_run() {
        // The background sleep inherits the pipe; the run must return when the
        // shell exits rather than waiting for that descendant to close it.
        let mut acc = OutputAccumulator::new("pi-output-test");
        let started = Instant::now();
        let outcome = run(&request("sleep 30 & echo done"), &mut acc);
        acc.finish();
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(acc.snapshot(false).content, "done\n");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "must not wait on a detached child"
        );
    }

    #[test]
    fn observer_receives_the_pid_and_output_updates() {
        struct Recorder {
            started: Option<u32>,
            updates: usize,
            last: String,
        }
        impl RunObserver for Recorder {
            fn started(&mut self, pid: u32) {
                self.started = Some(pid);
            }
            fn update(&mut self, accumulator: &mut OutputAccumulator) {
                self.updates += 1;
                self.last = accumulator.snapshot(false).content;
            }
        }

        let mut acc = OutputAccumulator::new("pi-output-test");
        let mut recorder = Recorder {
            started: None,
            updates: 0,
            last: String::new(),
        };
        let outcome = run_observed(&request("printf 'hello\n'"), &mut acc, &mut recorder);
        acc.finish();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(recorder.started.is_some_and(|pid| pid > 0));
        assert!(recorder.updates >= 1);
        assert!(recorder.last.contains("hello"));
    }
}

