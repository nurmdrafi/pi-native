# Zero init on the hot path

Native tools here pay process start **once per session, not once per call**. Agent toolchains that spawn a helper per invocation — or re-initialize an extension, re-resolve capabilities, or re-negotiate availability on every call — pay an init tax on the hot path by construction. This harness removes that tax architecturally, then measures what is left. Every number below cites the benchmark file and line it came from.

## The ladder is two rungs, never three

Each native tool dispatches through the same ladder ([README.md](../README.md#daemon--one-shot-ladder), line 45; [rust-tools-architecture.md](rust-tools-architecture.md)):

1. **Daemon rung.** A persistent `--serve` process speaking id-matched NDJSON over stdio, lazily started at the first call and restarted on death — one spawn per session, not one per call ([extensions/piread/index.ts](../extensions/piread/index.ts) lines 14–16; [extensions/pibash/index.ts](../extensions/pibash/index.ts) lines 10–14).
2. **One-shot rung.** A single `bin/<tool>` spawn per call, reached only when the daemon transport fails ([extensions/piread/index.ts](../extensions/piread/index.ts) line 17; [extensions/pibash/index.ts](../extensions/pibash/index.ts) line 15). This rung is the failure fallback, never the hot path.

There is no third rung and no functional fallback to a built-in implementation. A hot-path call is one IPC round-trip: one NDJSON request line written to the daemon's stdin ([extensions/piread/index.ts](../extensions/piread/index.ts) line 405), resolved when the id-matched envelope line comes back ([extensions/piread/index.ts](../extensions/piread/index.ts) line 320). No spawn, no handshake, no per-call setup.

## What the hot path costs

The init tax the ladder amortizes is measurable on this host: a bare `--version` spawn — process start plus Rust init of a no-op call — has a p50 of **3.804 ms** (p95 5.140 ms; [benchmark/runs/piread-microbench-2026-10-27.md](../benchmark/runs/piread-microbench-2026-10-27.md) line 21). Every per-call-spawn design pays that on every invocation; the daemon pays it once.

Measured dispatch latency, `piread` vs the in-process built-in oracle, seven corpora ([benchmark/runs/piread-microbench-2026-10-27.md](../benchmark/runs/piread-microbench-2026-10-27.md) lines 11–17):

| corpus | built-in p50 (ms) | daemon p50 (ms) | Δ p50 (ms) | one-shot p50 (ms) |
| --- | ---: | ---: | ---: | ---: |
| one-line | 0.302 | 0.086 | −0.216 | 3.823 |
| crlf | 0.296 | 0.070 | −0.227 | 3.640 |
| unicode | 0.323 | 0.074 | −0.250 | 3.534 |
| long-lines | 0.292 | 0.098 | −0.193 | 3.755 |
| lines2500 | 0.782 | 0.389 | −0.393 | 4.369 |
| bytes60k | 0.515 | 0.449 | −0.065 | 4.417 |
| head60k | 0.431 | 0.167 | −0.264 | 4.027 |

The daemon leads the in-process built-in on every corpus (−0.065 to −0.393 ms p50) while the one-shot rung sits at 3.5–4.4 ms — the spawn floor, paid per call. Writes show the same split at 4 KB: daemon p50 **0.136 ms** vs built-in **0.283 ms** (2.081x) vs one-shot **6.262 ms** ([benchmark/piwrite/results/summary-2026-11-05-rawframe3.md](../benchmark/piwrite/results/summary-2026-11-05-rawframe3.md) lines 14–16, verdict line 18). That ~6 ms one-shot figure is init cost, not work. Payload size is a separate axis — at 1 MB the serve arm trails the built-in (0.214x, line 28 of the same file) — the ladder optimizes dispatch latency, not bulk throughput. The persistent process is cheap to keep: daemon peak RSS is ~2 MB after a 200-read soak ([benchmark/runs/piread-microbench-2026-10-27.md](../benchmark/runs/piread-microbench-2026-10-27.md) line 25).

## No silent failure

A terminal failure — missing binary, spawn failure, bad envelope, bad params, unhandled panic, unparseable daemon output — is a **thrown tool error plus exactly one stderr line**. Rust is the only executor; there is no built-in route to hide a broken binary behind ([extensions/piread/index.ts](../extensions/piread/index.ts) lines 18–22; [extensions/pibash/index.ts](../extensions/pibash/index.ts) lines 15–17; [README.md](../README.md) line 46). A degraded native tool is visible in the first failing call instead of silently masking as a slower built-in.

Choosing pi's built-in tools is explicit configuration decided before dispatch, never a failure path taken mid-call: leave the extension out, or set the permission-gate rules to `off` — P1 `nativeReadFirst` and P2 `nativeBashFirst` ([README.md](../README.md) line 46; [extensions/permission-gate/index.ts](../extensions/permission-gate/index.ts) lines 628 and 879; [extensions/permission-gate/loader.ts](../extensions/permission-gate/loader.ts) lines 65–70). Content-kind routing is likewise up front, not a fallback: image reads stay on the built-in `read` by extension check before any dispatch ([extensions/permission-gate/index.ts](../extensions/permission-gate/index.ts) lines 631–633). Which rung served a call is recorded in `details.via` — observability only, never model-visible content ([extensions/piread/index.ts](../extensions/piread/index.ts) lines 44–46).

## Registration is unconditional

Native tools register unconditionally at extension load: no env switch turns a tool off, and nothing is negotiated per call ([extensions/piread/index.ts](../extensions/piread/index.ts) lines 24–26; [extensions/pibash/index.ts](../extensions/pibash/index.ts) lines 25–28). The tool inventory is fixed when the session starts; the hot path never probes availability or re-asks which executor to use. The permission-gate rule severity is the one switch, and it is read from configuration, not from the call path ([extensions/permission-gate/loader.ts](../extensions/permission-gate/loader.ts) lines 65–70).

Measured speedups and methodology live in [native-tools.md](native-tools.md) and [benchmark/runs/](../benchmark/runs); the architecture deep-dive is [rust-tools-architecture.md](rust-tools-architecture.md).
