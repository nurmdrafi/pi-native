# Rust Tools Architecture

Four native Rust tools replace the pi built-in TypeScript tools. Each is a
standalone binary in `rust-tools/` with a matching extension in
`extensions/`. Every tool follows the same shape:

- **Extension** (`extensions/<name>/index.ts`) — individual registration, a
  **fail-open ladder** (`daemon → one-shot spawn → built-in`), and the
  session-sensitive glue (env + `PI_*` injection, cancellation, TUI render).
- **Daemon** (`--serve`) — a persistent NDJSON-over-stdio process so the hot
  path avoids per-call spawn cost. One request per line, id-matched, lazy
  restart on death, `unref`'d while idle / `ref`'d in flight.
- **One-shot** — a single `bin/<name>` spawn per call, the fallback when the
  daemon transport fails.
- **Built-in fallback** — the original TypeScript tool, the final rung.

Parity is pinned against the built-in by a harness suite (`tests/*-parity.test.mjs`)
and the permission-gate treats each native tool as a wrapper on the equivalent
event (`read`/`edit`/`bash`).

**Companion docs:** [`native-tools.md`](native-tools.md) (measured speedups,
context-shaping tables, tool version pins), [`portability.md`](portability.md)
(OS constraints), [`rust-tools-optimization.md`](rust-tools-optimization.md) (the
safe path for changing one of these tools). Per-crate build logs live in
`rust-tools/*/README.md`.

---

## Contents

