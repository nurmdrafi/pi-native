# pibash Large-Output Double Serialization: Target Design & Research Brief

Scope: why `pibash` regresses on large output (`seq 50000`), and a concrete, std-only target design that removes the double serialization. Written against the reported architecture: serial NDJSON stdio daemon (`--serve`) → one-shot CLI → built-in TS oracle, fail-open ladder, deterministic compaction with a 2000-line/50KB accumulator, 30ms reader grace, command-aware error priority. Measured: ≥94% model-visible byte reduction overall, regression only on large output because the payload is serialized twice (full text plus a separately serialized legacy tail).

Citations are inline. Everything not traceable to a cited source is marked **[uncited]** — treat those as engineering judgment to validate with the fixtures in §4, not as sourced fact.

---

## 1. Answer: recommended target design

The defect is not that pibash captures a lot of bytes; it is that it *retains* them and then *re-encodes* them. The accumulator keeps the full stream, compaction picks a subset, and both the full text and the legacy tail get written into the NDJSON envelope as JSON strings. So per byte of child output you pay: an in-memory copy in the accumulator, a string escape pass over that copy, and a second escape pass over the tail — plus peak RSS that scales with the stream rather than with the model-visible budget.

The target design inverts the ownership: **the spill file becomes the only durable copy of the full stream, and the envelope is built exactly once from bounded candidate buffers.** Five stages, all std:

**Stage 1 — bounded candidate capture (no full-stream retention).**
Replace the "accumulate everything, then compact" step with an ingest loop that, per read chunk, feeds only bounded structures:

- `head`: `Vec<Vec<u8>>`, capacity `HEAD_LINES` (e.g. 50), pushed only until full, then dropped.
- `tail`: a fixed-capacity ring (`VecDeque<Vec<u8>>`, capacity `TAIL_LINES`, e.g. 2000) — push and pop-front at capacity, so memory is O(tail budget) regardless of stream size.
- `error_candidates`: a bounded `VecDeque` with the same ring semantics, selected by a cheap command-aware classifier (see §2 Q1). Keep a *candidate* window, not a decision: the error-priority choice is applied after the stream ends, when stdout/stderr interleaving and exit code are known.
- counters: `total_bytes`, `total_lines`, `truncated_bytes`, per-stream byte counts.
- partial line state: a single `Vec<u8>` `pending` buffer holding an unterminated line between reads. Cap it (e.g. 64 KiB); if a single line exceeds the cap, flush the prefix into the line's slot as a `line_truncated` marker rather than growing without bound. This is the one unbounded-ish allocation risk in the whole design and must be capped explicitly **[uncited]**.

Line-splitting must operate on `&[u8]` with `\n` (and `\r\n` normalization) rather than `String`, both to avoid UTF-8 validation cost on paths that may never land in the envelope and to survive non-UTF-8 child output — `String::from_utf8_lossy` only at the point of envelope construction, on the few surviving lines **[uncited]**.

