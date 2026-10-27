# piread micro-bench — 2026-10-27

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.302 | 0.527 | 0.086 | 0.239 | -0.216 | 3.823 | 5.434 |
| crlf | 0.296 | 0.542 | 0.070 | 0.185 | -0.227 | 3.640 | 5.037 |
| unicode | 0.323 | 0.694 | 0.074 | 0.216 | -0.250 | 3.534 | 4.835 |
| long-lines | 0.292 | 0.432 | 0.098 | 0.170 | -0.193 | 3.755 | 5.717 |
| lines2500 | 0.782 | 1.510 | 0.389 | 0.719 | -0.393 | 4.369 | 5.843 |
| bytes60k | 0.515 | 0.911 | 0.449 | 0.690 | -0.065 | 4.417 | 5.554 |
| head60k | 0.431 | 0.720 | 0.167 | 0.264 | -0.264 | 4.027 | 5.106 |

## Spawn floor — bare `--version` (N=200)

p50 3.804 ms · p95 5.140 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: unavailable · piread (node side, daemon excluded): unavailable · oneshot: unavailable · daemon itself (VmHWM after 200-read soak): 2 MB

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
