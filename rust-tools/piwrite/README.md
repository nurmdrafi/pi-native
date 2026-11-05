# piwrite — native write pipeline

Rust crate behind the `piwrite` tool: one invocation performs the built-in
`write` tool's mkdir-recursive + write-bytes in one short-lived process. The
content arrives as raw bytes on stdin — never argv, which breaks on large
content and on bytes that cannot round-trip through the OS argument vector —
so writes are binary-safe with no newline translation. The result prints as
one JSON envelope line on stdout; the extension turns it into the built-in's
`Successfully wrote to <path>` result text.

- Extension: `extensions/piwrite/index.ts` — registers `piwrite` unconditionally, schema and success message copied verbatim from `createWriteToolDefinition`; `PI_WRITE_BIN` overrides the binary path (resolved per call)
- Tests: `tests/oneshot.rs`, `tests/serve.rs`
- Bench: `../../benchmark/piwrite/` — summary plus raw NDJSON per run

Status: shipped, registers unconditionally, Rust is the only executor; 51
tests. The extension spawns one-shot per call — a write is one process
lifetime of work, so a persistent daemon would amortize nothing. `--serve` is
the second transport: benchmarked below, and the streaming reference for the
framing.

---

## CLI contract

One-shot: `piwrite --path <P>` — stdin is read to EOF as raw bytes and
written verbatim; missing parent directories are created recursively; the
body is never held in memory whole (one reused 1 MiB buffer, one read + one
write syscall per MiB).

Daemon: `piwrite --serve` — each request is one header line
`{"path":"<string>","bytes":<N>}` followed immediately by exactly `N` raw
body bytes (binary-safe, no trailing newline; the next header follows the
body). One response line per request, in request order.

- Malformed framing (bad header line, missing/non-numeric/oversized `bytes`
  above 1 TiB, unterminated header at EOF) answers one `{"ok":false,…}` line
  and exits 1 — framing is unrecoverable on a byte stream.
- EOF mid-body answers `{"ok":false,"error":"truncated body"}` and exits 0;
  the arrived prefix stays on disk, so all-or-nothing callers write to a temp
  path and rename.
- A per-request I/O failure answers an error envelope, drains the remaining
  body so framing stays in sync, and the loop continues.

Exit codes: 0 ok · 2 usage (JSON) · 3 I/O error (JSON) · 1 malformed framing
(`--serve` only). `--help` / `--version` print and exit 0.

## Envelope

```jsonc
// success
{ "ok": true, "path": "…", "bytes": 1234 }
// failure
{ "ok": false, "error": "…" }
```

Serialization is hand-rolled and byte-identical to `serde_json`, pinned by
unit tests — the piread envelope discipline minus its large-content scan: the
only string piwrite ever emits is the echoed path.

## Pipe enlargement

`--serve` best-effort grows its stdin pipe to 1 MiB with
`fcntl(fd, F_SETPIPE_SZ, BUF_CAP)` — a raw `extern "C"` declaration, no
`libc` crate. The kernel's 64 KiB default caps any feeder at one round trip
per write no matter how large the daemon's own reads are; at 1 MiB the
feeder's writes and the daemon's reads stop ping-ponging. On any failure
(non-pipe fd, a lower `pipe-max-size` sysctl, non-Linux) the loop runs
unchanged through the default pipe.

## Benchmarks

| case | built-in | piwrite | Δ |
| --- | ---: | ---: | ---: |
| 4 KB write, serve p50 | 0.283 ms/op | 0.136 ms/op | **2.1x** |
| 100 MB write, one-shot throughput | 480 MB/s | 904 MB/s | **1.88x** |
| kernel-fed serve transfer | — | 1.0–1.2 GB/s | — |

Source: `../../benchmark/piwrite/results/summary-2026-11-05-rawframe3.md`
(raw NDJSON alongside).

## Build, install, test

- Build: `cargo build --release -p piwrite` (from `rust-tools/`)
- Install: `scripts/lib/install-native.sh` copies the release binary to
  `bin/piwrite` — wired into `scripts/bootstrap.sh` and
  `scripts/after-pull.sh`; a bare `cp` invalidates the adhoc signature
- Test: `cargo test -p piwrite` (from `rust-tools/`)
- Regenerate `src/bounds.gen.rs` after touching bounds:
  `node scripts/gen-bounds.mjs` (`--check` reports drift)
