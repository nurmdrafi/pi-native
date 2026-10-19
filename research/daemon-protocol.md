# NDJSON stdio daemon protocol: design notes and v1 spec

Status: draft, pre-implementation. Scope: the four Rust tool daemons (`piread`, `piedit`, `pibash`, `pidx`), their `--serve` NDJSON mode, the one-shot CLI fallback, and the Node extension side that talks to them.

Constraints carried into every decision: Rust, std-only (no Tokio, no async runtime on the daemon side); Node on the client side; serial in-order processing today; one daemon per tool, each with a tool-specific request shape; fail-open ladder (any daemon failure falls back to the CLI path, the session never breaks).

Provenance note: no search or exec tool was available in this session, so nothing new was fetched. Every claim below rests either on the material supplied with the task (cited by URL in Sources) or on [uncited] general knowledge of JSON-RPC/LSP/MCP/Unix process semantics. Facts that are [uncited] are marked inline where they would otherwise look like citations. Claims about exact normative wording (MUST vs SHOULD) in the LSP and MCP specs should be re-verified against the live documents before this brief is treated as authoritative.

---

## 1. Recommended protocol v1

### 1.1 Framing

One JSON object per line, UTF-8, `\n` terminated, no embedded newlines. This is NDJSON and it is a deliberate divergence from LSP/MCP, both of which use `Content-Length`-prefixed headers over a byte stream (`Content-Length: N\r\n\r\n<body>`) — [uncited] for the exact header format, though the LSP spec URL given is the owner of that rule. Choosing NDJSON buys three things here:

- The client is Node and the daemon is Rust std; both can read a line without a buffered header parser. `Content-Length` exists because the underlying transport is a general byte stream and JSON-RPC permits non-line-oriented transports; for a private, same-machine, JSON-only channel that benefit does not pay for the parser.
- Large results are never inline (they spill to a file, see 1.5), so lines stay small in practice. Still cap each inbound line (suggest 8 MiB) and treat an overlong line as `MALFORMED_REQUEST` followed by daemon exit — a bounded read is the std-only way to avoid an unbounded allocation on a hostile or buggy peer.
- Tail truncation on daemon death is detectable: a final line without `\n` is a dead-pipe signal, not a message (section 4).

`id` is a string (client-chosen, e.g. `"c17"`). Strings rather than numbers because JSON numbers hit float round-trip subtleties on the JS side and because string ids compare and log unambiguously. [uncited]: JSON-RPC 2.0 permits either; MCP uses `string | number`.

### 1.2 Envelope

Request:

```json
{"v":1,"id":"c17","tool":"piread","op":"read","params":{"path":"src/lib.rs","offset":1,"limit":120}}
```

Success:

```json
{"v":1,"id":"c17","ok":true,"result":{"text":"...","truncated":true}}
```

Failure:

```json
{"v":1,"id":"c17","ok":false,"error":{"code":"TIMEOUT","kind":"timeout","message":"read exceeded 5000ms","retryable":true,"tool":"piread","op":"read"}}
```

Refinements on the planned `{v,id,ok,result}`:

- Keep the top-level `ok` boolean *and* the error object. `ok` is what a cheap client checks; the object is what a good client logs. JSON-RPC's `result XOR error` rule forces every client to branch on which key exists; an explicit boolean removes that class of bug for one field.
- Echo `tool`/`op` in the error object only. Echoing them in every success response doubles hot-path bytes for information the client already knows (it sent the id). In errors, where frequency is low, they make a log line self-describing.
- Never reuse an id within a connection lifetime. The client owns id allocation; the daemon only echoes.
- `result` may carry `spillPath` instead of inline text when a result exceeds the inline cap; the client decides whether to read it.

### 1.3 Handshake

First line the client sends:

```json
{"v":1,"id":"hello","op":"hello","protocol":1,"tool":"piread","client":{"name":"pi-extension","version":"0.9.3"}}
```

Daemon replies:

```json
{"v":1,"id":"hello","ok":true,"result":{"protocol":1,"tool":"piread","version":"0.4.2","pid":8412,"capabilities":["cancel","ping","spill"],"serial":true}}
```

Rules:

