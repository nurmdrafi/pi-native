This is a strong, unusually disciplined architecture: the fail-open ladder, byte-exact oracle parity, bounded context output, and daemon lifecycle rules are all the right calls for a token- and latency-sensitive agent harness. The main remaining risks are not “make Rust faster”; they are **daemon correctness under concurrency/cancellation**, **pibash double serialization**, **security of the shell/daemon boundary**, and **operability when fallbacks mask real failures**. Your prior benchmark direction already identifies per-rung measurement and the pibash large-output issue as the key follow-ups. 

## Overall assessment

**Rating: 8.5/10 for the stated goals** — performance, token efficiency, reliability, and portability.

The architecture correctly separates concerns:

| Layer | Responsibility | Assessment |
|---|---|---|
| Extension | Registration, env/session glue, cancellation, TUI, fallback selection | Good; keeps OS-specific process work out of Rust |
| Daemon | Hot-path NDJSON execution | Good, but needs stricter timeout/backpressure policy |
| One-shot | Transport-independent fallback | Good |
| Built-in | Final correctness oracle | Excellent safety property |
| Compaction | Model-visible cost control | Excellent; likely the biggest real-world win |
| Parity tests | Byte-for-byte compatibility | Excellent; prevents silent behavioral drift |

The biggest architectural win is not the daemon’s 0.03–0.18 ms dispatch improvement; it is the **94%+ reduction in model-visible bytes** from compaction and pointer-only outputs. That directly reduces token spend and downstream model latency. 

## What is already right

### Fail-open ladder

The `daemon → one-shot → built-in` ladder is the correct reliability model. It turns native-tool defects into performance degradation rather than agent-breaking failures, and preserving the TypeScript implementation as the final oracle is especially valuable while the Rust tools are still evolving. 

Two details are particularly good:

- `details.via` records the rung without leaking into model-visible content.
- Violation/adoption telemetry is one row per terminal fallback, not one row per ladder rung, avoiding noisy logs.

### Daemon lifecycle

The ref/unref matrix is correct and addresses the classic Node child-process pitfalls:

- Idle: unref process and streams.
- In-flight: ref all three.
- Pending empty: unref all three.

Your two documented bugs—unsettled top-level await and a host that never exits—are exactly the failure modes this design needs to guard against. Keeping tests for both is appropriate. 

### Process-group isolation

Using `setpgid(0, 0)` for daemons and `process_group(0)` for shell children is a sound split:

- The daemon escapes group-wide signals aimed at the client/session.
- `pibash` can still kill a timed-out command tree via `-<pid>`.
- Avoiding `setsid()` is reasonable because it is unnecessary for a stdio daemon and introduces session/terminal complications.

This is one of the strongest reliability decisions in the design. 

### Context shaping

The compaction strategy is practical and agent-aware:

- `pibash`: command-aware error priority for test/build output.
- `piread`: deterministic head/tail with continuation metadata.
- `piedit`: bounded diff rather than full file contents.
- `pidx`: file pointer instead of inline corpus dump.

The important property is that compaction is **deterministic, idempotent, UTF-8-safe, and reversible or recoverable**. That makes results cacheable, testable, and safe for parity checks. 

## Highest-priority risks

### 1. pibash still pays for large output twice

Your earlier benchmark finding is the most important optimization target: `pibash` is roughly neutral for small commands but regresses on large output because the payload is serialized twice. 

Recommended target architecture:

```text
child stdout/stderr
  → streaming accumulator
  → compaction decision
  → serialize only final model-visible envelope
  → optional full-output spill reference
```

Specific changes:

- Do not retain both `full_text` and a separately serialized legacy tail result when compaction has already selected the final output.
- Make compaction streaming where possible: retain only candidate head, tail, error lines, and counters rather than the entire decoded stream.
- Ensure the spill file is written incrementally, not by re-reading and rewriting the full captured text.
- Add a benchmark fixture specifically for 1 MB, 10 MB, and 100 MB command output.

