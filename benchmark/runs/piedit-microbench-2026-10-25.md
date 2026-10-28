# piedit micro-bench — 2026-10-25

Host darwin arm64 · node v24.3.0 · piedit 0.2.0 · N=100/arm (5 warmup) · local wall-clock, single process.

Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, native Rust diff/patch render) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).

Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.

## Dispatch latency (ms)

| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.204 | 0.334 | 0.142 | 0.217 | -0.062 | 2.053 | 2.578 |
| mid-exact | 1800 | 0.288 | 0.362 | 0.154 | 0.203 | -0.134 | 2.001 | 2.445 |
| mid-multi | 1800 | 0.282 | 0.363 | 0.147 | 0.180 | -0.135 | 1.987 | 2.536 |
| fuzzy-trailing-ws | 30 | 0.190 | 0.243 | 0.135 | 0.178 | -0.055 | 1.962 | 2.492 |
| multiline-block | 18890 | 1.080 | 1.486 | 0.268 | 0.446 | -0.812 | 2.182 | 2.738 |
| large-1mib | 588890 | 29.683 | 37.089 | 4.218 | 4.770 | -25.465 | 7.269 | 7.903 |

## Spawn floor — bare `--version` (N=100)

p50 1.778 ms · p95 2.288 ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).

## Peak RSS (best-effort, /usr/bin/time, 50-edit child probe)

oracle: 182240 MB · piedit (node side, daemon excluded): 193376 MB · oneshot: 184368 MB

## Notes

- Native render (D2 speed amendment): the daemon renders diff+patch in Rust (byte-identical jsdiff port, `src/diff.rs`; pinned by the parity suite + `tests/piedit-diff-fuzz.mjs`), so the TS `generateDiffString`/`generateUnifiedPatch` pass and the `{baseContent,newContent}` IPC payload are both gone — the response envelope is a few KB even for 1 MiB files.
- Daemon dispatch closes the spawn floor; the shared fuzzy view (one normalize per call, not one per edit), the ASCII fast path in normalizeForFuzzyMatch, copy-free LF/BOM normalization, single-parse serve loop with reused line/response buffers, and the in-Rust Myers diff keep every class far under the in-process oracle.
- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.
