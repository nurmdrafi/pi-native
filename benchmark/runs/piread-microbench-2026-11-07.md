# piread micro-bench — 2026-11-07

Host linux x64 · node v24.21.0 · piread 0.2.0 · N=200/arm (10 warmup) · local wall-clock, single process.

Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).

## Dispatch latency (ms)

| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-line | 0.496 | 2.152 | 0.099 | 0.135 | -0.397 | 3.887 | 5.918 |
| crlf | 0.297 | 0.533 | 0.090 | 0.170 | -0.207 | 3.364 | 4.574 |
| unicode | 0.261 | 0.528 | 0.081 | 0.119 | -0.181 | 3.786 | 4.940 |
| long-lines | 0.304 | 0.770 | 0.103 | 0.197 | -0.202 | 3.635 | 5.396 |
| lines2500 | 1.188 | 1.852 | 0.489 | 0.788 | -0.698 | 4.132 | 6.569 |
| bytes60k | 0.666 | 0.855 | 0.464 | 0.574 | -0.202 | 3.659 | 4.072 |
| head60k | 0.438 | 0.607 | 0.145 | 0.170 | -0.293 | 3.763 | 4.591 |

## Spawn floor — bare `--version` (N=200)

p50 3.574 ms · p95 4.354 ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).

## Peak RSS (best-effort, /usr/bin/time, 100-read child probe)

oracle: unavailable · piread (node side, daemon excluded): unavailable · oneshot: unavailable · daemon itself (VmHWM after 200-read soak): 2 MB

---

Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.