Acceptance criterion: for large-output commands, Rust should not allocate or serialize more than `O(model-visible budget + spill write throughput)`.

### 2. Serial daemon processing can become a hidden latency tax

Single-threaded, in-order daemon processing is excellent for determinism and simplicity, but it creates head-of-line blocking:

- A long `pibash` command blocks later `piread` calls.
- A slow file read blocks a quick edit.
- Cancellation of one request cannot easily cancel the daemon’s current work.

For your current four tools, this is probably acceptable if tool calls are mostly sequential. But once subagents or parallel tool calls become common, use one of these options:

| Option | Tradeoff |
|---|---|
| One daemon per tool | Simple isolation; more processes and memory |
| Thread pool inside each daemon | Better concurrency; requires request cancellation and bounded queue |
| Spawn long-running `pibash` work outside daemon | Keeps daemon responsive; adds process management complexity |

My recommendation: keep `piread`, `piedit`, and `pidx` serial for now, but give `pibash` a dedicated daemon or an explicit “long command” escape hatch. Shell commands are the most likely long-running workload.

### 3. Cancellation semantics are underspecified

The document says the extension owns cancellation, but the daemon protocol does not define what happens when a request is cancelled.

You need explicit answers for:

- Does the client send a `cancel` frame?
- Does the daemon cancel the child process group?
- Does a cancelled request still write a response?
- Can a cancelled request leave partial spill files behind?
- Does a timeout differ from user cancellation in the envelope?

A minimal robust protocol addition:

```jsonc
{ "id": 7, "op": "cancel", "targetId": 7 }
```

Rules:

- The daemon acknowledges cancellation immediately.
- The active shell process group receives `SIGTERM`, then `SIGKILL` after a grace period.
- The original request emits a terminal envelope: `cancelled: true` or an error with `kind: "CANCELLED"`.
- Spill files are removed unless explicitly retained for debugging.

Without this, cancellation may only detach the Node await while the Rust child continues consuming CPU, writing files, or holding locks.

### 4. Daemon security boundary needs tightening

The daemon receives JSON over stdio from the extension, which is a reasonable trust boundary. But `pibash` still executes arbitrary shell commands, so the security model should be explicit.

Recommended invariants:

- The daemon must never read configuration, credentials, or command allowlists from an untrusted project-local file without validation.
- Environment injection should be allowlisted, not broadly inherited by default.
- `cwd` must be canonicalized and checked against permitted roots where your permission policy requires it.
- Temp spill files should use `O_EXCL`, restrictive permissions, and cleanup on abnormal exit.
- The daemon should not trust `PI_*` variables blindly; validate types, lengths, and paths.
- Log files must not include secrets, full environments, or raw command output by default.

The permission gate treating native tools as wrappers around `read` / `edit` / `bash` is good, but the native layer should not become a way to bypass path, symlink, or git-protection checks. Your backlog already flags permission-gate symlink issues as important; I would treat those as pre-production blockers rather than ordinary backlog work. 

### 5. Fallback observability can hide systemic failure

Fail-open is correct, but it can quietly turn into “everything runs through the built-in” without anyone noticing.

Add operational thresholds:

- Fallback rate per tool per session.
- Consecutive fallback count.
- Daemon restart count.
- Time-to-first-fallback after daemon start.
- Percentage of requests by `via`.
- Model-visible bytes saved per tool.

A useful rule: if a native tool falls back more than N consecutive times, emit one prominent diagnostic and optionally disable that daemon for the remainder of the session to avoid restart churn.

## Architecture-level improvements

### Split protocol from tool schema

Right now each daemon speaks a tool-specific request shape. That is fine at four tools, but it will become repetitive.

Introduce a tiny shared envelope:

```jsonc
{ "v": 1, "id": 7, "tool": "piread", "op": "read", "params": { ... } }
```

Response:

```jsonc
{ "v": 1, "id": 7, "ok": true, "result": { ... } }
```

Benefits:

- One client dispatcher.
- Uniform cancellation, timeout, and error handling.
- Easier to add future tools such as `pisearch`, `pigrep`, or `pifs`.
- Versioned protocol makes daemon/client mismatch detectable.

