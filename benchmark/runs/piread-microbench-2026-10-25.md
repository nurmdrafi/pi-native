# piread micro-bench — 2026-10-25

Host darwin arm64 · node v24.3.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.130 | 0.199 | 0.052 | 0.104 | -0.078 | 1.921 | 2.633 |
| crlf | 0.133 | 0.221 | 0.041 | 0.059 | -0.092 | 1.894 | 2.436 |
| unicode | 0.128 | 0.179 | 0.042 | 0.067 | -0.086 | 1.884 | 2.396 |
| long-lines | 0.129 | 0.152 | 0.046 | 0.057 | -0.083 | 1.881 | 2.371 |
| lines2500 | 0.361 | 0.494 | 0.179 | 0.224 | -0.182 | 2.053 | 2.590 |
| bytes60k | 0.221 | 0.371 | 0.170 | 0.213 | -0.051 | 2.066 | 2.617 |
| head60k | 0.182 | 0.342 | 0.064 | 0.087 | -0.118 | 1.896 | 2.406 |

## Spawn floor — bare `--version` (N=200)

p50 1.795 ms · p95 2.312 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: 197504 MB · piread (node side, daemon excluded): 185600 MB · oneshot: 186624 MB · daemon itself (VmHWM after 200-read soak): skipped (non-Linux)

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
