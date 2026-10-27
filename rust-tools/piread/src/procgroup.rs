//! Process-group isolation for every `--serve` daemon.
//!
//! A daemon is a long-lived helper the client keeps across many tool calls.
//! Without isolation it inherits the client's process group, so any group-wide
//! signal — `pibash`'s own `kill_tree` on a command timeout (it signals
//! `-<pid>`), a job-control kill, a CI/terminal timeout — takes the daemon down
//! with the client. The next request then has to rebuild the connection, and a
//! request already written but not yet answered is lost.
//!
//! `setpgid(0, 0)` puts the daemon in a process group of its own (its pid),
//! which stops group-wide signals from the client's group reaching it.
//!
//! Why `setpgid` and not `setsid`:
//! - `setsid()` fails with EPERM whenever the caller is already a process-group
//!   leader — which is exactly how a supervisor such as Node/Electron spawns
//!   children. Working around it needs a fork-first dance, which a daemon that
//!   must report its own pid cannot do simply.
//! - `setsid()` also starts a new *session* and drops the controlling terminal.
//!   A stdio daemon does not use the terminal, so that is strictly more
//!   disruption than the isolation requires.
//! - `setpgid(0, 0)` on self is always legal and is the same call Rust's own
//!   `CommandExt::process_group(0)` makes for child processes (the pattern
//!   `runner.rs` already uses for pibash's shell children).
//!
//! The daemon still exits on its own terms: stdin EOF when the client goes away
//! (`piread`/`piedit`/`pibash` serve loops all stop on EOF).
//!
//! Portability: `setpgid` is POSIX.1, present in glibc, musl, and Apple
//! libSystem. On non-unix the call is a no-op (the harness targets macOS +
//! Linux; Windows is unsupported but must still compile and degrade).

/// Put the current process in its own process group.
///
/// Best-effort and idempotent: a second call finds the process already a group
/// leader and is a no-op either way. A failure is reported once to stderr and
/// otherwise ignored — losing isolation is strictly better than refusing to
/// serve, and the daemon's own stdin-EOF exit still bounds its lifetime.
pub fn isolate_process_group(daemon: &str) {
    #[cfg(unix)]
    {
        // SAFETY: `setpgid` only writes process attributes; it takes no
        // pointers and cannot invalidate memory.
        if unsafe { libc_setpgid(0, 0) } == -1 {
            let err = std::io::Error::last_os_error();
            eprintln!("{daemon} --serve: process-group isolation unavailable: {err}");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = daemon;
    }
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "setpgid"]
    fn libc_setpgid(pid: i32, pgid: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// After isolation the daemon must be its own group leader: pgid == pid.
    #[cfg(unix)]
    #[test]
    fn isolate_makes_the_process_a_group_leader() {
        let pid = std::process::id() as i32;
        isolate_process_group("test");
        assert_eq!(
            pgid_of(pid),
            pid,
            "setpgid(0, 0) should make pgid == pid"
        );
        // Idempotent: a second call must not fail or change anything.
        isolate_process_group("test");
        assert_eq!(pgid_of(pid), pid);
    }

    #[cfg(unix)]
    fn pgid_of(pid: i32) -> i32 {
        unsafe extern "C" {
            #[link_name = "getpgid"]
            fn libc_getpgid(pid: i32) -> i32;
        }
        // SAFETY: getpgid is a pure query.
        unsafe { libc_getpgid(pid) }
    }
}