Keep the tool-specific result shape unchanged so parity tests remain stable.

### Add protocol version and handshake

The daemon currently assumes the extension and binary match. If a user has a stale installed binary, behavior may be subtly wrong rather than obviously incompatible.

Add a first-line handshake:

```jsonc
{ "op": "hello", "protocol": 1, "tool": "piread", "version": "0.4.2" }
```

If the extension sees an unexpected protocol or tool version, immediately use one-shot or built-in and record `protocol_mismatch`.

### Make daemon health explicit

“Lazy restart on death” is good, but add a lightweight health check before reusing a long-idle daemon:

- Check whether the process is still alive.
- Optionally send `{"op":"ping","id":...}` with a short timeout.
- If no response, clear the slot and restart.

This avoids sending a real request into a zombie or half-dead pipe.

For your use case, a cheap liveness check is probably enough; a ping adds one round trip but substantially improves recovery determinism.

## Optimization review

### Keep these optimizations

These are high-value and should remain:

- Workspace with shared `Cargo.lock` and `target/`.
- `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`.
- No Tokio, Clap, regex, or libc dependency.
- Streaming `read_until` with reused buffers.
- Incremental UTF-8 decoding.
- `Cow<str>` ASCII fast paths.
- Lazy `FuzzyView` in `piedit`.
- Reused daemon response buffer.
- Atomic write-plus-rename cache in `pidx`.
- `(size, mtime_ns)` incremental invalidation.

2026-10-25 disposition (piedit): incremental UTF-8 decoding is retired by
measurement — the 1 MiB edit class runs 4.27 ms p50 end-to-end, 7× under the
in-process oracle (`benchmark/runs/piedit-microbench-2026-10-25.md`), and
decoding is a small slice of that; the remaining cost is IPC + write.
Whole-buffer decoding stays unless a decode-bound class ever appears.

These choices match your goal of small, fast, maintainable native tools rather than heavyweight service infrastructure. 

### Reconsider these

| Item | Concern | Recommendation |
|---|---|---|
| `panic = "abort"` | A panic kills the daemon and drops every in-flight request | Keep it, but ensure every request has a client-side timeout and fallback |
| Raw `extern "C"` for `setpgid` | Low dependency cost, but easy to get wrong | Keep, but add Unix-only integration tests and document platform support |
| `preserve_order` everywhere | Needed for byte parity, but slightly more expensive | Keep for envelope boundary; consider normal maps internally where order is irrelevant |
| SWAR JSON escaping | Good hot-path optimization | Keep, but ensure it does not complicate security-sensitive escaping |
| 2000-line / 50 KB accumulator | Reasonable default | Make configurable through validated env vars; document memory ceiling |
| 30 ms reader grace | Prevents tail loss | Consider adaptive grace: longer for commands known to flush late |

### Optimization priorities

In order:

1. **Eliminate pibash double serialization.** Highest real-world impact for large command output. 
2. **Define cancellation and timeout protocol.** Prevents orphaned work and ambiguous agent state.
3. **Add daemon handshake and health checks.** Prevents stale-binary and zombie-daemon issues.
4. **Instrument per-rung latency and fallback rate.** You need this before further micro-optimization. 
5. **Harden permission/path/symlink checks.** Security and correctness before additional speed.
6. **Only then optimize internal hot paths** such as fuzzy matching, diffing, or JSON escaping.

## Testing gaps to close

Your parity suite is excellent, but add these test classes:

- **Cancellation:** cancel during long-running `pibash`; assert child process group dies and no orphan remains.
- **Daemon restart storm:** kill daemon repeatedly during requests; assert no hang, duplicate response, or unsettled promise.
- **Backpressure:** child writes megabytes while client is slow; assert no deadlock and bounded memory.
- **Concurrent requests:** even if processed serially, assert id matching and no response interleaving.
- **Stale binary:** protocol/version mismatch falls back cleanly.
- **Spill cleanup:** normal exit, timeout, cancellation, and daemon kill all clean temp files.
- **Fallback metrics:** every fallback produces exactly one structured event with the correct `sid`, tool, reason, and path.
- **Cross-platform process groups:** macOS and Linux behavior for `setpgid`, timeout kill, and orphan prevention.

