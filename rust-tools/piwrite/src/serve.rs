//! Daemon mode (`piwrite --serve`): raw length-prefixed framing over stdio.
//!
//! Protocol (v2): each request is ONE header line
//! `{"path":"<string>","bytes":<u64>}\n` immediately followed by EXACTLY
//! `bytes` raw body bytes — binary-safe, no trailing newline; the next
//! request's header follows the body directly. Each request produces
//! exactly one response line on stdout — the same envelope the one-shot CLI
//! prints — in request order (sequential pipelining preserved).
//!
//! Streaming: the body never lives in memory whole — it is pumped from
//! stdin to the file through ONE reused 1 MiB buffer (`bytes` is never
//! pre-allocated), so a 100 MB write costs ~100 reads + ~100 writes, not a
//! JSON round-trip of the content.
//!
//! Failure modes:
//! - Malformed framing (bad header line, missing/non-numeric/oversized
//!   `bytes` > 2^40, unterminated header at EOF) is unrecoverable on a
//!   byte stream: the daemon answers one `{"ok":false,...}` line and exits
//!   1.
//! - EOF mid-body answers `{"ok":false,"error":"truncated body"}` and
//!   exits 0. Bytes already streamed to disk at that point STAY there —
//!   the file is create-or-truncate and only the arrived prefix is
//!   written; callers needing all-or-nothing must write to a temp path
//!   and rename.
//! - A per-request I/O failure (un-openable path, full disk) answers an
//!   error envelope, the remaining body bytes are drained so framing
//!   stays in sync, and the loop continues.
//! - EOF exactly at a header boundary exits 0.
//!
//! Parents are created with the mkdir fast-path (one stat of the direct
//! parent; the recursive walk only runs when it is missing).

use std::fs::File;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use serde::Deserialize;

use crate::envelope;

/// Size of the single reused header/body buffer. 1 MiB keeps a 100 MB
/// transfer around 200 syscalls while a tiny request pays no measurable
/// cost.
pub(crate) const BUF_CAP: usize = 1 << 20;

/// `bytes` sanity cap: 1 TiB. A larger value cannot be a real file write
/// the caller intends, so framing is rejected before any body is read.
const MAX_BYTES: u64 = 1 << 40;

/// One parsed header line. `bytes` is `u64`, so a missing field, a string,
/// a float, or a negative number all fail deserialization — exactly the
/// malformed-header cases the contract rejects.
#[derive(Deserialize, Debug)]
struct Request {
    path: String,
    bytes: u64,
}