**Stage 2 — spill, written incrementally.**
Open the spill file lazily on the *second* chunk or once `total_bytes` crosses a small high-water mark (e.g. 256 KiB), so ordinary small commands never touch the filesystem **[uncited]**. Wrap it in a `BufWriter` (see §2 Q2) and write each chunk as it is read. This is the streaming-write discipline the Medium pipeline article describes: write as you read, let a buffered writer absorb the syscall cost, do not build the document in memory first (https://medium.com/@adamszpilewicz/streaming-millions-of-rows-to-disk-rust-file-i-o-patterns-for-high-volume-data-pipelines-f5dd9dc97d1c). Write stdout and stderr to *separate* spill files (or one file with framing) so post-hoc reconstruction of interleaving stays possible without paying for a merge during the hot loop **[uncited]**.

**Stage 3 — compaction decision (unchanged semantics, cheaper inputs).**
Run the existing deterministic policy over the bounded candidates only: head + tail + prioritized error lines + counters, budgeted to the model-visible limit. Nothing here touches the full stream, so the decision is O(budget), not O(output). Keep the 30ms reader grace where it is — it is a scheduling policy, not a data-volume policy.

**Stage 4 — single-serialization envelope.**
Serialize the envelope once, into a **reused in-memory `Vec<u8>`**, then emit that buffer as one write to the NDJSON sink. Concretely: `serde_json::to_writer(&mut scratch, &envelope)` where `scratch` is reused across requests (`clear()` between), then a single `write_all(&scratch)` to the socket. This is deliberately *the same shape as* "serialize to a `String` and write once": the serializer walks the value and escapes into a flat memory buffer, and the transport sees exactly one write. Serde's own guidance frames `to_writer` as the large-payload path and `to_string` as the small-payload convenience (https://reintech.io/blog/serde-tutorial-json-serialization-deserialization-rust), and the performance-serialization talk explains the mechanism — the serializer is a state machine over an `io::Write`, so the writer boundary is where copies are eliminated (https://www.youtube.com/watch?v=kda0CeL9P0M). The Node/JSONStream article describes the same principle from the other side of the language fence: emit the structure rather than materialize the whole object first (https://www.bennadel.com/blog/3232-parsing-and-serializing-large-objects-using-jsonstream-in-node-js.htm).

**Caveat that inverts the win if ignored:** if `to_writer` is pointed *directly at an unbuffered socket*, each `serialize_field` call becomes its own small `write(2)`, and the many-small-writes pattern can lose to building a buffer and issuing one write — a counterintuitive result reported on the Rust users forum, where serializing to a `String` and then writing once beat `to_writer`'s small writes (https://users.rust-lang.org/t/why-does-serializing-a-struct-to-a-string-result-in-much-faster-write-speeds/80579). Benchmark work on faster serialization independently shows manual/flat-buffer serialization competing with or beating derive-driven streaming (https://mo8it.com/blog/faster-rust-serialization). The design's answer is to keep the `Vec<u8>` intermediate (bounded, reused) **or**, if the envelope ever goes straight to the socket, wrap the socket in a `BufWriter` so field-level writes coalesce. Never `to_writer` into a raw `TcpStream`/`ChildStdin`. Verify against §4 before changing this.

The spill reference in the envelope is a *string path plus counters*, never the spilled text: `{"spill": "/tmp/...", "bytes": 3421184, "lines": 50000, "truncated": true}`. That single change is what makes the envelope size independent of child output size.

**Stage 5 — spill lifecycle.**
Spill files are per-request, named deterministically, created in a session-scoped directory, and reaped by the daemon on a TTL/age sweep (and on session end) rather than immediately after the response — the model may read them a turn later. Size-cap the directory and evict oldest-first **[uncited]**. Fail-open: if the spill `open`/`write` fails for any reason, degrade to capture-without-spill (bounded candidates only, envelope reports `spill: null, truncated: true`) and never fail the command.

The acceptance criterion stated in the task — O(model-visible budget + spill write throughput) — is exactly what this design delivers: steady-state RSS is bounded by the candidate budgets plus one read chunk plus the `BufWriter` capacity, independent of total output; wall time is bounded by pipe read rate plus spill write throughput; and bytes-serialized-to-JSON becomes O(envelope) instead of O(output).

---

## 2. Per-question findings

### Q1 — std-only streaming capture into bounded head/tail/error candidates

The core pattern is a read loop over `ChildStdout`/`ChildStderr` with a fixed buffer, splitting on `\n` and pushing only into bounded structures. Two things the supplied material highlights that materially affect correctness here:

- You must **drain both pipes concurrently** relative to `wait()`. The Rust users thread on processing a running command's output documents the classic failure: calling `wait()` while a pipe still has a full buffer deadlocks, because the child blocks writing and the parent blocks waiting. The remedy is to read stdout and stderr on their own threads (or with `try_wait` polling plus non-blocking reads) and only `wait()` once both readers have hit EOF, then `join` the readers (https://users.rust-lang.org/t/how-to-process-output-of-running-command-and-clean-up-when-done/72019). Std-only means `std::thread::spawn` scoped over the two pipe handles — that is the whole toolkit you need, and it is also why the accumulator must be shared behind a `Mutex` or (better) partitioned by stream so the two reader threads never contend on the same ring **[uncited]**.
- The cheapest way to keep "bounded" honest is to make the *type system* carry the bound: each candidate structure is a newtype wrapping a `VecDeque` with a `capacity` field and a `push_bounded` method that pops from the front before pushing. Every insertion site then provably cannot grow without a corresponding eviction, which is what makes the fixture-based RSS assertion in §4 stable.
- Error-line selection should be a candidate classifier, not a decision: match on cheap byte predicates (case-insensitive prefix scan for `error`, `fatal`, `traceback`, `panicked at`; `^file:line:col` diagnostic shape; exit-code correlation applied post-hoc) and keep the *last N* matches plus the *first N*, since build tools emit the useful diagnostic early and the summary late **[uncited]**. Doing the priority decision post-stream is what lets you honor exit code zero/one without having to buffer.

The streaming-JSON article supplies the mental model worth borrowing even though pibash never parses JSON: an incremental consumer keeps a bounded working set and hands off each element as it arrives (https://www.ixpantia.com/en/blog/json-with-rust-serde-tokio). The same shape applied to line-oriented child output is the accumulator described above.

### Q2 — Incremental spill: write-as-you-read vs post-hoc, buffering, fsync

Write-as-you-read wins on every axis that matters here, and the pipeline article is the direct statement of the pattern: stream rows to disk through a buffered writer, and never accumulate the document in memory in order to write it in one call (https://medium.com/@adamszpilewicz/streaming-millions-of-rows-to-disk-rust-file-i-o-patterns-for-high-volume-data-pipelines-f5dd9dc97d1c). Post-hoc dump means you have already retained the full stream to be able to write it — which reintroduces exactly the O(output) retention the design is removing. Incremental write is not merely an I/O optimization; it is what makes bounded retention possible. (Note the consistency requirement this creates: if the envelope uses an in-memory intermediate to get one write, the *spill* deliberately does not — it is unbounded in size, so buffering it whole is the thing being eliminated. One write per artifact is right for the envelope, wrong for the spill.)

Buffered-writer sizing: `std::io::BufWriter` defaults to 8 KiB **[uncited]**. For 1–100 MB sequential writes, 64–256 KiB is the sensible range — large enough that syscall count per megabyte is negligible (a 100 MB spill becomes ~400–1600 `write(2)` calls at 256/64 KiB), small enough not to distort the RSS bound you are trying to defend. Do not exceed the envelope's size class by much, or the buffer itself becomes a visible constant in the RSS measurement. `BufWriter::with_capacity` is the std hook; there is no need for `libc::writev` **[uncited]**.

fsync policy: **do not fsync per write, and probably do not fsync at all.** The spill is a disposable, session-scoped cache whose loss is a degraded response, not corruption — the fail-open ladder already tolerates its absence. `flush()` at end-of-request is required (so a later reader sees the bytes); `sync_all()` is a latency tax with no correctness payoff for a cache. If a durability story is later needed for post-crash forensics, make it opt-in and one `sync_all()` after the final flush, never per chunk **[uncited]**.

One macOS/Linux divergence worth noting for the write path: on macOS `fsync()` does not guarantee the data has reached stable media unless the drive honors `F_FULLFSYNC`; std exposes only `sync_all`, so a "durable spill" claim is not portable **[uncited]**. Another reason to keep the cache semantics honest.

### Q3 — Single-serialization envelope construction

The rule is: **one pass from in-memory structures to bytes, into a pre-existing buffer, then one write.** Concretely:

- `serde_json::to_writer(&mut scratch, &envelope)` then `scratch.clear()` on reuse — versus `to_string()`, which allocates a `String`, grows it by repeated reallocation, and then must be copied again into the daemon's NDJSON write path. The tutorial's guidance table frames `to_string` as the small-payload convenience and `to_writer` as the large-payload path (https://reintech.io/blog/serde-tutorial-json-serialization-deserialization-rust), and the performance-serialization talk explains the mechanism: the serializer writes into an `io::Write` as it walks the value, so an intermediate owned string is pure overhead *when the writer is a memory buffer you already hold* (https://www.youtube.com/watch?v=kda0CeL9P0M).
- **The important qualification**, and the reason this section cannot be reduced to "always prefer `to_writer`": `to_writer`'s advantage depends entirely on what it is writing into. Given a flat buffer, it avoids the intermediate. Given an unbuffered socket, it converts one big write into a stream of tiny ones, and that inverts the result — a reported case where `String`-then-single-write beat `to_writer` (https://users.rust-lang.org/t/why-does-serializing-a-struct-to-a-string-result-in-much-faster-write-speeds/80579). Benchmarking of manual vs derived serialization reaches the same conclusion: the buffer strategy dominates the serializer API choice (https://mo8it.com/blog/faster-rust-serialization). Practical rule: `to_writer` into a reused `Vec<u8>`, or `to_writer` into a `BufWriter` wrapping the socket — never into the raw socket. The design here takes the first option, because the envelope is bounded so holding it costs nothing.
- Model a custom `Serialize` impl (or `serialize_struct`) whose `serialize_field` calls pull borrowed `&str`/`&[u8]` slices directly from the captured candidates. `&str` fields serialize without allocation; `String` fields force a copy. The lossy UTF-8 conversion therefore happens once, into a small reused scratch, not into a per-line `String`.
- The same discipline removes the *legacy tail* problem at the root: today the tail is serialized separately and then embedded, i.e. escaped bytes get escaped again. In the target design the tail is a field of the envelope like every other field, written by the same single `to_writer` pass.
- Do **not** hand-roll JSON string escaping as a first move. `serde_json`'s string encoder is already tight, and with `lto=fat` + `codegen-units=1` its hot paths inline well. If §4 shows escaping still dominates, the *next* lever is a flat manual encode (https://mo8it.com/blog/faster-rust-serialization) — but measure before writing one, since the win here is structural (one pass, no retained intermediate), not micro-optimizational **[uncited]**.
- Keep the NDJSON newline out of the serialized value: write the envelope bytes, then write `b"\n"` to the same sink, so the envelope is a pure serialization with no trailer to strip or re-append **[uncited]**.

The Node side of the fence is instructive but not directly applicable: JSONStream avoids materializing an object by emitting JSON tokens incrementally to a stream (https://www.bennadel.com/blog/3232-parsing-and-serializing-large-objects-using-jsonstream-in-node-js.htm). In Rust the equivalent is `to_writer` against a bounded buffer or a `BufWriter` — the "stream" is the writer, and because the envelope is capped at the model-visible budget, a memory buffer is the right writer.

### Q4 — Zero-copy splice/sendfile for the spill path

Verdict: **not applicable, and actively wrong for this architecture.** Four independent reasons:

1. **The mechanism requires kernel-to-kernel data movement between objects the design does not have.** `sendfile(out_fd, in_fd, ...)` copies from a file into a socket; `splice()` moves pages through a pipe between two fds, needing at least one end to be a pipe (https://blog.superpat.com/zero-copy-in-linux-with-sendfile-and-splice). pibash's spill path reads a *pipe* from a child and writes to a *file* — but the data must pass through user space anyway, because you cannot classify error candidates, count lines, or build the tail ring without inspecting every byte. Zero-copy would move bytes you must read regardless.
2. **splice's support is filesystem- and object-dependent**, so even on Linux it is not a general primitive: Torvalds' own remarks in the splice design thread describe it as constrained by what the underlying filesystem can do (https://yarchive.net/comp/linux/splice.html), and the mechanics are usually framed as "sendfile is socket-focused, splice is the generalized zero-copy" with correspondingly broader caveats (https://www.youtube.com/watch?v=FopM7wWvKbc). A coding-agent harness cannot assume the target filesystem supports the fast path.
3. **The relevant scenario — handing the model a big artifact — is solved by a path, not by a transfer.** The envelope already carries `{"spill": "/path"}`, and whatever consumes it (the model's read tool, `piread`) opens the file itself. There is no server-side copy to eliminate.
4. **Portability.** `sendfile`/`splice` are Linux-specific; macOS has its own `sendfile` signature and no `splice`. You are std-only with `lto=fat`, so reaching these means new raw `extern "C"` declarations and divergent per-OS code paths — exactly the class of change the harness's portability rule exists to prevent. Note also that even the reference implementations must run `splice`/`sendfile` in an `EINTR`-retrying loop with short-write accounting (https://blog.superpat.com/zero-copy-in-linux-with-sendfile-and-splice; https://howtech.substack.com/p/implementing-zero-copy-io-using-sendfile) — you would pay that complexity for a path that is not on the critical path.

Where zero-copy *ideas* do transfer as cheap, std-only gestures: write from `&[u8]` slices you already own (no intermediate `Vec` per chunk), and reuse one read buffer across the whole loop so the reader never allocates per chunk. That is the portable 90% of the benefit **[uncited]**.

---

## 3. Risks and gotchas

**EINTR.** Every blocking read from a child pipe can return `ErrorKind::Interrupted`, and every write to the spill file can too. Std's `Read::read` and `Write::write_all` already retry `Interrupted` internally for these impls, but any hand-written loop over `read` that treats `Err` as fatal will corrupt state under signal load — and SIGCHLD/SIGWINCH traffic in an interactive harness makes this real, not theoretical. The zero-copy references show the same retry-and-account discipline explicitly (https://blog.superpat.com/zero-copy-in-linux-with-sendfile-and-splice). Rule: `match err.kind() { Interrupted => continue, _ => break }` at every raw read site **[uncited]**.

**Pipe capacity: 64 KiB on Linux, smaller and variable on macOS.** Linux's default pipe buffer is 64 KiB and can be raised via `fcntl`, with a system-imposed maximum (https://news.ycombinator.com/item?id=39677853); a cross-OS survey of IPC buffer sizes puts the platforms side by side (https://www.netmeister.org/blog/ipcbufs.html). On macOS the historical default is **16 KiB**, with 64 KiB available on demand (https://christiantietze.de/posts/2025/03/process-pipe-64kib-limit) — so code that works on Linux at 64 KiB can hang or behave differently on macOS at 16 KiB. That is not hypothetical: an MCP stdio server was reported hanging on macOS when a response exceeded the small anonymous-pipe buffer (https://forum.cursor.com/t/bug-stdio-mcp-server-hangs-on-macos-when-response-8-kb-pipe-buffer-exhaustion/158804) — the exact failure class a coding-agent harness must avoid. Consequences for the design: the child stalls whenever the reader is slower than the producer, throughput becomes bounded by spill write rate (acceptable, but must be measured), and **no logic may depend on a specific capacity** — do not size the read buffer to "match the pipe," and never assume a write of N bytes completes atomically. Drain continuously and always.

**Deadlock on `wait()`.** Per Q1: `wait()` before draining both pipes hangs once either pipe fills (https://users.rust-lang.org/t/how-to-process-output-of-running-command-and-clean-up-when-done/72019). The correct order is: spawn readers → both readers EOF → `wait()` → `join` readers → compact → serialize. The existing 30ms reader grace must be defined relative to this order, or a grace expiry can be mistaken for EOF while the child is still writing.

**macOS vs Linux divergence, catalogued.** Pipe capacity (16 KiB default vs 64 KiB); `fsync` semantics (F_FULLFSYNC); no `splice`; divergent `sendfile`; `/proc` absent (so no cheap fd-based size checks); different default file-descriptor limits, which matters because the design holds read ends, write ends, and spill fds simultaneously **[uncited]**. The harness's portability rule already forbids OS-conditional code; keep the design inside that envelope.

**`panic=abort` interaction.** With `panic=abort`, a panic in any reader thread kills the whole process — no unwinding, no partial cleanup. That makes every arithmetic on counters/lengths a correctness surface: overflow, slice-index, and capacity math must be checked, not asserted-and-panicked. Fail-open ladder notwithstanding, `panic=abort` means the ladder must be implemented with `Result`, never with `catch_unwind` **[uncited]**.

**Non-UTF-8 and very long lines.** Child output can be arbitrary bytes; `from_utf8_lossy` at envelope time is the only safe conversion point. A single line larger than the pending-buffer cap (minified JSON, base64 blob, binary spew on stderr) is the realistic unbounded-growth hole in an otherwise bounded design — cap it explicitly and record `line_truncated: true` so the model knows it is seeing a fragment **[uncited]**.

**Ring vs head budget mis-sizing.** Head and tail budgets that sum above the model-visible budget make the "compaction" a no-op that still ships everything. Assert at construction time: `head_bytes + tail_bytes + error_bytes <= budget` **[uncited]**.

**Spill-directory growth.** Per-request spill inside a long-lived daemon accumulates without bound across sessions. Needs TTL + max-bytes + oldest-first eviction, and must survive a session that crashes mid-write (partial file left behind) **[uncited]**.

**Reusing the scratch buffer across requests** is only safe if the write to the output sink completed synchronously; a `clear()` while a buffered NDJSON writer still holds a reference is a use-after-clear class of bug. Reuse, but ensure ownership is exclusive per write **[uncited]**.

**Toolchain pin.** Benchmark numbers are only comparable under the pinned toolchain and release profile (`lto=fat`, `codegen-units=1`, `panic=abort`, `strip=true`); a debug build will mislead on every axis in §4 **[uncited]**.

---

## 4. Benchmark fixture spec (1 / 10 / 100 MB)

Design the fixtures so the three axes — peak RSS, wall time, bytes-serialized — can each move independently and be attributed.

**Generators (synthetic, deterministic, no fixtures checked in):**

| Size | Generator | Lines | Shape notes |
|---|---|---|---|
| 1 MB | `seq 1 100000` padded, or a std generator emitting fixed-width records | ~10^5 | fits in the legacy accumulator; regression baseline should be *absent* here |
| 10 MB | same generator, wider records | ~10^6 | the interesting band: exceeds 2000-line/50KB accumulator by 200× |
| 100 MB | `yes` piped through `head -c 104857600`, plus a `seq` variant | ~10^7 | isolates pure throughput; tests spill eviction and TTL paths |

Add three *shapes* per size, because they exercise different code paths: (a) uniform text lines; (b) one giant line (tests the pending-buffer cap); (c) error-dense output to **stderr** mixed with content on stdout (tests candidate ring + post-hoc priority + two-file spill). Also add a `panic`-producing child and a child that exits non-zero after 100 MB of chatter, since the exit-code-correlates-with-priority rule is only observable there **[uncited]**.

Prefer `seq`/`head`/`yes` for the canonical cases: they are present on both macOS and Linux, they are the reported regression (`seq 50000`), and being trivial external programs they keep the measurement about pibash, not about the generator **[uncited]**.

**Measurement protocol:**

- **Peak RSS**: Linux `getrusage(RUSAGE_SELF).ru_maxrss` (KiB) via raw `extern "C"` — which is already the accepted calling convention in this codebase for `setpgid`. macOS reports `ru_maxrss` in **bytes**, not KiB: same field, different unit, a classic cross-platform measurement bug **[uncited]**. Report both the daemon process and the forked child so attribution is unambiguous. Sample `/proc/<pid>/status` VmHWM only on Linux, as a cross-check, never as the primary.
- **Wall time**: `Instant` around the full request; report p50/p95 over N≥20 iterations, and separately report *time to first byte of envelope* so the streaming benefit is visible even when total time is unchanged.
- **Bytes serialized**: instrument the serializer with a counting wrapper around the sink (§1 stage 4), plus a counter of total child bytes read and total spill bytes written. The three-way ratio `child_bytes : spill_bytes : envelope_bytes` is the headline metric — the regression claim is that today `envelope_bytes ≈ child_bytes` and the target is `envelope_bytes ≈ budget`.
- **Serialization-path A/B** (added because §2 Q3 shows the choice is empirical): measure `to_writer`→reused `Vec<u8>`+one write, versus `to_string`+one write, versus `to_writer`→raw socket with and without an outer `BufWriter`. Four cells, same envelope content. This is what settles the inversion case for *this* envelope rather than trusting a forum report.
- **Cold vs warm cache**: run both. Cold = drop the spill directory and (where permissible) use a fresh temp dir; warm = repeat immediately. On Linux, cache-dropping needs privileges, so "cold" realistically means "first run after daemon restart" — state that in the report rather than claiming true cold page cache **[uncited]**. The point of the split is to separate JSON-escaping cost (cache-insensitive) from spill I/O (cache-sensitive).
- **Platform matrix**: run the full suite on Linux *and* macOS, and record the observed pipe capacity on each. The macOS result is not optional — per §3, macOS is the platform where pipe-capacity divergence bites (https://christiantietze.de/posts/2025/03/process-pipe-64kib-limit).
- **Regression guard**: a `seq 50000` case asserted to have `envelope_bytes <= budget * 1.1` and `peak_rss <= fixed_constant` (no `O(n)` term). A test that only asserts wall time will silently pass while retention creeps back.

**[uncited]** — the generator table, protocol, and units caveat above are recommended practice, not drawn from the cited material.

---

## 5. Node-side handoff

The envelope crosses into the extension, and that hop is not free by default. Node's `child_process` exposes child output as a stream, and its documented `maxBuffer` option means a naive `exec`-style call buffers and then *kills* the child when the limit is exceeded (https://nodejs.org/api/child_process.html) — so the Rust side must be read as a stream, not via a buffering API, or the daemon's own bounded-output work is undone at the boundary. Once the payload is a whole string, `JSON.parse` on a large document is the documented anti-pattern that streaming parsers exist to avoid (https://faizahmed.in/streaming-huge-json-in-nodejs) and the broader catalogue of large-JSON handling patterns says the same (https://medium.com/@jsdevspace/handling-large-json-files-in-node-js-ea3a3be0a473). Backpressure is the operative mechanism: stream with bounded read buffers (64 KB is the figure commonly cited) and honor `pause`/`resume` so a slow consumer does not cause unbounded buffering — production writeups report processing ~10 GB in ~80 MB RSS this way (https://dev.to/axiom_agent/nodejs-streaming-in-production-backpressure-pipelines-and-memory-efficient-processing-2ilh).

Design consequence: because the envelope is capped at the model-visible budget, the Node side parses a small document regardless of child output size — which is the payoff of the whole change, and the reason the spill reference must be a *path*, not embedded text. Verify in §4 that the Rust-side measurement is not simply moved to the Node side.

---

## 6. Implementation checklist (ordered, testable)

Each step is independently shippable and independently revertible; the fail-open ladder means no step can break the session.

1. Add `bounded::Ring` (capacity + `push_bounded`) with unit tests proving memory never exceeds capacity across 10^7 pushes.
2. Add the byte-level line splitter with a capped `pending` buffer; test with non-UTF-8 input and a 10 MB single line.
3. Introduce candidate capture alongside the existing accumulator behind a flag; assert candidate output equals the current compaction output on the existing test corpus. This is the equivalence gate — do not delete the old path until it passes.
4. Add the lazy spill writer (`BufWriter::with_capacity`) writing chunks as read; verify spill bytes equal child bytes on all three shapes.
5. Run the §4 serialization A/B (four cells) and pick the winner on evidence, not on prior.
6. Switch envelope construction to the chosen single-pass shape; assert byte-identical envelope to the old path for the small/medium fixtures, then measure.
7. Delete the old full-stream accumulator and the legacy tail serializer; delete the equivalence flag.
8. Add fixtures + RSS/envelope-byte assertions to the benchmark harness, on Linux and macOS.

---

## 7. Gaps

- **Magnitude of the `to_writer` win over `to_string` remains unsettled** — and the supplied material now points in *both* directions: qualitative large-payload guidance favours `to_writer` (https://reintech.io/blog/serde-tutorial-json-serialization-deserialization-rust), while a reported case has `String`-then-one-write winning over `to_writer`'s small writes (https://users.rust-lang.org/t/why-does-serializing-a-struct-to-a-string-result-in-much-faster-write-speeds/80579). No primary benchmark isolates *this* envelope's shape. §4's four-cell A/B is the only trustworthy answer; until it runs, the design's reused-`Vec<u8>` choice is reasoned, not proven.
- **Pipe capacity on macOS is sourced but not measured here.** 16 KiB default / 64 KiB on demand comes from a 2025 writeup (https://christiantietze.de/posts/2025/03/process-pipe-64kib-limit) and the hang report corroborates the failure mode (https://forum.cursor.com/t/bug-stdio-mcp-server-hangs-on-macos-when-response-8-kb-pipe-buffer-exhaustion/158804), but neither is a primary Apple source, and capacity varies by OS version. Measure on target hardware.
- **The exact set of filesystems where splice is fast, and whether it would help pipe→file at all,** is not established here; Torvalds' design remarks establish that support is conditional (https://yarchive.net/comp/linux/splice.html), not the per-filesystem matrix.
- **No source measures this harness's Node/NDJSON hop.** §5 establishes the *class* of risk (`maxBuffer`, whole-payload `JSON.parse`, backpressure) from Node's docs and production writeups, but the actual copy count across the Rust→Node boundary, and whether the extension re-stringifies the envelope, is unmeasured. If it does, roughly half the win evaporates.
- **`BufWriter`'s 8 KiB default and macOS `ru_maxrss` units** are asserted from general knowledge, not from a cited std/Apple source; confirm against the pinned toolchain's std docs before encoding them in assertions.
- **Ring-vs-head budget arithmetic is unspecified** by any source; treat the inequality in §3 as a design invariant to validate with the fixture shapes.
- **The RustConf talk's content is inferred from its title.** Only the structural claim (serializer-as-state-machine over a writer) is attributed, and that attribution is a summary, not a quote.
- **Spill TTL / eviction policy has no source.** It is a lifecycle requirement invented for this architecture; validate empirically against a long-running session.
- **Unverified whether the existing 2000-line/50KB accumulator constants remain the right bound** once capture is streaming — they were tuned for a retain-then-compact model and may need re-deriving from the model-visible budget alone.
- **Single-line-overflow handling** (the pending-buffer cap) is the least-sourced part of the design; no reference addresses it directly, and it is the likeliest place for a residual O(n) blowup.

---

## 8. Sources

1. [Streaming Millions of Rows to Disk: Rust File I/O Patterns for High-Volume Data Pipelines](https://medium.com/@adamszpilewicz/streaming-millions-of-rows-to-disk-rust-file-i-o-patterns-for-high-volume-data-pipelines-f5dd9dc97d1c) — write-as-you-read streaming to disk; buffered I/O to absorb syscall cost; the argument against materializing-then-writing.
2. [Efficiently Processing Gigantic JSON Objects with Rust, Serde](https://www.ixpantia.com/en/blog/json-with-rust-serde-tokio) — incremental processing with a bounded working set; streaming vs whole-document framing.
3. [Zach Brown, RustConf lightning talk: Implementing a High Performance Serialization Library](https://www.youtube.com/watch?v=kda0CeL9P0M) — serializer as a state machine over a `Write`; writer boundary as the place where copies are eliminated.
4. [Parsing and Serializing Large Objects using JSONStream in Node.js](https://www.bennadel.com/blog/3232-parsing-and-serializing-large-objects-using-jsonstream-in-node-js.htm) — streaming serialization avoiding whole-object materialization; cross-language framing of the same principle.
5. [Zero-Copy in Linux with sendfile() and splice()](https://blog.superpat.com/zero-copy-in-linux-with-sendfile-and-splice) — sendfile/splice mechanics, pipe requirement, EINTR retry and short-write accounting; basis for ruling zero-copy out.
6. [Implementing Zero-Copy I/O using sendfile and splice](https://howtech.substack.com/p/implementing-zero-copy-io-using-sendfile) — corroborates the mechanics and the retry-loop requirement; portability limits.
7. [How to process output of running command and clean up when done](https://users.rust-lang.org/t/how-to-process-output-of-running-command-and-clean-up-when-done/72019) — `wait()`-before-drain deadlock; concurrent stdout/stderr reading then join.
8. [Serde tutorial — JSON serialization/deserialization in Rust](https://reintech.io/blog/serde-tutorial-json-serialization-deserialization-rust) — `to_string` vs `to_writer` guidance by payload size.
9. [Faster Rust serialization](https://mo8it.com/blog/faster-rust-serialization) — serialization benchmarks including manual encoding; buffer strategy dominates API choice.
10. [Why does serializing a struct to a String result in much faster write speeds?](https://users.rust-lang.org/t/why-does-serializing-a-struct-to-a-string-result-in-much-faster-write-speeds/80579) — the inversion case: `String`-then-one-write beating `to_writer`'s many small writes.
11. [Process pipe 64KiB limit (macOS)](https://christiantietze.de/posts/2025/03/process-pipe-64kib-limit) — macOS 16 KiB default pipe buffer, 64 KiB on demand.
12. [Bug: stdio MCP server hangs on macOS when response exceeds pipe buffer](https://forum.cursor.com/t/bug-stdio-mcp-server-hangs-on-macos-when-response-8-kb-pipe-buffer-exhaustion/158804) — real-world macOS stdio hang from pipe-buffer exhaustion.
13. [IPC buffer sizes across operating systems](https://www.netmeister.org/blog/ipcbufs.html) — per-OS IPC buffer survey for cross-platform sizing assumptions.
14. [HN discussion: Linux pipe buffer sizing and fcntl](https://news.ycombinator.com/item?id=39677853) — 64 KiB default, fcntl raising it, system maximum.
15. [Yarchive: Torvalds on splice design](https://yarchive.net/comp/linux/splice.html) — splice support is filesystem-dependent; not a general primitive.
16. [sendfile vs splice: socket-focused vs generalized zero-copy](https://www.youtube.com/watch?v=FopM7wWvKbc) — framing of the two mechanisms and their scope.
17. [Node.js child_process documentation](https://nodejs.org/api/child_process.html) — `maxBuffer`, stdout as a stream, buffering API hazards at the boundary.
18. [Streaming huge JSON in Node.js](https://faizahmed.in/streaming-huge-json-in-nodejs) — `JSON.parse` on huge payloads as an anti-pattern.
19. [Node.js streaming in production: backpressure pipelines](https://dev.to/axiom_agent/nodejs-streaming-in-production-backpressure-pipelines-and-memory-efficient-processing-2ilh) — backpressure, 64 KB read buffers, ~10 GB in ~80 MB RAM.
20. [Handling large JSON files in Node.js](https://medium.com/@jsdevspace/handling-large-json-files-in-node-js-ea3a3be0a473) — catalogue of large-JSON handling patterns.
