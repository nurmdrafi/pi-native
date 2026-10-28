# piedit micro-bench — 2026-10-17

Host darwin arm64 · node v24.3.0 · piedit 0.2.0 · N=100/arm (5 warmup) · local wall-clock, single process.

Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, native Rust diff/patch render) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).

Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.

## Dispatch latency (ms)

| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.212 | 0.315 | 0.144 | 0.208 | -0.068 | 2.006 | 3.291 |
| mid-exact | 1800 | 0.291 | 0.592 | 0.159 | 0.276 | -0.132 | 1.972 | 2.467 |
| mid-multi | 1800 | 0.287 | 0.539 | 0.152 | 0.214 | -0.135 | 1.918 | 2.431 |
| fuzzy-trailing-ws | 30 | 0.199 | 0.288 | 0.140 | 0.242 | -0.059 | 1.931 | 2.970 |
| multiline-block | 18890 | 1.049 | 1.434 | 0.264 | 0.338 | -0.784 | 2.235 | 2.992 |
| large-1mib | 588890 | 29.969 | 34.679 | 4.258 | 4.862 | -25.710 | 7.095 | 7.544 |

## Spawn floor — bare `--version` (N=100)

p50 1.771 ms · p95 2.084 ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).

## Peak RSS (best-effort, /usr/bin/time, 50-edit child probe)

oracle: 183264 MB · piedit (node side, daemon excluded): 183376 MB · oneshot: 183360 MB

## Notes

- Native render (D2 speed amendment): the daemon renders diff+patch in Rust (byte-identical jsdiff port, `src/diff.rs`; pinned by the parity suite + `tests/piedit-diff-fuzz.mjs`), so the TS `generateDiffString`/`generateUnifiedPatch` pass and the `{baseContent,newContent}` IPC payload are both gone — the response envelope is a few KB even for 1 MiB files.
- Daemon dispatch closes the spawn floor; the shared fuzzy view (one normalize per call, not one per edit), the ASCII fast path in normalizeForFuzzyMatch, copy-free LF/BOM normalization, single-parse serve loop with reused line/response buffers, and the in-Rust Myers diff keep every class far under the in-process oracle.
- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.
