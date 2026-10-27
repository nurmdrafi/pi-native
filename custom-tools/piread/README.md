# piread — native read pipeline

Rust crate behind the `piread` tool: one invocation runs the whole text-read pipeline
the built-in `read` performs in TypeScript (open → slice → render → truncate →
binary-detect) and prints a single JSON envelope. Byte-for-byte parity with the built-in
is enforced by `../../tests/piread-parity.test.mjs`; this crate owns the mechanics.

- Spec: `docs/specs/2026-10-16-s6-piread-design.md` (S6)
- Plan: `docs/specs/2026-10-16-s6-piread-plan.md`
- Extension: `extensions/piread/index.ts`
- Tests: `tests/cli.rs`, `tests/serve.rs`, `../../tests/piread-parity.test.mjs`
- Bench: `../../benchmark/runs/piread-microbench-*.md`

Status: shipped, default-on, opt out with `PI_NATIVE_READ=0`. Parity 150/150, gate
241/241 at the time of writing.

---

## Build walkthrough — steps tried

S6 was the first native-tool sub-project and established the pattern (individual
registration, fail-open ladder, parity oracle, gate lock-ins) that `piedit` later
reused. Steps below follow the spec plan and the commits in order.

### Step 0 — Baseline

1. Recorded the green baseline (`permission-gate`, `bench-suite`, `doc:check`,
   `typecheck`) and the toolchain before writing Rust.

### Step 1 — Crate skeleton, CLI contract (`f2e142d`)

2. `custom-tools/piread/Cargo.toml`: Rust 2024, deps `serde` + `serde_json` only (no `unsafe`),
   clippy `-D warnings`.
3. `src/cli.rs`: `--path` required; `--offset`/`--limit` integers ≥ 1; unknown flag →
   exit 2 + stderr; `--version`/`--help`; `--serve` reserved.
4. `src/envelope.rs`: `{ok, content, truncation, binary, totalBytes}` on success,
   `{ok, error:{kind,message}}` on failure, with Node-style error messages
   (`ENOENT`/`EACCES`/`EISDIR`) and exit 0/2/3 mapping.
5. Placeholder whole-file read; the streaming pipeline landed in Step 2.

### Step 2 — Streaming read pipeline (`252043a`)

6. Ported `truncateHead` parity: newline-segment **streaming** with JS `split`
   semantics (including the trailing phantom segment), decoded-byte cap arithmetic with
   the `+1` newline rule, the `firstLineExceedsLimit` short-circuit, and all three
   continuation notes pinned byte-exact against a one-time dump of the built-in tool.
7. Lossy UTF-8 decode matches Node's WHATWG replacement semantics — pinned on the
   tricky sequences (`C0 80`, `ED A0 80`, `F0 9F`, `F0 9F 8F 80`).
8. NUL sniff over the first 8 KiB; raw byte count; offset-beyond-EOF rejection with the
   built-in's message. Buffers at most `cap +` first line (never the whole file).

### Step 3 — Extension + parity oracle suite (`6f12b5e`)

9. `extensions/piread/index.ts`: env-gated native read tool, definition copied verbatim
   from `createReadToolDefinition` (byte-identical schema and prompt-cache prefix),
   dispatch to `bin/piread`, image extensions delegated to the private built-in
   instance, one stderr fallback line on any spawn/parse/binary problem.
10. Parity oracle suite (144 tests): corpus × offset/limit matrix, definition-identity
    lock-ins, fallback cases.
11. Typecheck needed structural casts to bridge the nested `pi-agent-core` d.ts identity
    (does not unify under `skipLibCheck`) and the envelope-rebuilt truncation payload.
12. README documented piread as the native read tool (not a behavioural extension);
    `doc:check` env-var + inventory green.

### Step 4 — Gate-compat lock-ins (`169d1d7`)

13. Three lock-ins through the real permission-gate (stubbed events): R1 read coverage
    certifies a piread-wrapped result (a duplicate read of the certified window blocks);
    S5 M2 edit-after-piread-read passes the region requirement (with an Unread negative
    control proving the gate is armed); a protected-path (`node_modules`) read blocks at
    `tool_call` before execution (instrumented execute: zero calls). All green on first
    run — the gate is name/event-based and wrapper-agnostic, as the design spec pinned.

### Step 5 — Build wiring + docs

