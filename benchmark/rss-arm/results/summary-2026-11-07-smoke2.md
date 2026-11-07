# rss-arm benchmark summary — 2026-11-07

- generated: 2026-11-07T15:58:52.149Z
- node: v24.21.0
- /usr/bin/time: GNU time 1.7
- binaries: piread=/home/nurmdrafi/.pi/agent/bin/piread pibash=/home/nurmdrafi/.pi/agent/bin/pibash piwrite=/home/nurmdrafi/.pi/agent/bin/piwrite
- mode: smoke tag: smoke2

## workload=read-window

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piread | 2 | 2440 | 2474 | 2508 | 0 |
| builtin | node-builtin | 2 | 109444 | 110156 | 110868 | 0 |

verdict read-window: native vs builtin — p50 peak RSS 2474 KiB vs 110156 KiB → builtin uses 44.5x more peak RSS

## workload=bash-seq

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | pibash | 2 | 3448 | 3458 | 3468 | 0 |
| builtin | node-core-equivalent | 2 | 81432 | 81602 | 81772 | 0 |

verdict bash-seq: native vs builtin — p50 peak RSS 3458 KiB vs 81602 KiB → builtin uses 23.6x more peak RSS

## workload=write-100mb

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piwrite | 2 | 2824 | 2848 | 2872 | 0 |
| builtin | node-builtin | 2 | 409640 | 409736 | 409832 | 0 |

verdict write-100mb: native vs builtin — p50 peak RSS 2848 KiB vs 409736 KiB → builtin uses 143.9x more peak RSS

## Methodology

- Peak RSS sampled per run by `/usr/bin/time -v` (GNU time reports getrusage `ru_maxrss` = Linux VmHWM high-water mark, in KiB); whole-process measurement, no /proc polling needed.
- Each side runs the identical frozen workload; native side = the Rust binary process, builtin side = a node process driving the real built-in tool module in-process (probe first; exact node-core replica fallback, labelled `node-core-equivalent`).
- Runs are warm: 0 unrecorded warmup run(s) per side prime the page cache; 2 measured runs per side, interleaved native/builtin per round.
- Compared statistic: median (p50) of measured runs. Rerun spread % = (max−min)/min over per-invocation medians recorded in this results file.
- Fixtures are deterministic (xorshift32, fixed seed): every invocation regenerates byte-identical corpus/content.
