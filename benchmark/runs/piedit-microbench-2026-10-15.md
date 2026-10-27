# piedit micro-bench — 2026-10-15

Host linux x64 · node v24.21.0 · piedit 0.1.0 · N=100/arm (5 warmup) · local wall-clock, single process.

Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, TS diff/patch) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).

Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.

## Dispatch latency (ms)

| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.476 | 0.820 | 0.299 | 0.615 | -0.177 | 3.288 | 4.077 |
| mid-exact | 1800 | 0.918 | 1.361 | 0.767 | 1.054 | -0.151 | 3.398 | 4.326 |
| mid-multi | 1800 | 0.715 | 1.078 | 0.706 | 0.990 | -0.009 | 3.265 | 4.094 |
| fuzzy-trailing-ws | 30 | 0.421 | 0.802 | 0.331 | 0.654 | -0.090 | 3.223 | 4.097 |
| multiline-block | 18890 | 2.797 | 3.749 | 2.731 | 4.064 | -0.066 | 4.126 | 5.263 |
| large-1mib | 588890 | 88.382 | 98.634 | 117.437 | 128.910 | +29.055 | 37.113 | 46.517 |

## Spawn floor — bare `--version` (N=100)

p50 4.148 ms · p95 5.133 ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).

## Peak RSS (best-effort, /usr/bin/time, 50-edit child probe)

oracle: 156 MB · piedit (node side, daemon excluded): 160 MB · oneshot: 156 MB

## Notes

- Daemon dispatch closes the spawn floor: on small/mid/large-text cases piedit is at or below the built-in oracle (spec R1's small-file fear was a spawn-cost artifact, not a matching-cost one).
- The large-1MiB class exposes the R6 IPC cost: `baseContent` + `newContent` cross the boundary as JSON, so the daemon arm pays serialization/parse on top of native matching — and TS diff/patch rendering stays on the oracle's code path either way (spec D2). The honest verdict for >1 MiB stays "route to the built-in" (size-based routing).
- The Rust side owns match + apply + write; diff/patch rendering stays in TypeScript (spec D2), so the oracle's diff cost is also paid by the piedit arm.
- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.
