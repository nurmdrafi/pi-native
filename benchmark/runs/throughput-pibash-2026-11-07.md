# pibash throughput — 2026-11-07

Host linux x64 · node v24.21.0 · pibash 0.1.0 · N=10/arm (5 warmup) · MB/s = 32 MiB ÷ p50 s.

## Throughput (MB/s)

| case | payload | baseline MB/s | native MB/s | N |
| --- | --- | ---: | ---: | ---: |
| pipe-through-32mib | 32 MiB | 141.5 | 109.0 | 10 |

both arms deliver the full 32 MiB symmetrically (capped envelope text + 1 MiB slice + spill file); native trails on the doubled envelope serialization, not on delivery.