- The daemon must reject any frame that precedes `hello` with `NOT_INITIALIZED` and must not process it. This turns an ordering bug into a diagnosable message instead of a mysterious desync.
- Protocol negotiation is exact-match on the integer. No ranges, no minor versions. On mismatch the daemon replies `PROTOCOL_MISMATCH` with `{expected, got, version}` and exits 0 before processing anything else — a version skew is not a binary failure and must not look like one. The client records `protocol_mismatch` (tool, binary path, both versions, both protocol ints) and demotes that binary to the CLI path for the rest of the session, permanently. This is the fail-open ladder doing its job: skew is a routing decision, not a user-facing error.
- Also compare the binary `version` string, but do not gate on it. The protocol integer is the only thing that changes behaviour. Two builds sharing a protocol integer must be interchangeable, which constrains how the daemon evolves (1.8).
- The handshake is the *only* place the daemon writes a frame the client did not ask for by id. Everything else is request/response keyed by `id`, so the client's pending map is the sole source of truth.
- Send the binary version in the payload even though it does not gate behaviour: it is the field you want in the bug report.

Divergence worth stating: LSP's `initialize` carries a large nested `capabilities` tree and is followed by a separate `initialized` notification; MCP's `initialize` carries `protocolVersion`, `capabilities`, `clientInfo` and also requires a client notification before anything else. Both exist because those servers are *plugins* of unknown vintage — the capability tree is a capability intersection, and the second notification exists because real servers warm up in between. Our daemons are four binaries we ship with a closed feature set. So: flat `capabilities` array of strings, no second notification, no negotiation. If a genuinely optional feature appears, bump the integer. Exact field lists and the version-string format are [uncited] here (see Gaps).

### 1.4 Ping / liveness

```json
{"v":1,"id":"p3","op":"ping","params":{}}
```
```json
{"v":1,"id":"p3","ok":true,"result":{"pid":8412,"uptime_ms":412335,"inflight":0}}
```

Cost: one line in, one line out, no allocation beyond the parse — microseconds on a std daemon. The point is not throughput; it is detecting what `write()` cannot:

- Alive but wedged (deadlocked, spinning, blocked on a file on a hung mount). The write succeeds because the pipe buffer has room; only a round trip reveals nothing is reading.
- Exited but not yet noticed. The write may succeed into the pipe buffer; the read returns EOF. EOF, not the write result, is authoritative.
- Restarted itself. That is a protocol violation for us, but `pid` in the ping result makes the case diagnosable instead of mysterious.

Timeout: 250 ms for an idle daemon, because it has nothing else to do. Do **not** ping before every request — narrow the planned "short ping before reusing an idle daemon" to: ping when the daemon has been idle longer than a threshold (suggest 30 s), and before the first request that follows a `piedit`, since an edit is the case most likely to leave a stale view or to have crashed the daemon. Pinging every call doubles frame count for a check that is nearly always trivially true. Never ping a fresh connection; the handshake already proved liveness.

Ping failure is not a user-facing error. Drain the pending map with `DAEMON_UNRESPONSIVE`, kill, route to the CLI path, log once per session.

[uncited] prior art for the name: both LSP and MCP define a `ping` request carrying (at most) an empty params object and returning an empty result, described as a way to confirm the peer is alive, with any timeout treated as caller policy. Adopt the name and semantics; restrict initiation to the client. Neither spec publishes a cost figure; the microseconds claim is an estimate, not a measurement.

### 1.5 Cancel

```json
{"v":1,"id":"c18","op":"cancel","params":{"targetId":"c17","reason":"superseded"}}
```
```json
{"v":1,"id":"c18","ok":true,"result":{"accepted":true,"state":"in_flight"}}
```

Cancelled target's terminal frame:

```json
{"v":1,"id":"c17","ok":false,"error":{"code":"CANCELLED","kind":"cancelled","message":"cancelled by client","targetId":"c17","spillPath":null}}
```

Rules, with provenance:

- **Cancel is a request, not a notification.** Divergence from LSP (`$/cancelRequest` and MCP's cancel are both notifications — [uncited] for the LSP framing, sourced for MCP in section 2). Both use notifications because their transports are full-duplex and their servers need not be prompt, so a lost cancel is tolerable. Here the client needs to know whether the cancel landed *before* the target completes, because the fallback decision differs: if accepted while in flight, do not immediately re-issue on the CLI path (that duplicates the work); if `already_completed`, proceed normally. A request-shaped cancel gives that ordering for free. The ack is immediate and unconditional: reply to `cancel` first, then act.
- **`state` is one of** `in_flight` (found, preemption started), `already_completed` (terminal frame already written), `unknown` (no such targetId). The client treats `unknown` as success — the target is not running.
- **Races resolve at one serialization point.** The daemon holds one `id -> request state` map; `complete(id)` and `cancel(id)` take the same lock (in the serial design, they are the same thread), and whichever wins writes the terminal frame; the loser is a no-op. Result: exactly one terminal frame per id, always.
- **Every cancelled request gets a terminal frame.** MCP leaves the receiver permitted to send no response at all for a cancelled request (section 2); we must not copy that latitude: an unresolvable pending entry is a leak, and over NDJSON the natural client implementation (await the id) hangs until ping kills the daemon. So: always terminal, always `CANCELLED`.
- **Preemption mechanism: SIGTERM, then SIGKILL after a 500 ms grace, because the daemon is serial.** This is the honest consequence of the threading model. In a purely serial daemon the only thread that could service a cancel frame is the one busy doing the cancelled work, so an in-band cancel can only be read *after* the work finishes — useless for preemption. Hence (a) the daemon needs a reader thread separate from the worker so the cancel frame is read while work runs, and (b) preemption is delivered out-of-band as a signal to the process. Killing the daemon to cancel one request is acceptable only if: the pending map is drained into `CANCELLED`/`DAEMON_KILLED` terminal frames so the client never hangs; the client reconnects transparently on the next request (fresh handshake); and spill files owned by the killed request are unlinked before exit. The last needs a `Drop` guard in the worker plus a signal handler that unlinks, since a signal does not by itself unwind the stack.
- **`retainSpill`.** If the original request set `params.retainSpill: true`, the spill file survives and the terminal frame carries `spillPath`, so partial output remains consumable — this matters for `pibash`, where partial stdout of a long command is often the whole point. Otherwise spill files are removed.
- **Initiator rules.** Client only. The daemon never sends a cancel to the client; there is nothing on the client side to cancel. Stricter than MCP, which permits cancellation in either direction, and correct here.
- **Reference validity.** A cancel MUST name a request the client previously issued, and a client SHOULD NOT cancel an id it no longer tracks — this is MCP's rule, restated in section 2 from the supplied spec URL. The receiver tolerates violations: `unknown` is benign, not an error.

### 1.6 Errors

Two orthogonal axes; conflating them is the common mistake.

**`code`** — stable, closed enum string. Client code branches on it; meaning never changes within a protocol integer.
**`kind`** — coarse class used for policy (retry? fall back? surface?), derived from `code`, so a policy table can be written once without enumerating codes.

| code | kind | retryable | meaning | client action |
|---|---|---|---|---|
| `NOT_INITIALIZED` | protocol | no | frame before `hello` | bug; kill, fallback, record |
| `PROTOCOL_MISMATCH` | protocol | no | `v`/`protocol` disagreement | fallback, record, demote binary |
| `MALFORMED_REQUEST` | invalid | no | unparseable line, missing `op`/`id`, bad param types | log, fallback this call |
| `UNKNOWN_OP` | invalid | no | op outside this tool's surface | log, bug |
| `UNKNOWN_TOOL` | invalid | no | `tool` does not match the daemon | log, bug |
| `UNKNOWN_ID` | invalid | no | `cancel` targeting nothing | treat as not-running |
| `DUPLICATE_ID` | invalid | no | id already in flight | client bug; drop new |
| `INVALID_PARAMS` | invalid | no | params failed the tool's schema | surface to caller |
| `NOT_FOUND` | domain | no | file/symbol/hit absent | often `ok:true` with empty result instead |
| `PERMISSION_DENIED` | domain | no | fs/sandbox refusal | surface |
| `TIMEOUT` | runtime | yes | the daemon's own deadline elapsed | retry or fallback |
| `CANCELLED` | runtime | no | client cancelled | none; do not re-issue |
| `OVERLOADED` | runtime | yes | bounded queue full (once concurrency exists) | back off, retry |
| `IO_ERROR` | runtime | maybe | read/write/fs failure in the daemon | likely fallback |
| `INTERNAL` | bug | no | panic caught, invariant broken | fallback, log |
| `DAEMON_UNRESPONSIVE` | transport | yes | **client-synthesized**, ping timed out | kill, fallback, retry |
| `DAEMON_KILLED` | transport | yes | **client-synthesized**, EOF or partial line | reconnect, fallback, retry |
| `SPAWN_FAILED` | transport | no | binary missing / not executable | fallback, log |

Points that matter:

- **Timeout and cancel are different codes**, not one code with a flag: different causes, different client responses (timeout may be retried, cancel must not be), different log queries. One extra enum entry is cheaper than an overloaded boolean.
- **Client-synthesized codes are part of the protocol.** `DAEMON_UNRESPONSIVE`, `DAEMON_KILLED`, `SPAWN_FAILED` never come off the wire, but the client must emit envelopes indistinguishable from daemon ones so the tool layer has one code path. Document it or every consumer reinvents it.
- **JSON-RPC numeric codes are not copied.** [uncited]: JSON-RPC 2.0 defines a small set (`-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, with `-32000..-32099` reserved for implementation-defined codes). They are designed for cross-vendor interop we do not need, and an implementation-defined band is exactly the ambiguity we are trying to remove; string codes are self-describing in logs. Keep the concepts, drop the numbers.
- A `TIMEOUT` must kill the work, not just reply — otherwise a serial daemon keeps executing something nobody wants. With signal preemption this is the same machinery as cancel.
- `message` is for humans and must never be parsed. `details` (optional object) carries structured fields per code (`timeoutMs`, `path`, `expected`/`got`).

### 1.7 No interleaving and id matching

One writer thread (the worker) plus one reader thread makes line framing atomic by construction: the writer builds the whole line in memory and issues one `write_all`. Frames are never spliced. The invariants to state and test:

- **Terminal uniqueness**: for each id, exactly one terminal frame, and it is the last frame mentioning that id.
- **Attribution**: each terminal frame's `id` matches what the client sent; error frames carry matching `tool`/`op`.
- **No ordering guarantee across ids** once concurrency lands. Clients key by id, never by arrival position. Say this explicitly so nobody writes a positional FIFO.
- Non-terminal frames (e.g. a future `{"id":...,"event":"progress"}`) must carry a distinct marker so a client waiting on terminal frames cannot mistake them.

Note what is *not* claimed: stream-level atomicity of bytes does not follow from NDJSON. It follows from the single-writer discipline. If a second thread ever writes to stdout, interleaved partial lines become possible and the whole scheme breaks; enforce it by structurally owning stdout in one place rather than by convention.

### 1.8 Versioning policy

- `v` and `protocol` are the same integer; `v` exists so every frame is self-describing even when read out of order in a log.
- Additive only within an integer: new `op`, new optional `params` field, new error `code`, new optional result field. A client that does not know a code falls back on `kind`.
- Removing a field, changing a type, changing an error's meaning, or changing serial/concurrent behaviour bumps the integer.
- The one-shot CLI accepts the same `params` as the daemon `op` and emits the same result JSON. The fail-open path must be a genuine substitute, not a second implementation: the CLI is the worker function inlined without the framing — same code, different entry.

---

## 2. Q1 — Cancellation semantics in LSP and MCP

**LSP.** Cancellation is a notification carrying the id of the request to cancel. The supplied spec URL gives the framing rule that the client should cancel when a result "is not of any use anymore". [uncited] detail: the notification is `$/cancelRequest`, a server that has started processing should cancel and return `RequestCancelled` (`-32800`), and a request that had not started may be answered `RequestCancelled` too. Copy: the request-id reference (cancel names a target and carries no payload), and the fact that the cancelled request still gets a response tied to its own id, so the pending table always resolves. Avoid: notification framing (no ack, no client-side ordering knowledge) and the "if it started to process" latitude — a server may legally have replied already, so the client can only learn the race outcome by keeping the entry alive until a response arrives.

**MCP.** Per the supplied cancellation spec: cancellation is a notification, not a request; the receiver should stop processing and free associated resources; a cancellation MUST only reference requests previously issued by the sender that are still in progress and whose ids are valid; a sender should not cancel something it no longer tracks; and because of the unavoidable race between cancel and completion, best-effort is the documented contract. Copy the reference-validity rule (it is why `unknown` must be a benign state). Avoid the allowance for not responding at all to cancelled work — that is exactly the pending-map leak described in 1.5.

**Library prior art.** Per the supplied `go.lsp.dev/jsonrpc2` URL: `CancelHandler` wraps a handler with cancellation support, and the request object and its `Params` are valid only until the handler returns — the handler owns that lifetime and callers must not retain them. That lifetime rule is the real content: in a server, cancellation is a per-request abort token the handler cooperatively observes, and everything reachable from the request dies with the handler. The std-Rust analogue is a per-request `Arc<AtomicBool>` checked at loop boundaries (between read chunks, between line iterations), plus the out-of-band signal for the call that never reaches a boundary. If the daemon gains threads, this becomes the `thread::spawn` problem precisely: std Rust cannot abort a thread [uncited, std semantics], so cooperative checks inside long loops are mandatory and process-level kill is the only hard backstop.

| aspect | LSP | MCP | our v1 |
|---|---|---|---|
| framing | notification ([uncited] `$/cancelRequest`) | notification (supplied spec) | request (acked) |
| id reference | target request id | `requestId` (+ reason) | `params.targetId`, `params.reason` |
| unknown id | undefined | sender MUST NOT; receiver may ignore | allowed, `state:"unknown"` |
| races | server may have replied already | documented as unavoidable | one serialization point, one terminal frame |
| initiator | client only | either direction | client only |
| cancelled request gets a response | yes, `RequestCancelled` ([uncited] code) | not required | always |

---

## 3. Q2 — Handshake and version negotiation

**LSP `initialize`.** [uncited] field detail, consistent with the supplied spec URL: request carries `processId`, `clientInfo`, `rootUri`/`workspaceFolders`, `capabilities`, `trace`, `initializationOptions`; the response carries server `capabilities` and `serverInfo`; then the client sends `initialized`, and only after that may it issue other requests (a request before init is answered `-32002`). The design is a capability *intersection* — neither side fails on mismatch, they advertise and use the overlap — because the server may be a third-party binary of unknown vintage.

**MCP `initialize`.** [uncited] field detail, consistent with the supplied MCP spec tree: request carries `protocolVersion`, `capabilities`, `clientInfo`; the response states the single `protocolVersion` the server will use plus its `capabilities`, `serverInfo` and optional `instructions`; the version is a date string; the client accepts that version or disconnects; there is no range negotiation. Then the client sends its initialized notification.

**Copy**: the handshake is a request/response on the same stream as everything else (no second transport to keep in sync); reject-before-init as a distinct error code; echo the negotiated version so both sides record the same decision; include the binary version for diagnostics.

**Avoid**: LSP's capability tree (pointless for four first-party closed-surface binaries — a flat array suffices); MCP's date-string versions (they encode a documentation freeze date, making compatibility a human judgement rather than a machine-checkable integer); the mandatory second notification (it exists for real servers' warm-up; ours either warm up inside `hello` handling, so the reply implies readiness, or lazily on first use).

**Failure behaviour**: mismatch → `PROTOCOL_MISMATCH` with `expected`/`got`/`version`, then exit 0. Client-side, mismatch is terminal for that binary in that session: record, never retry the daemon, use CLI. Most protocols would renegotiate down; we do not, because the fallback path is right there and renegotiation code is where bugs live.

---

## 4. Q3 — Liveness for stdio servers

Failure modes and their detectors:

1. **Exited cleanly.** Read returns EOF. [uncited, Unix semantics]: Rust ignores `SIGPIPE` and surfaces `EPIPE` on write to a pipe with no readers, but EOF on the read end is authoritative. Map both to `DAEMON_KILLED`.
2. **Zombie (exited, unreaped).** Same EOF, but the pid lingers, so a signal-0 liveness probe *succeeds*. Do not use signal-0 probing as the liveness test — it is the obvious implementation and it silently passes for zombies.
3. **Alive but wedged.** No EOF, no output, writes succeed into the buffer. Only a round-trip timeout catches it. This is what ping is for.
4. **Alive but spinning.** Ping may still answer; only a per-op deadline catches it. Every op needs its own timeout even with a healthy ping.
5. **Half-dead pipe.** Single duplex pipe (child stdin/stdout) makes half-death unlikely, but a closed stdout with stdin open is possible if something closes fd 1. The daemon holds fd 1 deliberately and never closes it; the client treats stdout EOF as death regardless of stdin health.

Cost and backpressure: ping is one line each way; at a 30 s idle threshold the amortized cost is negligible. [uncited] pipe buffer sizes (64 KiB Linux, ~16 KiB macOS) mean a wedged daemon's stdin eventually fills and `write_all` blocks — so the *client* must also put a deadline on writes, or a wedged daemon stalls the Node extension. Treat a stalled write as `DAEMON_UNRESPONSIVE`.

No published measurement of stdio-ping cost was available in the supplied material; the estimate above is reasoning, not data (see Gaps).

---

## 5. Q4 — Serial vs threaded processing

Head-of-line blocking matters when latency is heavy-tailed, when more than one caller can issue concurrently, and when a stall costs more than concurrency. Per daemon:

- `piread`, `piedit`, `pidx`: short, local, bounded by a file or an index lookup; narrow latency distribution. Serial is correct. `pidx`'s full-tree scan is the one long tail; if it becomes a problem the answer is a deadline (`TIMEOUT`), not a thread pool, because the caller can fall back.
- `pibash`: arbitrary commands, unbounded duration, streaming output, must be killable. Running it in-band blocks every other op on that daemon including `ping` and `cancel`, and makes cancellation structurally impossible (1.5). This is the strongest argument for the dedicated path.

Arguments on the table:

- **Thread-per-core** (supplied: without.boats) argues for a fixed number of threads with better locality and cheaper cross-core communication over work-stealing schedulers, aimed at throughput-bound, mostly independent work. It argues *against* work-stealing pools, not for unbounded threads. Relevance here is limited: no throughput problem, no async runtime to run on those threads.
- **Async runtimes delegate stdio to blocking threads anyway** (supplied: developerlife). A stdio server on an async runtime ends up with a blocking reader underneath, because stdio is not uniformly pollable. The async win evaporates at the transport boundary; what remains is structured cancellation, which we are paying for with signals. Under the std-only constraint that trade is already made, and the prior art supports rather than undermines it.
- **Multi-threaded server basics** (supplied: reintech): canonical pool = bounded channel plus fixed workers, straightforward in std. Import the *bounded* part: an unbounded queue turns a slow daemon into an OOM.

Refined recommendation:

1. Reader thread + worker thread, both std, in every daemon. Not for parallelism — for cancel and ping responsiveness. This is a small change from "serial" in the sense that matters: still one logical worker, still in-order over the request queue, but now structurally preemptible.
2. `piread`/`piedit`/`pidx`: single worker in-order, bounded queue (say 64) answering `OVERLOADED` on overflow. Long `pidx` scans get a deadline, not a thread.
3. `pibash`: dedicated path — either one process per command (simplest: killable by pid, no daemon state worth keeping) or a daemon with a worker per command routing cancel through the same id map. Since `pibash` is essentially process supervision, **spawn-per-command with the daemon as optional multiplexer** matches the requirement with the least machinery; the kill path is already the cancel path.
4. No general thread pool. The measured problem does not exist yet, and the cancellation story gets worse: std cannot abort a thread, so a worker running a cancelled request occupies a slot until it cooperatively notices.

---

## 6. Q5 — Error taxonomy and id matching under concurrency

Client concurrency across four daemons stresses id matching. Two invariants to test:

- **Terminal uniqueness**: for each id exactly one terminal frame — including the case where cancel and completion race. Test by cancelling under load and counting.
- **Attribution**: each terminal frame carries the id the client sent and matching `tool`/`op`. Trivial with one daemon per tool; not trivial if the daemons are ever multiplexed behind one process, which is the one design change that would justify the `tool` field per frame.

Why `code` and `kind` must stay separate: the tool layer wants "is this a user-visible failure?" (`kind`), the retry logic wants "may I try again?" (`retryable`), the log wants "what exactly happened" (`code`). One field cannot serve three readers; forcing it produces either an over-broad retry policy or an over-narrow one.

---

## 7. Concurrency recommendation (summary)

| daemon | model | rationale |
|---|---|---|
| `piread` | reader thread + single worker, in-order, bounded queue | short, narrow-tail; needs ping/cancel responsiveness, not parallelism |
| `piedit` | same | deterministic order matters for successive edits to one file |
| `pidx` | same, per-op deadline | long tail handled by deadline, not threads |
| `pibash` | spawn-per-command; daemon as optional multiplexer | arbitrary, unbounded work; kill path is the cancel path |

---

## Gaps

- **No new lookups were performed.** No search or exec tool was available this session, so MCP `initialize` field detail, LSP `$/cancelRequest` framing, JSON-RPC's reserved error codes, and any published stdio-ping measurements are tagged [uncited] above. Verify exact MUST/SHOULD wording and MCP's version-string format against the live specs before treating this document as authoritative.
- **Signal preemption unverified against Rust std.** Whether SIGTERM interrupts a blocking `File::read` depends on `SA_RESTART`; a custom handler's flags are our choice. The std-only safe pattern is a self-pipe (handler writes a byte, reader polls it) or Linux `signalfd`; macOS uses `kqueue`/`EVFILT_USER`. Needs a spike before the cancel design is final.
- **Windows not covered.** No signals, no `kill`, different pipe semantics; cancel would need a job object / `TerminateProcess` variant. Record the decision in the repo's portability doc.
- **No measured latency or ping-cost data.** The narrow-tail claim for `piread`/`piedit` and the microseconds claim for ping are arguments, not measurements. Instrument per-op durations and revisit.
- **Client-side Node API choice** (spawn with synchronous vs async reads, write deadlines) is undecided; the write-deadline recommendation assumes a non-blocking path is available without changing the extension's threading model.
- **Spill-file lifecycle** is specified only for the cancel path. Orphans from `SIGKILL` (no cleanup possible) need an age-based sweeper or a per-session temp directory removed at session end.
- **Streaming `pibash` output** (progress frames vs spill-and-read-at-end) is out of scope and is the one genuinely open design question for the `pibash` path.

---

## Sources

1. [Language Server Protocol 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification) — owner of `initialize`, cancellation and code-number rules; contributed the "cancel when the result is not of any use anymore" framing.
2. [MCP specification — Cancellation](https://modelcontextprotocol.io/specification/draft/basic/patterns/cancellation) — contributed notification framing, reference-validity rules, and the best-effort/race caveat.
3. [go.lsp.dev/jsonrpc2](https://pkg.go.dev/go.lsp.dev/jsonrpc2) — contributed `CancelHandler` and the request/`Params` lifetime contract.
4. [Language Server Protocol — Wikipedia](https://en.wikipedia.org/wiki/Language_Server_Protocol) — contributed JSON-RPC basis and editor-agnostic framing.
5. [LSP outside the editor](https://medium.com/@selfint/lsp-outside-the-editor-431f77a9a4be) — contributed the hand-rolled JSON-RPC framing comparison behind the NDJSON choice.
6. [Understanding the Language Server Protocol](https://packagemain.tech/p/understanding-the-language-server-protocol) — contributed message flow and initialize ordering.
7. [An introduction to the Language Server Protocol](https://tamerlan.dev/an-introduction-to-the-language-server-protocol) — contributed the async JSON-RPC processing model.
8. [Thread-per-core](https://without.boats/blog/thread-per-core) — contributed the fixed-thread vs work-stealing argument in section 5.
9. [To Async or Not: Rust MCP server](https://developerlife.com/2026/08/22/to-async-or-not-to-async-rust-mcp-server) — contributed the stdio-on-blocking-threads argument.
10. [Rust concurrency crates](https://lib.rs/concurrency) — `[uncited]`, not used for any claim; candidate bounded-channel/queue implementations.
11. [Building a multi-threaded web server in Rust](https://reintech.io/blog/building-multi-threaded-web-server-in-rust) — contributed the bounded-pool pattern.
