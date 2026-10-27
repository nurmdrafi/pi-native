# piread micro-bench — 2026-10-15

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.316 | 0.514 | 0.100 | 0.194 | -0.216 | 3.316 | 4.852 |
| crlf | 0.320 | 0.529 | 0.081 | 0.147 | -0.239 | 3.218 | 4.194 |
| unicode | 0.279 | 0.491 | 0.068 | 0.107 | -0.211 | 3.208 | 4.233 |
| long-lines | 0.303 | 0.650 | 0.090 | 0.195 | -0.212 | 3.236 | 4.118 |
| lines2500 | 0.970 | 1.956 | 0.496 | 0.789 | -0.474 | 3.855 | 5.218 |
| bytes60k | 0.764 | 1.135 | 0.714 | 1.111 | -0.050 | 4.375 | 5.663 |
| head60k | 0.382 | 0.728 | 0.233 | 0.367 | -0.149 | 3.888 | 5.114 |

## Spawn floor — bare `--version` (N=200)

p50 3.567 ms · p95 4.478 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: 170 MB · piread (node side, daemon excluded): 159 MB · oneshot: 157 MB · daemon itself (VmHWM after 200-read soak): 2 MB

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
