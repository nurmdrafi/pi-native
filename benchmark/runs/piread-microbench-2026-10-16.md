# piread micro-bench — 2026-10-16

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.279 | 0.448 | 0.073 | 0.118 | -0.206 | 3.294 | 4.335 |
| crlf | 0.285 | 0.451 | 0.080 | 0.125 | -0.205 | 3.163 | 4.202 |
| unicode | 0.282 | 0.426 | 0.077 | 0.109 | -0.205 | 3.159 | 4.004 |
| long-lines | 0.265 | 0.356 | 0.097 | 0.185 | -0.168 | 3.222 | 4.048 |
| lines2500 | 1.037 | 1.696 | 0.485 | 0.742 | -0.552 | 3.804 | 4.885 |
| bytes60k | 0.687 | 1.615 | 0.873 | 1.242 | +0.186 | 4.327 | 5.685 |
| head60k | 0.360 | 0.540 | 0.178 | 0.279 | -0.183 | 3.792 | 4.801 |

## Spawn floor — bare `--version` (N=200)

p50 3.552 ms · p95 4.462 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: 172 MB · piread (node side, daemon excluded): 156 MB · oneshot: 158 MB · daemon itself (VmHWM after 200-read soak): 2 MB

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
