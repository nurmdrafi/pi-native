# pibash throughput — 2026-11-08

Host linux x64 · node v24.21.0 · pibash 0.2.0 · N=10/arm (5 warmup) · MB/s = 32 MiB ÷ p50 s.

Post spill-streaming rework + recovery pass (allocation-free walker, ≤16 MiB materialize hybrid): peak RSS on this workload class is O(budget) (~6 MB at 100 MB) at this measured wall cost — see benchmark/runs/pibash-rss-rework-2026-11-08.md §8.

## Throughput (MB/s)

| case | payload | baseline MB/s | native MB/s | N |
| --- | ---: | ---: | ---: | ---: |
| pipe-through-32mib | 32 MiB | 178.0 | 123.7 | 10 |