/// Serve until stdin EOF, an unrecoverable framing error, or a closed
/// stdout (parent gone).
pub fn serve() -> ExitCode {
    // Own process group: a group-wide kill from the client's group (pibash's
    // kill_tree, job control, CI timeout) must not take the daemon down.
    crate::procgroup::isolate_process_group("piwrite");
    // stdin: the request pipe. Grown to the read size before the loop so a
    // userspace feeder is not capped at 64 KiB EAGAIN/wakeup round trips.
    let _ = enlarge_pipe(0);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    match serve_stream(&mut input, &mut output, BUF_CAP) {
        0 => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

/// Best-effort `fcntl(fd, F_SETPIPE_SZ, BUF_CAP)`: grow the pipe to the
/// daemon's read size. The kernel default (64 KiB) caps ANY userspace
/// feeder at one 64 KiB EAGAIN/wakeup round trip at a time, no matter how
/// large the daemon's own reads are; at 1 MiB the feeder's writes and the
/// daemon's reads stop ping-ponging. Returns whether the kernel applied
/// the new size; on any failure (non-pipe fd, a lower `pipe-max-size`
/// sysctl, non-Linux) the loop works unchanged through the default pipe.
fn enlarge_pipe(fd: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        const F_SETPIPE_SZ: i32 = 1031;
        // SAFETY: `fd` is a live descriptor owned for the call and fcntl
        // with F_SETPIPE_SZ takes an integer argument, no pointers; called
        // once at startup, before the single-threaded serve loop begins.
        unsafe { libc_fcntl(fd, F_SETPIPE_SZ, BUF_CAP as i32) != -1 }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fd;
        false
    }
}

#[cfg(target_os = "linux")]
unsafe extern "C" {
    #[link_name = "fcntl"]
    fn libc_fcntl(fd: i32, cmd: i32, ...) -> i32;
}

/// The framing loop over any byte stream; returns the exit code (0 clean,
/// 1 framing failure). `cap` is the single reused buffer's size; tests
/// shrink it to force header/body splits across read boundaries.
fn serve_stream(input: &mut impl Read, output: &mut impl Write, cap: usize) -> u8 {
    let mut buf = vec![0u8; cap];
    // Unconsumed input is buf[start..end]: the tail of one read carries the
    // next request's header, so consumption is index arithmetic, not reads.
    let (mut start, mut end) = (0usize, 0usize);
    // One response buffer reused across requests (capacity ratchets to the
    // largest response seen): serialize in place, append the newline, emit
    // with a single write — no per-response String, no re-growth.
    let mut resp: Vec<u8> = Vec::with_capacity(4 * 1024);
    loop {
        // ---- header phase: locate the '\n' ending the header line ----
        let header: &[u8] = match buf[start..end].iter().position(|&b| b == b'\n') {
            Some(i) => {
                let header = &buf[start..start + i];
                start += i + 1;
                header
            }
            None => {
                if start > 0 {
                    // Slide the unconsumed bytes to the front and read more.
                    buf.copy_within(start..end, 0);
                    end -= start;
                    start = 0;
                } else if end == buf.len() {
                    // Nothing to slide and no room left: the header line
                    // cannot fit the buffer. No real header (paths are
                    // bounded by the OS) is this long, so framing is
                    // unrecoverable.
                    return fail(output, &mut resp, "bad framing: header line too long", 1);
                }
                // An unreadable stdin is as good as EOF here.
                let n = input.read(&mut buf[end..]).unwrap_or_default();
                if n == 0 {
                    if start == end {
                        return 0; // EOF exactly at a header boundary
                    }
                    return fail(output, &mut resp, "bad framing: unterminated header", 1);
                }
                end += n;
                continue;
            }
        };
        let req = match parse_header(header) {
            Ok(req) => req,
            Err(msg) => return fail(output, &mut resp, &msg, 1),
        };
        // ---- body phase: stream exactly `req.bytes` raw bytes to disk ----
        // `file` is None exactly while `io_err` is Some (set together below
        // and never cleared): a failed request still drains its body so the
        // next header is found at the right offset.
        let (mut file, mut io_err): (Option<File>, Option<io::Error>) =
            match crate::create_file(&req.path) {
                Ok(f) => (Some(f), None),
                Err(err) => (None, Some(err)),
            };
        let mut remaining = req.bytes;
        while remaining > 0 {
            if start == end {
                start = 0;
                match input.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // EOF with body bytes still owed. Whatever was
                        // streamed already stays on disk (module doc).
                        return fail(output, &mut resp, "truncated body", 0);
                    }
                    Ok(n) => end = n,
                }
            }
            let take = ((end - start) as u64).min(remaining) as usize;
            let wrote = match file.as_mut() {
                Some(f) if io_err.is_none() => f.write_all(&buf[start..start + take]),
                _ => Ok(()), // draining an un-openable or already-failed write
            };
            if let Err(err) = wrote {
                io_err = Some(err); // keep draining; report at the end
            }
            start += take;
            remaining -= take as u64;
        }
        resp.clear();
        match io_err {
            None => envelope::write_ok(&mut resp, &req.path, req.bytes),
            Some(ref err) => envelope::write_fail(&mut resp, &err.to_string()),
        }
        resp.push(b'\n');
        if output.write_all(&resp).and_then(|_| output.flush()).is_err() {
            return 0; // stdout closed: the parent is gone, same as EOF
        }
    }
}

/// Parse one header line. Deserialization covers the whole malformed family
/// (not JSON, missing `path`/`bytes`, non-numeric `bytes`); the explicit
/// check bounds `bytes` before any body is read.
fn parse_header(line: &[u8]) -> Result<Request, String> {
    let req: Request = serde_json::from_slice(line).map_err(|err| format!("bad framing: {err}"))?;
    if req.bytes > MAX_BYTES {
        return Err(format!("bad framing: bytes {} exceeds the 2^40 cap", req.bytes));
    }
    Ok(req)
}

