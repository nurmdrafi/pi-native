# piread micro-bench — 2026-10-19

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.238 | 0.358 | 0.101 | 0.172 | -0.137 | 3.268 | 6.424 |
| crlf | 0.395 | 2.744 | 0.109 | 0.172 | -0.286 | 3.148 | 4.382 |
| unicode | 0.328 | 0.968 | 0.079 | 0.117 | -0.250 | 3.122 | 4.695 |
| long-lines | 0.268 | 0.377 | 0.106 | 0.481 | -0.161 | 3.253 | 5.128 |
| lines2500 | 1.383 | 1.867 | 0.576 | 0.797 | -0.807 | 3.899 | 6.316 |
| bytes60k | 0.617 | 0.802 | 0.571 | 1.139 | -0.046 | 3.854 | 5.117 |
| head60k | 0.460 | 1.033 | 0.189 | 0.357 | -0.270 | 3.580 | 4.811 |

## Spawn floor — bare `--version` (N=200)

p50 3.399 ms · p95 5.776 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: 171 MB · piread (node side, daemon excluded): 156 MB · oneshot: 162 MB · daemon itself (VmHWM after 200-read soak): 2 MB

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
