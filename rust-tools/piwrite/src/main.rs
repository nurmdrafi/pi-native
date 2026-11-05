//! piwrite — native file-write tool for the pi agent harness.
//!
//! One invocation reads raw bytes from stdin to EOF, creates parent
//! directories recursively, and writes the bytes verbatim (binary-safe, no
//! newline translation) — the wire form of the built-in `write` tool's
//! mkdir-recursive + writeFile, minus Node's per-call process cost. The
//! result prints as a single JSON envelope line on stdout; the extension
//! (`extensions/piwrite/index.ts`) turns that envelope into the built-in's
//! `Successfully wrote to <path>` result text.
//!
//! Exit codes: 0 ok · 2 usage (JSON) · 3 I/O error (JSON) · in `--serve`
//! mode, malformed framing exits 1 (JSON).

mod cli;
mod envelope;
mod procgroup;
mod serve;
#[path = "bounds.gen.rs"]
mod bounds;

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::ExitCode;

use cli::{parse_args, Parsed};

/// The single reused chunk for streaming copies: one read + one write
/// syscall per MiB keeps a 100 MB transfer near 200 syscalls total while
/// never holding the body in memory.
const COPY_CAP: usize = 1 << 20;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&argv) {
        Ok(Parsed::Help) => {
            print!("{}", cli::HELP);
            ExitCode::SUCCESS
        }
        Ok(Parsed::Version) => {
            println!("piwrite {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Parsed::Serve) => serve::serve(),
        Ok(Parsed::Run(path)) => run_oneshot(&path),
        Err(msg) => {
            println!("{}", envelope::fail_line(&msg));
            ExitCode::from(2)
        }
    }
}

/// One-shot mode: stdin → EOF as raw bytes, then the same write the daemon
/// performs per request. Usage errors never reach I/O; a failure here is an
/// I/O failure (unreadable stdin, un-creatable parents, un-writable path)
/// and prints an error envelope with exit 3.
fn run_oneshot(path: &str) -> ExitCode {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    match stream_to_file(&mut input, path) {
        Ok(n) => {
            println!("{}", envelope::ok_line(path, n));
            ExitCode::SUCCESS
        }
        Err(err) => {
            println!("{}", envelope::fail_line(&err.to_string()));
            ExitCode::from(3)
        }
    }
}

/// Chunked copy stdin → file through ONE reused 1 MiB buffer (read chunk,
/// write chunk, repeat): the body is never held whole, and reads this
/// large bypass `StdinLock`'s internal buffer, so the loop is one read +
/// one write syscall per MiB. Returns the total bytes written.
pub(crate) fn stream_to_file(input: &mut impl Read, path: &str) -> io::Result<u64> {
    let mut file = create_file(path)?;
    let mut buf = vec![0u8; COPY_CAP];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        file.write_all(&buf[..n])?;
        total += n as u64;
    }
}

/// Mkdir fast-path + create-or-truncate open, shared by both modes: stat
/// the direct parent once and only walk the components when it is missing.
pub(crate) fn create_file(path: &str) -> io::Result<File> {
    let p = Path::new(path);
    if let Some(dir) = p.parent() {
        // A bare filename's parent is "" — there is nothing to create.
        if !dir.as_os_str().is_empty() && !dir_is_present(dir) {
            std::fs::create_dir_all(dir)?;
        }
    }
    File::create(p)
}

/// One stat answers "does the parent directory exist". Any error (a
/// missing dir, EACCES, a parent that is a file) falls back to the
/// recursive walk, which surfaces the real error if the path cannot be
/// built — the same outcome the old always-walk produced.
fn dir_is_present(dir: &Path) -> bool {
    std::fs::metadata(dir).map(|m| m.is_dir()).unwrap_or(false)
}