## Recommended next pass

I would sequence the next implementation pass as:

1. **Fix pibash large-output path** — single final serialization, streaming spill, benchmark at 1/10/100 MB.
2. **Add cancellation protocol** — cancel frame, process-group kill, terminal envelope, spill cleanup.
3. **Add daemon handshake and health check** — protocol version, tool identity, stale-binary fallback.
4. **Add operational metrics** — per-rung latency, fallback rate, restart count, model-visible bytes.
5. **Harden security and path policy** — symlink, cwd, env injection, temp-file cleanup.
6. **Run a per-rung benchmark suite** — daemon, one-shot, built-in, warm/cold `pidx`, and large-output `pibash`.

The architecture is already good enough that further work should prioritize **correctness under failure, cancellation, and observable performance** rather than more general optimization. Your strongest claim to maintain is: native Rust tools provide near-equivalent dispatch latency while dramatically reducing model-visible context; the remaining work is to make that claim robust under large outputs, cancellation, and real-world daemon failures.

## Tool-wise improvements

| Tool | Improvement area | Priority |
|---|---|---|
| **pibash** | Remove duplicate serialization of large output; make spill + compaction streaming; fix `seq 50000`-style regression | **P0** |
| **pibash** | Define cancellation: cancel frame → kill child process group → terminal envelope → cleanup spill | **P0** |
| **pibash** | Bound memory for very large stdout/stderr; test 1 MB / 10 MB / 100 MB outputs | P1 |
| **piread** | Keep bounded memory contract; add tests for huge files, UTF-8 boundaries, binary detection, and offset edge cases | P1 |
| **piread** | Ensure compaction never rewrites `truncation` metadata or weakens read-coverage certification | P1 |
| **piedit** | Preserve exact bytes for untouched lines; add tests for CRLF, BOM, Unicode fuzzy matches, overlapping edits | P1 |
| **piedit** | Optimize only after correctness: large-file fuzzy matching, diff generation, and multi-edit batching | P2 |
| **pidx** | Add cache corruption recovery tests; validate atomic rename behavior under crash/kill | P1 |
| **pidx** | Benchmark cold parse, warm replay, and one-file-change incremental update separately | P2 |
| **pidx** | Consider periodic compaction if the state store grows large | P3 |

## Cross-tool improvements

| Scope | Improvement area | Priority |
|---|---|---|
| **Daemon protocol** | Add versioned handshake: protocol version, tool name, binary version | **P0** |
| **Daemon protocol** | Add `ping` / health check and stale-daemon recovery | P1 |
| **Daemon protocol** | Standardize error, timeout, cancellation, and malformed-request envelopes | **P0** |
| **Cancellation** | Define client-side timeout, daemon-side cancellation, and child-process cleanup | **P0** |
| **Security** | Fix permission-gate symlink / protected-path bypass issues first | **P0** |
| **Security** | Validate `cwd`, paths, env injection, temp files, and secrets in logs | P1 |
| **Reliability** | Add daemon restart-storm, broken pipe, slow client, and concurrent-request tests | P1 |
| **Observability** | Track per-rung latency, fallback rate, restart count, and model-visible bytes | P1 |
| **Portability** | Add Linux CI and verify macOS + Linux parity for process groups, paths, and temp files | **P0** |
| **Benchmarking** | Build per-tool, per-rung benchmark matrix; do not average across models | P2 |

## Recommended order

1. Fix permission-gate symlink/protected-path security issues.   
2. Fix `pibash` large-output duplicate encoding.   
3. Add daemon handshake, cancellation, and timeout protocol.  
4. Add Linux CI and macOS/Linux parity tests.   
5. Add fallback/latency/model-visible-byte metrics.  
6. Run the full per-tool benchmark later.