# piedit micro-bench — 2026-10-16

Host linux x64 · node v24.21.0 · piedit 0.2.0 · N=100/arm (5 warmup) · local wall-clock, single process.

Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, native Rust diff/patch render) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).

Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.

## Dispatch latency (ms)

| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.513 | 0.932 | 0.288 | 0.586 | -0.225 | 3.426 | 4.439 |
| mid-exact | 1800 | 0.893 | 1.260 | 0.342 | 0.603 | -0.551 | 3.484 | 4.468 |
| mid-multi | 1800 | 0.854 | 1.842 | 0.327 | 0.491 | -0.527 | 3.321 | 4.142 |
| fuzzy-trailing-ws | 30 | 0.445 | 0.838 | 0.308 | 0.857 | -0.137 | 3.317 | 4.391 |
| multiline-block | 18890 | 2.556 | 3.960 | 1.033 | 2.239 | -1.524 | 3.919 | 4.814 |
| large-1mib | 588890 | 90.630 | 99.914 | 36.416 | 55.819 | -54.214 | 35.069 | 58.937 |

## Spawn floor — bare `--version` (N=100)

p50 3.303 ms · p95 4.391 ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).

## Peak RSS (best-effort, /usr/bin/time, 50-edit child probe)

oracle: 161 MB · piedit (node side, daemon excluded): 155 MB · oneshot: 155 MB

## Notes

- Native render (D2 speed amendment): the daemon renders diff+patch in Rust (byte-identical jsdiff port, `src/diff.rs`; pinned by the parity suite + `tests/piedit-diff-fuzz.mjs`), so the TS `generateDiffString`/`generateUnifiedPatch` pass and the `{baseContent,newContent}` IPC payload are both gone — the response envelope is a few KB even for 1 MiB files.
- Daemon dispatch closes the spawn floor; the shared fuzzy view (one normalize per call, not one per edit), the ASCII fast path in normalizeForFuzzyMatch, copy-free LF/BOM normalization, single-parse serve loop with reused line/response buffers, and the in-Rust Myers diff keep every class far under the in-process oracle.
- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.

## Structural variant — tmpfs corpus (TMPDIR=/dev/shm)

The default corpus lives on this host's ext4 root (84% full): a 590 KB truncate+write costs ~18–20 ms there, and BOTH arms pay it (identical `writeFile` semantics, R4), which floors the large-file ratio. With the corpus on tmpfs the shared write cost collapses and the structural ratios surface:

| corpus | oracle p50 | piedit p50 | speedup |
| --- | ---: | ---: | ---: |
| small-exact | 0.428 | 0.180 | 2.4× |
| mid-exact | 0.817 | 0.215 | 3.8× |
| mid-multi | 0.623 | 0.235 | 2.7× |
| fuzzy-trailing-ws | 0.411 | 0.182 | 2.3× |
| multiline-block | 2.483 | 0.738 | 3.4× |
| large-1mib | 88.246 | 9.628 | **9.2×** |

Mid/multiline/large — where edit wall-clock actually goes — land at 2.7–9.2×; the small-file classes are floored by the daemon IPC round trip (~0.18 ms) plus the same-file write both arms pay.
