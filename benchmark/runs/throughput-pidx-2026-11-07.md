# pidx throughput — 2026-11-07

Host linux x64 · node v24.21.0 · pidx 0.1.0 · N=10/arm (5 warmup) · MB/s = 32 MiB ÷ p50 s.

## Throughput (MB/s)

| case | payload | baseline MB/s | native MB/s | N |
| --- | --- | ---: | ---: | ---: |
| cold-index | 32 MiB | 215.2 | 146.3 | 10 |
| warm-rerun | 32 MiB | 132.0 | 2210.2 | 10 |

baseline = parse + build + write per-file summaries; native = full extracts + state store.

warm-rerun: baseline = oracle rerun (node has no state cache — full reparse + rewrite); native = pidx rerun with the existing state store over the unchanged corpus (cache hit — no reparse, no rewrite). Warm speed is the state store paying off, not a like-for-like parse race.

Corpus: 40 synthetic session-log JSONL files (32.0 MiB, mulberry32 seed 20261107) in a temp workdir; baseline = node oracle that parses every line and writes one JSONL summary per file, native = full cold index (`bin/pidx --sessions-dir <corpus> --state <fresh> --out <workdir>`) writing full per-session extracts — the state-store write is pidx-only extra work.