- [Crate layout and dependencies](#crate-layout-and-dependencies)
- [Optimization workflow](rust-tools-optimization.md)
- [Generic dispatch ladder](#generic-dispatch-ladder)
- [Daemon protocol and lifecycle](#daemon-protocol-and-lifecycle)
- [Process-group isolation](#process-group-isolation)
- [Context shaping (compression)](#context-shaping-compression)
- [Envelope serialization](#envelope-serialization)
- [pibash — native shell-output pipeline](#pibash--native-shell-output-pipeline)
- [piread — native read pipeline](#piread--native-read-pipeline)
- [piedit — native edit pipeline](#piedit--native-edit-pipeline)
- [pidx — incremental session-log indexer](#pidx--incremental-session-log-indexer)
- [docheck — doc-consistency validator](#docheck--doc-consistency-validator)
- [Shared techniques](#shared-techniques)
- [Glossary](#glossary)

---

## Crate layout and dependencies

A Cargo workspace (`rust-tools/Cargo.toml`, resolver 2) holds five binary
crates sharing one `Cargo.lock` and one `target/`:

| Crate | Binary | Dependency surface |
| --- | --- | --- |
| `piread` | `bin/piread` | `serde`, `serde_json` (`preserve_order`), `memchr` |
| `piedit` | `bin/piedit` | + `unicode-normalization` (NFKC); `tempfile` (dev) |
| `pibash` | `bin/pibash` | `serde`, `serde_json` (`preserve_order`); `tempfile` (dev) |
| `pidx` | `bin/pidx` | + `sha1`; `preserve_order`, `float_roundtrip` |
| `docheck` | `bin/docheck` | none — std only (all four families of the former `scripts/doc-check.mjs`, deleted after byte-parity; see `docs/plans/permission_gate_implementation_plan.md` §13) |

Deliberately kept small: no `tokio`, no `clap`, no `regex`, no `libc`. Threads
are `std::thread`; argument parsing is hand-written; `setsid`/`setpgid` are
declared as raw `extern "C"` rather than pulling in the `libc` crate.

Workspace release profile:

```toml
[profile.release]
opt-level = 3
lto = "fat"          # cross-crate inlining; the crates are small enough to afford it
codegen-units = 1    # better optimization at the cost of compile parallelism
panic = "abort"      # no unwinding machinery; these are short-lived processes
strip = true         # binary size only
```

`serde_json`'s `preserve_order` feature (backed by an index map) is enabled
everywhere because envelopes are compared **byte-for-byte** against the
TypeScript oracle — field order must be stable and match the JS object literal
order, not alphabetical.

---

## Generic dispatch ladder

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/tool-dispatch-ladder-dark.png" />
    <img src="assets/diagrams/tool-dispatch-ladder-light.png" alt="tool dispatch ladder" width="960" />
  </picture>
</p>

Interactive version: [tool dispatch ladder](assets/diagrams/tool-dispatch-ladder.html) (source: [JSON](assets/diagrams/tool-dispatch-ladder.workflow.json))

The ladder is **fail-open**: every rung's failure advances to the next, and the
terminal rung is always the original TypeScript implementation. A missing
binary, a crashed daemon, or unparseable stdout degrades performance, never
correctness. Each terminal fallback writes exactly one stderr line
(`<tool>: fallback (<reason>) path=<path>`) — one line per event, not per
rung (the violation-memory NDJSON store that also logged these was removed
in `177f3d4`; stderr is now the only fallback signal).
Binaries are installed through `scripts/lib/install-native.sh`, which re-signs
them: a bare `cp` invalidates the adhoc signature and the kernel SIGKILLs the
copy, which is indistinguishable from a missing binary and shows up as
fallback churn on stderr. Rung selection is recorded on `details.via` (`daemon` | `oneshot` | `builtin`),
which never enters model-visible content.

### Rung 0 — registration and entry conditions

All three tool extensions register a **distinct tool name** (`pibash`,
`piread`, `piedit`) alongside the built-in rather than shadowing it. The
parameter schema is copied verbatim from `createBashToolDefinition` /
`createReadToolDefinition` / `createEditToolDefinition` so input normalization
and sampling behave identically; only name/label/description/promptGuidelines/
execute/renderCall are native. Load guards default every tool on:
`PI_NATIVE_BASH=0` / `PI_NATIVE_READ=0` / `PI_NATIVE_EDIT=0` /
`PI_NATIVE_PIDX=0` opts out (`PI_BASH_BIN` / `PI_READ_BIN` / `PI_PIDX_BIN`
override the binary path for parity tests).

`announceNativeTool` (in each `extensions/<tool>/index.ts`) registers the tool
name with the subagents extension's registry
(`globalThis.__pi_interactive_subagents`), so an agent definition listing the
native name gets `-e <extension-path>` on its sandboxed spawn. Built-in names
resolve to no extension — an agent listing only `read`/`bash`/`edit` runs the
built-in implementations. A `__resetDaemonForTest` export kills the daemon so
suites can exercise the cold paths (missing binary, one-shot rung)
mid-process.

Entry conditions decided **before** the ladder runs:

| Tool | Pre-ladder routing |
| --- | --- |
| `pibash` | empty command → built-in directly; a bad `timeout` is validated first and thrown once — it must not fall open and spawn twice |
| `piread` | image extension on `path` → built-in `read` (the model needs the image bytes); non-integer / pathological `offset`/`limit` → built-in |
| `piedit` | the whole ladder runs inside `withFileMutationQueue(absPath)`; a fallback returns a `{fallback}` sentinel and the built-in runs **after** the queue releases — re-entering the same queue deadlocks |
| `pidx` | **no ladder** — one-shot `execFile` per call (indexing is infrequent; a daemon would never amortize); failures throw to the model |

### Request framing per tool

One JSON line per request; `id` is echoed verbatim (any JSON value), and the
client keeps a `nextId` counter plus a `pending` map keyed by id:

- `pibash`: `{id, command, cwd, timeout, env, stream}` — `env` is the **full
  child environment rebuilt per call** (see below); `stream: true` is set when
  an `AbortSignal` or `onUpdate` is present, enabling partial-output events.
- `piread`: `{id, path, offset, limit, line_cap, cwd}` — `line_cap` caps one
  line's chars; absent = no cap (byte parity with the built-in).
- `piedit`: `{id, path, edits, renderDiff}` — `renderDiff: true` asks the
  daemon to return the rendered `{diff, patch, firstChangedLine}` instead of
  the content pair.

Responses to unknown ids (late answers to aborted calls) are dropped
silently. An unparseable response line kills the daemon: every pending call
is rejected with `DaemonUnavailableError` and transparently retries on the
one-shot rung.

### Failure taxonomy

| Failure | Class | Effect |
| --- | --- | --- |
| daemon spawn error / `exit` / stdin closed / unparseable response line / write failure | `DaemonUnavailableError` | advance to the one-shot rung |
| one-shot spawn error, empty output, unparseable JSON | terminal | built-in rung + the one stderr fallback line |
| envelope `error.kind` = `spawn` or `timeout` (`pibash`) | parity rethrow | rethrown in the built-in's thrown-error shape — a missing cwd or a timeout is a caller-visible error and must not fall open to a second spawn |
| envelope `error.kind` = anything else (missing file, EISDIR, …) | tool-level | built-in rung produces the byte-identical error |
| `binary: true` (`piread`) | tool-level | built-in `read` |
| caller abort | parity rethrow | the built-in's bare "Command aborted" / "Operation aborted" |
| malformed envelope (`piedit`) | terminal | `{fallback: "malformed envelope"}` |

### Environment injection (`pibash`)

The daemon is long-lived but the environment is per-call: `buildEnv(ctx)`
rebuilds it for every request — copy `process.env`, drop the session-context
keys, set `PI_SESSION_ID` / `PI_SESSION_FILE` (from `ctx.sessionManager`),
`PI_PROVIDER` / `PI_MODEL` (from `ctx.model`), `PI_REASONING_LEVEL`, prepend
the agent `bin/` dir to `PATH` (case-insensitive `path` key), and default
`BASH_ENV` to the repo's `scripts/env.sh` when unset so an `nvm`-pinned node
resolves without per-command bootstrap. Sending env per request is what lets
one daemon serve a whole session without ever holding a stale environment.

### Live output and cancellation (`pibash`)

With `stream: true` the daemon emits `started` (the child pid) and throttled
partial snapshots (`UPDATE_THROTTLE`, 100 ms). A partial's
`truncation.content` is emptied on the wire — it is always a prefix of the
display text — and the extension restores it client-side (split at the first
`\n\n[`) so the rebuilt `details.truncation` stays byte-identical to the
built-in's. On abort the extension `SIGKILL`s the child's whole process group
(`process.kill(-pid)` — the runner spawns the child in its own group); a
response arriving after the abort still triggers the kill and settles as the
parity "Command aborted" error.

---

## Daemon protocol and lifecycle

All three daemons speak the same protocol: **newline-delimited JSON over stdio**.

Request (one line):

```jsonc
{ "id": 7, "path": "/abs/file", "offset": 5, "limit": 20, "cwd": "/abs/dir" }
```

Response (one line per request):

```jsonc
{ "id": 7, "ok": true, "content": "…", "truncation": null, "binary": false, "totalBytes": 12 }
{ "id": 7, "ok": false, "error": { "kind": "ENOENT", "message": "…" } }
```

`id` is echoed verbatim (any JSON value), so the client matches responses
without ordering assumptions. Requests are processed **serially in arrival
order** — the daemons are single-threaded over stdin, which removes a whole
class of ordering bugs at no measurable cost (indexing and file reads are not
the bottleneck; process spawn was).

### Rust side

`serve()` loops `stdin.lock().lines()`, which is streaming (not
block-buffered): a response is emitted as soon as a request line arrives, so
the client never waits for EOF. Malformed JSON still produces an error envelope
with the id echoed when it is recoverable; an unreadable stdin or an unwritable
stdout ends the loop (parent gone). Exit code is always 0 — per-request
failures are envelope errors, not process failures.

### Client side (the part that is easy to get wrong)

Node's child-process handles are refcounted against the event loop. The daemon
must not pin the host while idle, but a request in flight must keep the loop
alive or the await never settles. The rule enforced in the extensions:

| State | `proc` | `stdin` | `stdout` |
| --- | --- | --- | --- |
| idle | unref | unref | unref |
| request in flight | **ref** | ref | ref |

`refWhilePending()` refs all three; `maybeUnrefStreams()` must unref **all
three** when `pending` empties. Two real bugs came from getting this wrong:

- Ref'ing only `stdin`/`stdout` (not `proc`) let the loop drain mid-await → the
  host exits with an *unsettled top-level await* (exit 13).
- Unref'ing only `stdin`/`stdout` (not `proc`) after a settle left the process
  handle referenced → the host never exits at all.

Both are covered by `tests/integration/daemon-exit.test.mjs` and
`tests/integration/piread-daemon-settle.test.mjs`.

Other lifecycle rules:

- **Lazy start**: the daemon is spawned on first use, not at extension load.
- **Lazy restart**: a dead slot is cleared (`daemon = null`) and the next call
  starts a fresh one. `killDaemon` is idempotent (`state.dying`).
- **Stale-daemon invalidation**: daemons also die when their binary changed
  under them — `scripts/after-pull.sh` (step 5c) kills them after a rebuild,
  and self-heal kills them at `session_start` when the `bin/` generation
  (max mtime, `.cache/bins-generation`) differs from the last session
  (extensions/self-heal/bins.ts). One-shot fallback covers the gap. Manual
  equivalent: `npm run daemons:kill`.
- **Dying slots are refused**: a request entering a slot whose `dying` flag is
  set, or whose stdin is destroyed/ended, rejects immediately rather than
  writing into a pipe that will never answer.
- **Write-failure settles**: a write error is the *only* remaining failure
  signal once a pipe is destroyed, so the callback rejects unconditionally
  rather than gating on the pending entry still being present.
- **Process exit hook**: one `process.on("exit")` kills the live daemon.

---

## Process-group isolation

Every `--serve` daemon calls `setpgid(0, 0)` at startup
(`rust-tools/*/src/procgroup.rs`), putting it in a process group of its own.

Without this the daemon inherits the client's process group, and any group-wide
signal reaches it — `pibash`'s own `kill_tree` signals `-<pid>` on a command
timeout, and job-control or CI timeouts do the same. A daemon killed that way
drops in-flight requests and forces a reconnect.

**Why `setpgid` and not `setsid`:**

- `setsid()` fails with `EPERM` when the caller is already a process-group
  leader — which is exactly how Electron/Node spawn children. Working around it
  needs a fork-first dance, which a daemon that must report its own pid cannot
  do simply.
- `setsid()` also starts a new *session* and drops the controlling terminal;
  a stdio daemon does not use the terminal, so that is more disruption than the
  isolation requires.
- `setpgid(0, 0)` on self is always legal, and is the same call Rust's
  `CommandExt::process_group(0)` makes for child processes (the pattern
  `runner.rs` already uses for pibash's shell children).

`setpgid` is POSIX.1 — present in glibc, musl, and Apple libSystem — and is
declared as a raw `extern "C"` symbol, so no `libc` dependency is added. On
non-unix the call compiles to a no-op. Verified by
`tests/integration/daemon-process-group.test.mjs`.

---

## Context shaping (compression)

The permission-gate **H1 cap** limits what reaches the model to **40 lines /
2 KB**. Two tools shape their output to that same budget so the gate passes the
result through instead of re-cutting it. Compaction is what stops context cost
from scaling with file or command output size. Measured per-tool savings
(native vs built-in bytes entering the transcript) live in
[`native-tools.md`](native-tools.md#context-shaping-what-enters-the-model).

| Tool | Strategy | Notes |
| --- | --- | --- |
| `pibash` | head-tail / error-priority | command-aware; failures keep a 2/3 tail, successes a 2/3 head |
| `piread` | head-tail | 2/3 head : 1/3 tail; continuation notice kept last |
| `piedit` | none | returns a status line + diff — bounded by design |
| `pidx` | pointer only | extracts go to a file; only a pointer line enters context |

Shared rules:

- **Deterministic.** No clock, no run id, no hash iteration order. Same input →
  byte-identical output, so results are cacheable and diffable.
- **Idempotent.** A body already carrying the omission marker is never
  re-compacted (re-compaction would drop kept content and rewrite the count).
- **Explicit omission.** Every cut emits `[... omitted N chars / M lines ...]`
  with real counts — the same marker string in both tools, so one grep
  recognizes a compacted result from either. The same cut also rides the
  piread envelope as `details.compaction.omissions[]`
  (`{startLine, endLine, chars, lines}`, absolute file lines) so the
  permission gate certifies the gap without parsing model-visible text.
- **UTF-8 safe.** Every cut lands on a character boundary.
- **Lossless elsewhere.** Full output is spilled to a temp file (`pibash`), or
  re-readable with a wider window (`piread`); `truncation` metadata is never
  rewritten, so the gate still sees true line counts.
- **Reversible.** `PI_READ_COMPRESS=0|false|off` disables `piread` compaction,
  restoring byte parity with the built-in `read`.

Measured effect (model-visible bytes, `npm run bench:model-visible`): a
~1900-line read drops from 51,188 B to 2,040 B; a 10k-line shell output from
10,129 B to 173 B. Totals across the suite: 273,312 B → 15,569 B (−94.3%).

`pibash`'s pipeline applies four stages in order — `strip_ansi`, `dedup_repeats`,
then a strategy (`error_priority` for Test/Build commands, `head_tail`
otherwise), each skipped when the text already fits the budget. The stages are
copy-on-write over one shared line split: piped output is ANSI-free and
fold-free in the common case, so the stream is neither copied nor re-split per
pass (`strip_ansi_cow` borrows when no ESC byte exists; `dedup_lines` borrows
when nothing folds; `error_priority_lines` / `head_tail_lines` take the
pre-split `&[&str]`). The fold case rebuilds the text and re-splits through the
public wrappers — the rare path.

---

## Envelope serialization

Envelopes are compared byte-for-byte against the TypeScript oracle, so the
writers are hand-rolled rather than derived:

- **Fast string escaping.** A SWAR (SIMD-within-a-register) word scan tests 8
  bytes at a time for chars needing escape (`< 0x20`, `"`, `\`); clean spans
  are copied wholesale. After four consecutive dirty words it switches to
  byte-wise scanning, because escape-dense text makes the word tests cost more
  than they save. ~2.5× faster than `serde_json`'s writer with no regression on
  escape-heavy input, and pinned by a test that compares output against
  `serde_json` exhaustively over all single bytes and combinations.
- **Duplicate suppression.** `Truncation.content` is skipped when empty
  (`skip_serializing_if`): the full text already rides in `content[0].text`,
  so the extension reconstructs it. Halves the envelope for large truncated
  output without changing the rebuilt result.
- **Buffer reuse.** The daemon keeps one response `Vec<u8>` whose capacity
  ratchets to the largest response seen; each response is serialized in place,
  a newline appended, and emitted with a single `write_all` + `flush`.

---

## pibash — native shell-output pipeline

Owns spawn + streaming + capping + truncation + spill + envelope. The built-in
bash tool (`dist/core/tools/bash.js`) stays the *oracle*; the extension owns env
injection and TUI rendering.

### Module map

| Module | Responsibility |
| --- | --- |
| `cli.rs` | hand-written arg parse → serve / one-shot `Request` modes |
| `main.rs` | entry; `execute` / `execute_observed` orchestrate run → accumulate → compress → render → envelope |
| `runner.rs` | shell resolution, detached spawn in own process group, pipe readers, reap thread, timeout kill tree |
| `accumulator.rs` | `Utf8Stream` decoder, bounded tail window, spill file, snapshots |
| `truncate.rs` | JS-parity byte/line primitives (`js_byte_length`, `split_lines`, `truncate_tail`) |
| `compress.rs` | command classification + copy-on-write compaction tiers |
| `render.rs` | display text + `structuredContent` shaping (`structured_limit`, `format_size`) |
| `envelope.rs` | `Success` / `Failure` envelope structs |
| `serve.rs` | daemon loop, per-id dispatch, `StreamObserver` |
| `procgroup.rs` | `setpgid(0,0)` self-isolation for `--serve` |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/pibash-pipeline-dark.png" />
    <img src="assets/diagrams/pibash-pipeline-light.png" alt="pibash pipeline" width="960" />
  </picture>
</p>

Interactive version: [pibash pipeline](assets/diagrams/pibash-pipeline.html) (source: [JSON](assets/diagrams/pibash-pipeline.workflow.json))

### Execution

`runner.rs` spawns the shell via `std::process::Command` and reads both pipes
concurrently on separate threads (`drain_readers`), because a single-threaded
read deadlocks as soon as a child fills the pipe it is not being read from.

- **Shell resolution** (`resolve_shell`): `PI_BASH_SHELL` override → `/bin/bash`
  → `bash` on `PATH` → `sh`. It deliberately ignores `$SHELL`: a zsh login shell
  must not change which shell tool commands run under, matching the built-in.
- **Process group of the child**: `process_group(0)` (unix) so a timeout can
  signal the whole tree.
- **Timeout kill** (`signal_group`): `kill -<SIG> -<pid>` to hit the group, with
  a fallback to the bare pid. This is precisely the call that could previously
  reach the daemon itself — hence [process-group isolation](#process-group-isolation).
- **Reader grace period** (`READER_GRACE`, 30 ms): after the child exits,
  readers get a short window to drain buffered output so the tail is not lost.
- **`RunObserver`**: the daemon implements it to stream `started` (child pid, for
  cancellation) and throttled `partial` updates (`UPDATE_THROTTLE`, 100 ms,
  matching the built-in).
- **Concurrency model**: two reader threads (stdout, stderr) forward raw
  chunks over one `mpsc` channel in arrival order; a dedicated thread blocks
  in `wait()` and posts the exit status — this replaced a 2 ms `try_wait`
  poll that added dead time to sub-millisecond commands.
- **Cwd pre-check**: a missing working directory returns a `spawn_error`
  outcome without spawning, which the extension rethrows as the built-in's
  thrown error.
- **Teardown escalation**: on the deadline, `kill_tree` TERM-s the group plus
  individually-signalled escapees, waits up to 2 s for the reap, then
  `kill_tree_hard` repeats with KILL.
- **Escapee scan**: descendants that left the shell's process group
  (`setsid`/`setpgid` children) are found by one `/proc` pass (ppid + pgrp
  per pid; `comm` parsed after the last `)` because it may contain spaces and
  parentheses) **before** the group signal — once the shell dies they reparent
  to init and become unreachable by parent walk.

### Accumulation and spill

`OutputAccumulator` keeps the last 2000 lines / 50 KB in memory and spills the
full stream to a temp file (`pi-bash-<seed>.log`, private permissions) once it
grows past the cap:

- **`Utf8Stream`**: incremental UTF-8 decoding. Chunk boundaries fall inside
  multi-byte sequences, so it holds back incomplete trailing bytes and decodes
  only complete sequences — output is never mangled at a boundary.
- **`trim_tail`**: keeps the buffer bounded on two axes — a rolling byte
  window (`trim_tail_bytes`, cut on a UTF-8 boundary) and a line ring
  (`trim_tail_lines`, byte offsets of the last complete lines), so repeated
  `snapshot()` calls re-split only the display window, never the whole tail.
- **`into_full_text` / `cap_full_output`**: give the compression pre-pass the
  *complete* stream in a single materialization (moving the raw buffer
  zero-copy when no spill exists, one spill-file read otherwise), and derive
  the ≤1 MiB `structuredContent` payload from that same buffer instead of
  re-reading — errors buried mid-stream survive, and the stream is never
  serialized twice.
- **`snapshot`**: produces the oracle-shaped result plus an optional
  `fullOutputPath` reference.

### Large-output fixtures (Step 8)

`rust-tools/pibash/bench-large-output.mjs` pins this pipeline at
1/10/100 MB — three shapes per size (uniform lines, one giant line, stderr
mix) plus `yes | head -c` throughput, non-zero exit after 100 MB, and
SIGTERM death mid-stream. The daemon arm measures the model-visible
envelope, `child_bytes` (`truncation.totalBytes`), and `spill_bytes` (stat
of `fullOutputPath`); the oneshot arm measures peak RSS under
`/usr/bin/time` (`ru_maxrss`: KiB on Linux, bytes on macOS, normalized by
one helper). Assertions pin current behavior, not goals: `child_bytes`
byte-exact, `spill_bytes == child_bytes`, envelope ≤ 8192 B flat as output
grows — compression-classified streams render ≈2 KB, unclassified ones
(`yes | head -c`) fall to the parity-locked 2000-line tail window (4111 B
measured) — and per-class RSS caps record the accumulator's by-design
scaling until spill (100 MB class measured 1003 MB peak). Reports land in
`benchmark/runs/`; the 1 MB class also runs in the Node suite
(`tests/integration/pibash-large-output.test.mjs`). Wall time is recorded, never
asserted.

### Compression

A **shadow pre-pass** runs over the complete output before the legacy
tail/parity path, so the model-visible budget (40 lines / 2 KB) is enforced on
the whole stream. Stages: `strip_ansi_cow` → `dedup_lines` (both copy-on-write,
borrowing the stream untouched when no ESC byte / fold exists) → strategy over
one shared line split. The fold case rebuilds the text and re-splits — the rare
path.

`classify()` maps the command string to `Test | Build | Git | Search | Log |
Generic` by scanning shell-separated segments left to right and taking the first
recognized leading token (`rg foo && cargo test` → `Test`). `sudo` and
`VAR=value` prefixes are skipped.

`error_priority` (Test/Build) keeps actionable lines — errors, warnings,
failures, panics, assertions, stack frames, file/line refs, final summary —
and fills remaining budget with surrounding context. `head_tail` splits 2/3 : 1/3,
head-heavy on success and tail-heavy on failure, because a failure's summary
sits at the end. A single line larger than the whole budget is cut head+tail on
a UTF-8 boundary.

Constraint: a **generic** command's buried actionables are not scanned — it is
recorded as expected-non-retaining, matching the built-in oracle's behaviour.

Measured, one-shot CLI (`rust-tools/pibash/bench-seq50000.mjs`; `seq 50000`
≈ 290 KB / 50k lines; stage attribution via temporary in-process timers since
removed):

| stage | before | after |
| --- | --- | --- |
| `strip_ansi` | 394 µs | 27 µs (borrowed: no ESC byte) |
| `dedup` | 2.06 ms | 1.64 ms (shared split, borrow) |
| `head_tail` | 1.93 ms | 0.72 ms (shared split) |
| `compress_output` total | 9.6 ms | 2.5 ms |
| full-stream materializations | 2 | 1 |
| end-to-end p50 | 19.7 ms | 13.4 ms (−32%) |

The "before" column carries the three-pass `split_lines` and the per-line
`String` malloc in `dedup_repeats` that motivated the copy-on-write rework;
`strip_ansi`'s before/after is the borrowed-vs-owned difference. Wire bytes are
unchanged throughout — parity suites pin the envelope shape.

---

## piread — native read pipeline

One invocation runs open → slice → render → truncate → binary-detect, printing
a single JSON envelope.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/piread-pipeline-dark.png" />
    <img src="assets/diagrams/piread-pipeline-light.png" alt="piread pipeline" width="960" />
  </picture>
</p>

Interactive version: [piread pipeline](assets/diagrams/piread-pipeline.html) (source: [JSON](assets/diagrams/piread-pipeline.workflow.json))

### Module map

| Module | Responsibility |
| --- | --- |
| `cli.rs` | arg parse into run/serve modes; count validation (`parse_count`) |
| `main.rs` | entry; `ToolError` kinds carrying Node-parity messages |
| `pipeline.rs` | `Segmenter` (with binary sniff), `HeadTruncator`, slicing, render, path resolve/normalize |
| `compress.rs` | head-tail compaction (`COMPRESS_MAX_LINES` 40 / `COMPRESS_MAX_BYTES` 2048) + the `PI_READ_COMPRESS` switch |
| `envelope.rs` | hand-rolled JSON writers incl. `write_success_with_id` |
| `serve.rs` | daemon loop; always exits 0 |
| `procgroup.rs` | same `setpgid` self-isolation as `pibash` |

### Streaming parser

`Segmenter` wraps `BufReader::with_capacity(64 KiB)` and reads with
`read_until(b'\n')` into a reused buffer — one allocation per file, not per
line. It tracks `last_ended_newline` (initialised `true`) so an empty file
yields the single `[""]` segment the JS `split("\n")` semantics require, and
reports the trailing phantom segment exactly as the oracle does.

**Memory contract:** buffers at most `MAX_BYTES` (50 KB) of decoded output plus
the first line (needed for `firstLineExceedsLimit`). The rest of the file is
scanned — newline count and binary sniff — without buffering, so a 1 GiB read
costs O(cap). A NUL byte in the first 8 KiB marks the file binary and defers to
the built-in pipeline.

Byte accounting mirrors JS `Buffer.byteLength` on *decoded* text, and line
counting mirrors `splitLinesForCounting`, including the quirk that content
ending in a newline counts N lines rather than N+1.

### Compaction

`read_text` is a **pure, byte-exact** pipeline (the built-in's contract);
`read_text_compacted` — used by the CLI and `--serve` — applies the head-tail
pass. That split keeps the parity suite deterministic and avoids races on a
process-global env var (Rust tests run in parallel).

Two details that matter:

- The `[Showing lines A-B of C …]` continuation notice is **split off before
  slicing** and re-attached exactly once, last. It is the only place the reader
  learns the file continues; slicing it as body content made it appear twice.
- A single over-budget line is served by the head alone — a head+tail slice of
  one line is useless to a reader and could exceed the byte budget.

`details.truncation` is never rewritten, so permission-gate still derives read
coverage from metadata (`countTextLines` is only the fallback) and windows are
not under-certified.

### Serve and envelope

- The daemon answers each request into a reused buffer and flushes per
  response; a stdout write failure means the parent is gone and ends the
  loop. Exit code is always 0 — tool-level failures are `error` envelopes.
- The `Segmenter` sniffs an initial window for NUL bytes; a hit flags the
  file `binary` and the extension routes the call to the built-in `read`
  (the image pipeline needs the model context).
- `read_text_compacted` converts `compact()`'s window-relative cut lines to
  **absolute file lines** (`window_start = offset − 1`) before attaching
  `details.compaction.omissions` — only that call site knows where the
  requested window began.
- `open_error` reproduces Node's `fsPromises.access` messages byte for byte
  (ENOENT / EACCES / …) so failure shapes match the built-in without a
  round-trip.

---

## piedit — native edit pipeline

read → LF/BOM normalize → exact/fuzzy match → uniqueness/overlap validation →
apply → write → native diff/patch render.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/piedit-pipeline-dark.png" />
    <img src="assets/diagrams/piedit-pipeline-light.png" alt="piedit pipeline" width="960" />
  </picture>
</p>

Interactive version: [piedit pipeline](assets/diagrams/piedit-pipeline.html) (source: [JSON](assets/diagrams/piedit-pipeline.workflow.json))

### Module map

| Module | Responsibility |
| --- | --- |
| `cli.rs` | arg parse into run/serve modes |
| `main.rs` | entry, request read, `ToolError` |
| `pipeline.rs` | LF/BOM normalize, fuzzy view, match/validate/apply, write |
| `diff.rs` | jsdiff port: line diff, unified patch, render details |
| `envelope.rs` | `Request`/`Edit` shapes, `ErrorKind`, envelope writers |
| `serve.rs` | daemon loop |
| `procgroup.rs` | self-isolation |

### Why the queue matters

The native dispatch runs under `withFileMutationQueue`; if it returns a
`{fallback}` sentinel the queue is released **first**, then the built-in
executor runs — otherwise re-entering the same queue deadlocks.

### Matching pipeline

1. **Normalize** — `split_bom` separates a UTF-8 BOM; `detect_line_ending`
   records `\r\n` vs `\n`; `normalize_to_lf` gives one consistent view.
   `restore_line_endings` re-applies the original ending on write, so edit
   round-trips are byte-stable.
2. **Exact-first, fuzzy-second** — `fuzzyFindText` semantics: an exact `find` on
   the active base, else the normalized form. Only edits that fail the exact
   find cause fuzzy mode to engage for the whole call.
3. **Fuzzy normalization** (`normalize_for_fuzzy_match`) — NFKC, then per-line
   `trimEnd`, then a substitution table: smart quotes → ASCII quotes, all dash
   variants (`U+2010`–`U+2015`, `U+2212`) → `-`, special spaces (`U+00A0`,
   `U+2002`–`U+200A`, `U+202F`, `U+205F`, `U+3000`) → space. Pure-ASCII input
   short-circuits NFKC entirely (the identity below `U+0080`), and clean lines
   cross as a single `push_str`.
4. **`FuzzyView`** — the key optimization. JS recomputes
   `normalizeForFuzzyMatch(content)` per edit (pre-pass, replacement base, and
   every `countOccurrences`), so a multi-edit call normalizes the whole file
   once *per edit*. The function is deterministic and idempotent, so one lazily
   built view serves every call site at O(content) once instead of
   O(content × edits).
5. **Validation** — empty `oldText` rejected; not-found rejected; `count > 1`
   rejected as a duplicate (with the occurrence count in the message);
   overlapping ranges rejected after sorting by match index.
6. **Apply** — exact path replaces directly; fuzzy path uses
   `apply_replacements_preserving_unchanged_lines` so untouched lines keep their
   original bytes rather than being rewritten from the normalized view.
   A no-op result (base == new) is rejected rather than silently written.
7. **Render** — `diff.rs` is a jsdiff port (Myers-style `extract_common` /
   `add_to_path` / `build_values`) producing `generateDiffString` and
   `generateUnifiedPatch` output byte-identical to the TS helpers.
   `renderDiff: true` means the content pair never crosses the boundary — only
   the diff does, which is what keeps `piedit` bounded in context cost.
8. **Legacy envelope rung** — when `renderDiff` is absent (an older binary),
   the daemon returns the `{baseContent, newContent}` pair and the extension
   renders the diff itself: mixed-version compatibility after a partial
   upgrade.
9. **Diff internals** — the jsdiff port stores components in an arena
   (`Vec<Component>`) linked by indices instead of a pointer-linked list:
   `extract_common` walks diagonals extending common runs, `add_to_path`
   chains same-flag components, `build_values` reconstructs the token stream.
   `generate_unified_patch` groups changes into `Hunk`s with `@@` headers,
   and `firstChangedLine` rides `details` so the TUI can jump to the edit.

---

## pidx — incremental session-log indexer

Parses `<sessions-dir>/<project>/<ISO-ts>_<uuid>.jsonl` transcripts into compact
per-session extracts consumed by session-audit's fast path.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/pidx-pipeline-dark.png" />
    <img src="assets/diagrams/pidx-pipeline-light.png" alt="pidx pipeline" width="960" />
  </picture>
</p>

Interactive version: [pidx pipeline](assets/diagrams/pidx-pipeline.html) (source: [JSON](assets/diagrams/pidx-pipeline.workflow.json))

### Module map (single `main.rs`)

| Function group | Responsibility |
| --- | --- |
| CLI parse | `--sessions-dir` / `--state` / `--out` / `--max` / `--session` / `--force` / `--report usage\|lifecycle` |
| `discover` / `select_sessions` | scan `<project>/<file>.jsonl`; active-session (5 min) and live-window (10 min) handling |
| `extract_file` | one pass over a JSONL → the extract object |
| `param_hash` / `js_stringify` | JS-compatible param hashing so hashes match the Node parser |
| `gate_family` / `content_bytes` | tool-kind classification (9 families) and size estimation (images ≈ 4 KB) |
| `load_store` / `save_store` | the binary cache (`PIDXST02`) |
| `report_usage` / `report_lifecycle` | spend and lifecycle aggregates |

### Incremental contract

Files are keyed by `(size, mtime_ns)`. An unchanged file **replays its cached
extract bytes** — no JSON parse and no re-serialize — so warm runs are
O(changes), not O(archive). A per-session extract is produced from the JSONL:
turns, tool calls (with parameter hashes), results, compactions, skill loads.

### Extract pass

`extract_file` walks the JSONL once, accumulating: turns deduped by
`responseId` with **last occurrence winning** (apiTurns parity; entries
without one never dedupe), tool calls and results deduped by call id,
compaction entries counted, skill loads counted per skill, and usage
aggregated over **every** assistant message carrying usage — before the rid
dedupe — because a session that retried or streamed twice paid for all of it
even though `turns` keeps one entry per response id.

### State store format

Deliberately explicit little-endian so macOS and Linux share one file format:

```
MAGIC "PIDXST02" | version u32 | header_len u32 | header JSON | data
                                                  ^ {key: Entry}
Entry = { size, mtime_ns, off, len }
```

`data` is the concatenated byte range of each pre-serialized extract; `Entry.off`
/ `len` point into it. Header and data live in **one file** so a single
`write → rename` is atomic — a crash leaves the old store intact, never a
half-updated one. An unknown magic or version silently degrades to a full
reparse rather than failing.

Default paths: state store `<agent-dir>/.cache/pidx-state.json` (override
`--state`). The CLI writes extracts to **stdout** unless `--out` gives a file;
the extension passes `--out <agent-dir>/.cache/pidx-extracts.jsonl`
(`extensions/pidx/index.ts:75-77`) so the repo is never touched.

### Parity notes

`tsMs`, `ACTIVE_SESSION_MS`, and `IMAGE_BYTES_ESTIMATE` are pinned to the Node
parser's behaviour by inline `PARITY:` comments. Individual unparseable files do
not fail the run — they yield an extract with zero turns, and the process still
exits 0.

### Context discipline

The JSONL listing is **never dumped inline**. Extracts are written to a file and
only a compact pointer line enters the model context, hard-capped at
`PI_PIDX_MAX_INLINE` (default 2000 chars). This is the tool that already solved
context cost — the model reads the shape of the corpus, then queries the file.

### Extension boundary

The extension (`extensions/pidx/index.ts`) is deliberately stricter than the
binary:

- **Fail closed on unknown params** — the accepted key list is a single
  source of truth checked at runtime (schema `additionalProperties` is
  advisory at this boundary); a malformed call must error, not silently
  degrade to indexing everything into context.
- **Path sandbox** — `out` / `state` / `sessionsDir` must resolve inside the
  agent state dir or the current repo root (permission-gate audit X2);
  anything else is refused rather than created.
- **`force` is two-step** — `true` alone is refused; `"confirm"` proceeds,
  so a re-index cannot happen by accident.
- **Pointer-line discipline** — extracts default to a file beside the cache;
  `stdout: true` opts into inline extracts hard-capped at
  `PI_PIDX_MAX_INLINE` (default 2000 chars). `execFile` runs with a 64 MiB
  `maxBuffer`; there is no daemon rung.
- The binary prints one **summary JSON on stderr** per run
  (`sessions` / `parsed` / `reused`), which the extension surfaces in
  `details`.

---

## docheck — doc-consistency validator

Not a tool replacement — a repo lint binary (`bin/docheck`), the Rust port of
the former `scripts/doc-check.mjs` (deleted after byte-parity was pinned).
Zero dependencies (std only). Four families:

| Family | Checks |
| --- | --- |
| md-commands | fenced-block shell commands: syntax (`bash -n`), binary exists on PATH, script paths, flags appear in `--help`; mac-only / optional-toolchain / artifact / tmp classes are info-only |
| skills-inventory | README skills table rows ↔ `skills/*/SKILL.md` dirs |
| extensions-inventory | README Extensions section ↔ `extensions/*` dirs with `.ts` |
| env-vars | `PI_*` vars in code ↔ docs, or allowlisted |

`mdcmds.rs` splits the first family into **pure parsers** (unit-tested, no
spawns) and the **two-process probes** (`bash -n`, `--help`), exercised by
the parity diff and fixture tests. Everything is derived from the repo — no
expected counts or inventories live in the binary.

---

## Shared techniques

| Technique | Where | Why |
| --- | --- | --- |
| Reused read buffer, no per-line allocation | `piread` (chunk scan + `memchr`), `pibash` (`read_until`) | one allocation per file, not per line |
| Saturation fast path | `piread` pipeline | once the head buffer is full, later selected lines are counted but never decoded — byte-identical, ~2x on a 5.7 MB read |
| Buffered reader with explicit capacity | `piread` (64 KiB) | amortizes syscalls on large files |
| `Cow<str>` for non-mutating normalization | `piedit` | ASCII fast path allocates nothing |
| Lazy shared view (`FuzzyView`) | `piedit` | removes O(edits × content) normalization |
| SWAR escape scan | `piread`, `piedit`, `pibash` envelopes | ~2.5× faster JSON escaping, no dense-text regression |
| One reused response buffer | all `serve.rs` | no per-response allocation |
| `skip_serializing_if` | envelopes | halves envelope size where a field duplicates the payload |
| Incremental UTF-8 decode | `pibash` accumulator | chunk boundaries never split a character |
| Copy-on-write stage pipeline | `pibash` compress | ANSI-free / fold-free output borrows the stream — no copy, no re-split |
| One shared line split | `pibash` compress | `error_priority_lines` / `head_tail_lines` take `&[&str]`; one `Vec`, not three |
| Line-ring compaction window | `pibash` accumulator | `snapshot()` re-splits only the display window, never the whole tail |
| Single-materialization envelope | `pibash` | `into_full_text` + `cap_full_output` read the stream once; `structuredContent` derives from the same buffer |
| Spill-to-file above a cap | `pibash` accumulator | bounded memory with lossless recovery |
| `(size, mtime_ns)` freshness key | `pidx` | O(changes) warm runs |
| Output reuse on a no-op warm run | `pidx` | the extract file is a pure function of the store, so an up-to-date file is never rewritten (15 MB per call removed) |
| Parallel independent probes | `docheck` | one `--help` spawn per (binary, flag) pair resolved across cores; indexed results keep findings byte-identical (3.0 → 1.9 s) |
| Byte-range + atomic rename store | `pidx` | crash-safe single-file cache |
| `setpgid(0, 0)` | all daemons | group-wide signals cannot reach the daemon |
| ref/unref refcounting | extensions | idle daemon costs nothing; in-flight request keeps the loop |
| Node-style error codes | `piread`, `piedit` | the built-in interpolates `ENOENT`/`EACCES` into messages |

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Oracle** | The original TypeScript tool; the parity and byte-equality reference |
| **Rung** | One tier of the dispatch ladder (daemon / one-shot / built-in) |
| **Envelope** | The single JSON object a tool prints or emits per call |
| **Spill** | Full output written to a temp file once it exceeds the in-memory cap |
| **H1 cap** | permission-gate's model-visible limit: 40 lines / 2 KB |
| **Compaction** | Deterministic head-tail / error-priority reduction to the H1 budget |
| **Omission marker** | `[... omitted N chars / M lines ...]` — the explicit record of a cut |
| **Omissions list** | `details.compaction.omissions[]` — the same cut as structured absolute line ranges (piread only) |
| **Warm run** | `pidx` run where no session file changed; replays cached extracts |
| **Fail-open** | Any native failure advances to the next rung instead of erroring |
| **Oracle** | The stock built-in tool the native path must byte-match — parity source of truth (see [`native-tools.md`](native-tools.md)) |
