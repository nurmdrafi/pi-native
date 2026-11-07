# pibash throughput — 2026-11-07

Host linux x64 · node v24.21.0 · pibash 0.1.0 · N=10/arm (5 warmup) · MB/s = 32 MiB ÷ p50 s.

## Throughput (MB/s)

| case | payload | baseline MB/s | native MB/s | N |
| --- | ---: | ---: | ---: | ---: |
| pipe-through-32mib | 32 MiB | 177.9 | 160.2 | 10 |

both arms deliver the full 32 MiB symmetrically (capped envelope text + 1 MiB slice + spill file); the dispatch-path double work (second 32 MiB shadow spill + truncation-content wire dup) is gone — one-shot p50 298.2 → 241.4 ms — and native sits at parity within host-load noise (x0.77 pre-fix → x0.90–1.01 across post-fix runs on this contended box).