14. `scripts/bootstrap.sh` / `after-pull.sh` build `custom-tools/piread` → `bin/piread`.
    README + `doc:check` updated.

### Step 6 — Micro-bench harness (`f018bca`)

15. `tests/piread-bench.mjs` (no model): 7 deterministic corpus classes × N=200 per arm
    (oracle vs piread dispatch), portable p50/p95, a bare `--version` spawn loop (the
    dispatch floor), best-effort peak RSS via `/usr/bin/time` child probes, self-asserts
    finite medians + a non-empty report. Writes `benchmark/runs/piread-microbench-*.md`.
16. **First local run exposed risk R1**: piread p50 **4.1–6.8 ms** vs oracle
    **0.4–0.9 ms**; spawn floor p50 **4.9 ms** — the per-call process spawn dominated,
    so piread was *slower than the built-in on every class*. The design spec had
    anticipated exactly this ("spawn overhead may erase pipeline wins on small files").

### Step 6b — Persistent daemon (the fix) (`eedeb8a`)

17. Added `piread --serve`: newline-delimited JSON over stdio, one request/response per
    line, id-matched, requests carry the caller cwd; per-line error envelopes
    (`usage`/`protocol` kinds); clean exit on stdin EOF. Envelopes byte-identical to
    one-shot mode plus a leading echoed `id` (skip-serialized in one-shot output).
    `v0.1.0 → v0.2.0`.
18. Extension became a **daemon → one-shot spawn → built-in** ladder with exactly one
    fallback stderr line per call (terminal reason only). Daemon `unref`'d while idle,
    `ref`'d while a response is in flight, lazy restart on death, killed on process
    exit. Streams resolve per-request cwd. `PI_NATIVE_READ` gate unchanged.
19. Parity suite 147 → 150 (id matching under concurrency, lazy restart, abort
    semantics); sabotage tests reset the daemon for cold-start runs. Cargo gained 11
    `--serve` integration tests (including daemon == one-shot envelope equality).
20. Bench became 3 arms (oracle / daemon / one-shot) + spawn floor + daemon `VmHWM`
    probe. Measured p50: daemon **0.077–1.10 ms** vs built-in **0.338–1.44 ms** — faster
    on 6/7 classes (2–6.6×); only the 60 KB single-blob read regressed (+0.28 ms, the
    JSON round-trip). One-shot arm preserved the pre-daemon baseline (4.7–6.1 ms).
    Daemon RSS 2 MB.

### Step 6c — Hot-path optimization (`7b2b3b5`)

21. Measured before/after with the bench (N=200/arm, two confirmation runs; report
    `piread-microbench-2026-10-15-daemon-opt.md`):
    - `HeadTruncator`: build the buffered prefix in one presized `String` instead of
      `Vec<String>` + `join("\n")` twice; removes N per-line allocations and 2
      full-content copies per read.
    - `serve`: serialize responses into one `Vec<u8>` reused across requests, newline
      appended in-buffer, single `write_all` — no per-response `String`.
    - `envelope`: hand-rolled writers for the two large string fields with a SWAR
      clean-word escape scan and a serde-identical dense fallback. serde's per-byte scan
      ran ~0.8 GB/s and is paid **twice** per truncated response (`content` +
      parity-pinned `truncation.content`). Byte-exact with serde_json, pinned by an
      exhaustive single-byte/randomized test plus an oracle test against the serde
      derives.
22. Bench: the 60 KB regression closed (+0.28 → −0.004/+0.074 ms); `lines2500` daemon
    p50 0.84 → 0.505 ms; all other classes unchanged, daemon-favored ≥ 3×. `cargo test`
    54 (+2), clippy clean, parity 150/150, gate 241/241.

### Step 7 — Default-on flip (`66aa37f`)

23. User directive flipped D5 ahead of the S2 pair run: the load guard registers unless
    `PI_NATIVE_READ=0` (explicit opt-out), a dated deviation from the spec's default-off
    D5, recorded in the design doc §5.2. Ladder/envelope/parity/daemon behaviour
    unchanged — with the binary missing the ladder still fails open (one stderr line).

### Step 8 — Registration redesign (`62b9cd1`)

