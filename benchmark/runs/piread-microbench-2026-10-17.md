# piread micro-bench — 2026-10-17

Host darwin arm64 · node v24.3.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.126 | 0.158 | 0.033 | 0.050 | -0.092 | 1.885 | 2.365 |
| crlf | 0.121 | 0.147 | 0.040 | 0.055 | -0.081 | 1.846 | 2.367 |
| unicode | 0.123 | 0.147 | 0.039 | 0.052 | -0.083 | 1.915 | 2.577 |
| long-lines | 0.128 | 0.170 | 0.054 | 0.089 | -0.074 | 1.888 | 2.502 |
| lines2500 | 0.355 | 0.415 | 0.171 | 0.185 | -0.184 | 2.064 | 2.580 |
| bytes60k | 0.215 | 0.246 | 0.167 | 0.199 | -0.048 | 2.007 | 2.515 |
| head60k | 0.170 | 0.214 | 0.062 | 0.067 | -0.107 | 1.877 | 2.270 |

## Spawn floor — bare `--version` (N=200)

p50 1.783 ms · p95 2.071 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: 207648 MB · piread (node side, daemon excluded): 184576 MB · oneshot: 186448 MB · daemon itself (VmHWM after 200-read soak): skipped (non-Linux)

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
