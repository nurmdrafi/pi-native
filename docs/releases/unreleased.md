[Back to CHANGELOG](../../CHANGELOG.md)

## [Unreleased]

### Added

- **piwrite: native Rust write tool.** A workspace crate plus extension wrapper replaces the
  built-in write tool: one-shot mode streams raw stdin bytes to disk (binary-safe, parent
  directories created, 1 MiB buffered copy); serve mode frames each request as a
  `{"path","bytes"}` header line plus raw body bytes — no JSON tax — and best-effort grows its
  stdin pipe to 1 MiB (`F_SETPIPE_SZ`). Measured against the built-in: 4 KiB serve writes 2.1x
  faster (0.136 vs 0.291 ms/op); 100 MiB one-shot writes 1.88x faster (904 vs 480 MB/s);
  kernel-fed serve sustains 1.0-1.2 GB/s.

- **piwrite benchmark harness** (`npm run bench:piwrite`): three arms (in-process built-in,
  one-shot, serve) across 4 KiB-100 MiB, with tagged, resumable NDJSON results and a contract-
  exact shim for self-testing.

- **Permission-gate rule P3 `nativeWriteFirst`.** Built-in `write` is blocked with a pointer to
  piwrite while the extension is registered, mirroring P1/P2; setting the rule to `"off"`
  restores the built-in.

### Changed

- **Roster and docs adopt piwrite.** Nine agent definitions and the orchestration table declare
  `piwrite` instead of `write`; the native-tools, architecture, optimization, development, and
  contributing guides cover the tool, and the dashboard surfaces the P3 rule.