24. piread originally **shadowed** `read` under the same name. This made both tools
    render as one TUI label and collided with any other read registration. Redesigned to
    **individual registration**: a distinct tool named `piread` (label `piread`) with a
    schema byte-equal to `createReadToolDefinition`; permission-gate treats `piread` as
    read-kind so coverage / R1 / Anchor Guard protection is retained. This is the
    pattern `piedit` (S8) later copied.

### Step 9 — Context compaction (`PI_READ_COMPRESS`, on by default)

25. Latency work made reads *fast* but did nothing about their *footprint*: a
    2000-line read still shipped ~9 KB of raw text into the model context, because
    the built-in contract is a plain head truncation — the tail (summary, final
    state) was never seen and the head was emitted in full. `pibash` already solved
    this with `compress.rs`; `piread` gained the read-sized subset.

26. `src/compress.rs` implements a deterministic head-tail compaction to the same
    40 lines / 2 KB budget the permission-gate H1 cap enforces, so H1 passes the
    result through instead of re-cutting it. 2/3 head : 1/3 tail (a read is paged
    top-down, so the head is the request and the tail confirms it), the same
    `[... omitted N chars / M lines ...]` marker as `pibash`, idempotent (a body
    already carrying the marker is never re-compacted), and UTF-8 safe.

27. Two bugs this caught during development, both regression-tested:
    - a single over-budget line produced head **and** tail slices that together
      exceeded the byte budget → head-only for that case;
    - the `[Showing lines A-B of C …]` continuation notice was sliced as body
      content and then re-appended, landing **twice**. It is now split off before
      slicing and re-attached exactly once, last — it is the only place the reader
      learns the file continues.

28. `read_text` stays a pure, byte-exact pipeline; `read_text_compacted` (used by the
    CLI and `--serve`) applies the pass. That split keeps the parity suite
    deterministic and avoids races on a process-global env var (Rust tests run in
    parallel). `PI_READ_COMPRESS=0|false|off` restores exact parity — which the
    parity suite and `piedit`'s exact-match binding both depend on.

29. Every cut is also published structurally (2026-10-27, C3): the envelope's
    `details.compaction.omissions[]` carries `{startLine, endLine, chars, lines}`
    in absolute 1-based file lines, counts byte-matched to the marker
    (`compress.rs` derives both from the same rendered-lines + marker-count
    arithmetic). The permission gate consumes it as its coverage map for
    gap-aware certification, with the marker regex as fallback; model-visible
    content is unchanged.

29. Compaction never touches `details.truncation`, so permission-gate still derives
    read coverage from metadata (`countTextLines` is only the fallback) and windows
    are not under-certified.

Measured (`npm run bench:model-visible`, `content[].text` bytes):

| case | built-in `read` | `piread` | Δ |
| --- | ---: | ---: | ---: |
| ~100 lines | 4,435 | 1,898 | −57.2% |
| ~300 lines | 12,343 | 1,675 | −86.4% |
| ~1000 lines | 41,275 | 1,945 | −95.3% |
| ~1922 lines | 51,188 | 2,040 | −96.0% |
## Contract

CLI: `piread --path <P> [--offset <N>] [--limit <N>]`; `--serve` for the NDJSON daemon.
Exit 0 ok · 2 usage · 3 I/O error (JSON on stdout).

```jsonc
// success
{ "ok": true, "content": "…", "truncation": { … } | null, "binary": false, "totalBytes": 1234 }
// failure
{ "ok": false, "error": { "kind": "ENOENT|EACCES|EISDIR|io|offset", "message": "…" } }
```

Daemon request adds `id` (echoed) and `cwd` (relative-path resolution).

## Dead ends and corrections (summary)

- **Spawn floor erased every win** (Step 6) → persistent daemon (Step 6b); the design
  spec's R1 anticipated this, so it was not a surprise.
- **60 KB single-blob regression** (JSON round-trip cost) → closed in Step 6c by the
  hand-rolled envelope writer + `HeadTruncator` presizing; residual is Node's
  `JSON.parse` of the ~103 KB envelope and std UTF-8 validation, both structural under
  parity.
- **Shadow registration** caused label collision / observability loss → individual
  registration redesign (`62b9cd1`).

## Notes

- Rust 2024; release profile matches the other crates (opt-level 3, lto fat,
  codegen-units 1, panic abort, strip).
- `Cargo.lock` stays untracked (repo-wide gitignore).
- `--serve` is the production path; the one-shot rung is the protocol fallback, and the
  built-in `read` is the final fail-open rung.