/// Emit one failure envelope line and return the exit code it mandates.
/// A closed stdout is ignored: there is nobody left to tell.
fn fail(output: &mut impl Write, resp: &mut Vec<u8>, msg: &str, code: u8) -> u8 {
    resp.clear();
    envelope::write_fail(resp, msg);
    resp.push(b'\n');
    let _ = output.write_all(resp).and_then(|_| output.flush());
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "piwrite-serve2-unit-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Drive the framing loop over an in-memory stream; returns the exit
    /// code and the raw response bytes.
    fn run(input: &[u8], cap: usize) -> (u8, Vec<u8>) {
        let mut reader = Cursor::new(input);
        let mut out = Vec::new();
        let code = serve_stream(&mut reader, &mut out, cap);
        (code, out)
    }

    /// One v2 frame: header line + exactly the body bytes. The path is
    /// JSON-encoded by serde_json so escaping is the reference form.
    fn frame(path: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "{{\"path\":{},\"bytes\":{}}}\n",
            serde_json::to_string(path).expect("serialize path"),
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn parse_accepts_two_to_the_fortieth_but_not_more() {
        let ok = parse_header(br#"{"path":"/a","bytes":1099511627776}"#);
        assert_eq!(ok.expect("2^40 is the cap").bytes, 1 << 40);
        let err = parse_header(br#"{"path":"/a","bytes":1099511627777}"#);
        assert!(err.expect_err("over the cap").contains("2^40"));
    }

    #[test]
    fn parse_rejects_missing_or_non_numeric_bytes() {
        for line in [
            br#"{"path":"/a"}"#.as_slice(),
            br#"{"path":"/a","bytes":"5"}"#.as_slice(),
            br#"{"path":"/a","bytes":5.5}"#.as_slice(),
            br#"{"path":"/a","bytes":-1}"#.as_slice(),
            br#"{"bytes":5}"#.as_slice(), // missing path
        ] {
            assert!(parse_header(line).is_err(), "{line:?}");
        }
    }

    #[test]
    fn parse_round_trips_a_unicode_path() {
        let req = parse_header("{\"path\":\"héllo/世界.bin\",\"bytes\":5}".as_bytes())
            .expect("unicode path is a valid header");
        assert_eq!(req.path, "héllo/世界.bin");
        assert_eq!(req.bytes, 5);
    }

    #[test]
    fn body_spanning_many_chunks_keeps_framing_in_sync() {
        // cap=128: the ~70-byte header fits one read; a 300-byte body spans
        // three; the second request's header straddles a read boundary and
        // forces the compaction slide.
        let one = scratch("chunks").join("one.bin");
        let two = scratch("chunks").join("two.bin");
        let body: Vec<u8> = (0..=255u8).chain(0..44u8).collect(); // 300 bytes
        let mut input = frame(one.to_str().expect("utf-8"), &body);
        input.extend_from_slice(&frame(two.to_str().expect("utf-8"), b"end"));
        let (code, out) = run(&input, 128);
        assert_eq!(code, 0);
        let text = String::from_utf8(out).expect("utf-8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].starts_with("{\"ok\":true,"), "{text}");
        assert!(lines[1].starts_with("{\"ok\":true,"), "{text}");
        assert_eq!(std::fs::read(&one).expect("written"), body);
        assert_eq!(std::fs::read(&two).expect("written"), b"end");
    }

    #[test]
    fn newline_ending_a_read_and_zero_byte_bodies() {
        // Pad the file name so the header + '\n' is EXACTLY cap bytes: the
        // '\n' lands on a read boundary and the body starts the next read.
        // A zero-byte body means the next header follows immediately.
        let dir = scratch("nl");
        let mut name = String::from("zw.bin");
        let mut file = dir.join(&name);
        while frame(file.to_str().expect("utf-8"), b"").len() < 128 {
            name.insert(0, 'x');
            file = dir.join(&name);
        }
        let last = dir.join("last.bin");
        let mut input = frame(file.to_str().expect("utf-8"), b"");
        input.extend_from_slice(&frame(last.to_str().expect("utf-8"), b""));
        let (code, out) = run(&input, 128);
        assert_eq!(code, 0);
        let text = String::from_utf8(out).expect("utf-8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].contains("\"bytes\":0"), "{text}");
        assert!(std::fs::read(&file).expect("written").is_empty());
        assert!(std::fs::read(&last).expect("written").is_empty());
    }

    #[test]
    fn truncated_body_exits_zero_with_partial_file() {
        let file = scratch("trunc").join("t.bin");
        let path = file.to_str().expect("utf-8");
        let mut input = frame(path, &[0u8; 10]);
        input.truncate(input.len() - 6); // 4 of 10 body bytes arrive
        let (code, out) = run(&input, 128);
        assert_eq!(code, 0);
        assert_eq!(out, b"{\"ok\":false,\"error\":\"truncated body\"}\n");
        assert_eq!(std::fs::read(&file).expect("partial write"), &[0u8; 4]);
    }

    #[test]
    fn unterminated_header_exits_one() {
        let (code, out) = run(b"{\"path\":\"/a\",\"bytes\":3", 128);
        assert_eq!(code, 1);
        assert!(out.starts_with(b"{\"ok\":false,\"error\":\""), "{out:?}");
    }

    #[test]
    fn header_longer_than_the_buffer_exits_one() {
        let (code, out) = run(
            b"{\"path\":\"/a/very/long/path/that/will/not/fit\",\"bytes\":3}\nxyz",
            8,
        );
        assert_eq!(code, 1);
        assert!(out.starts_with(b"{\"ok\":false,\"error\":\""), "{out:?}");
    }

    #[test]
    fn io_failure_drains_body_and_continues() {
        let dir = scratch("iodir").join("d");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let good = scratch("iodir").join("g.txt");
        let mut input = frame(dir.to_str().expect("utf-8"), b"junk");
        input.extend_from_slice(&frame(good.to_str().expect("utf-8"), b"ok"));
        let (code, out) = run(&input, 128);
        assert_eq!(code, 0);
        let text = String::from_utf8(out).expect("utf-8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].starts_with("{\"ok\":false,"), "{text}");
        assert!(lines[1].starts_with("{\"ok\":true,"), "{text}");
        assert_eq!(std::fs::read(&good).expect("written"), b"ok");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enlarge_pipe_is_best_effort_on_a_non_pipe_fd() {
        use std::os::fd::AsRawFd;
        // A regular file descriptor is not a pipe: the request must be
        // refused (false), must not panic, and must leave the fd usable.
        let file = std::fs::File::create(scratch("npfd")).expect("create");
        assert!(!enlarge_pipe(file.as_raw_fd()));
        assert_eq!(file.metadata().expect("still usable").len(), 0);
    }
}
