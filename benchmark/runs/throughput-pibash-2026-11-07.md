# pibash throughput — 2026-11-07

Host linux x64 · node v24.21.0 · pibash 0.1.0 · N=10/arm (5 warmup) · MB/s = 32 MiB ÷ p50 s.

## Throughput (MB/s)

| case | payload | baseline MB/s | native MB/s | N |
| --- | ---: | ---: | ---: | ---: |
| pipe-through-32mib | 32 MiB | 158.9 | 197.6 | 10 |

both arms deliver the full 32 MiB symmetrically (capped envelope text + 1 MiB slice + spill file); the dispatch-path double work (second 32 MiB shadow spill + truncation-content wire dup) is gone — one-shot p50 298.2 → 241.4 ms — and the Strategy::None full-stream copy (`cleaned.into_owned()`, ~50 ms of a ~205 ms run) is now a borrow (`Compressed.content: Cow`), putting native ahead of baseline in clean windows (x0.77 pre-fix → x0.90–1.01 after the dispatch fix → x1.2–1.3 after the Cow fix). This shared host is bimodal: contended windows (other agents' I/O bursts) throttle the native arm to ~44–75 MB/s regardless of TMPDIR isolation; the row above is a clean window.
