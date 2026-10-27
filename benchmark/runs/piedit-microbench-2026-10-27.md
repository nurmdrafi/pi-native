# piedit micro-bench — 2026-10-27

Host linux x64 · node v24.21.0 · piedit 0.2.0 · N=100/arm (5 warmup) · local wall-clock, single process.

Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, native Rust diff/patch render) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).

Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.

## Dispatch latency (ms)

| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.778 | 1.568 | 0.372 | 0.702 | -0.406 | 5.495 | 6.954 |
| mid-exact | 1800 | 1.126 | 2.844 | 0.302 | 0.464 | -0.824 | 5.716 | 8.013 |
| mid-multi | 1800 | 1.274 | 4.782 | 0.484 | 3.780 | -0.790 | 5.926 | 18.004 |
| fuzzy-trailing-ws | 30 | 0.867 | 3.962 | 0.514 | 4.212 | -0.354 | 4.738 | 9.037 |
| multiline-block | 18890 | 3.647 | 5.019 | 2.091 | 6.242 | -1.556 | 5.459 | 14.600 |
| large-1mib | 588890 | 102.714 | 144.080 | 34.406 | 62.570 | -68.308 | 36.090 | 56.308 |

## Spawn floor — bare `--version` (N=100)

p50 5.282 ms · p95 6.610 ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).

## Peak RSS (best-effort, /usr/bin/time, 50-edit child probe)

oracle: unavailable · piedit (node side, daemon excluded): unavailable · oneshot: unavailable

## Notes

- Native render (D2 speed amendment): the daemon renders diff+patch in Rust (byte-identical jsdiff port, `src/diff.rs`; pinned by the parity suite + `tests/piedit-diff-fuzz.mjs`), so the TS `generateDiffString`/`generateUnifiedPatch` pass and the `{baseContent,newContent}` IPC payload are both gone — the response envelope is a few KB even for 1 MiB files.
- Daemon dispatch closes the spawn floor; the shared fuzzy view (one normalize per call, not one per edit), the ASCII fast path in normalizeForFuzzyMatch, copy-free LF/BOM normalization, single-parse serve loop with reused line/response buffers, and the in-Rust Myers diff keep every class far under the in-process oracle.
- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.
