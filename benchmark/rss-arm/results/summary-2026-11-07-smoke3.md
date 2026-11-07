# rss-arm benchmark summary — 2026-11-07

- generated: 2026-11-07T15:59:25.168Z
- node: v24.21.0
- /usr/bin/time: GNU time 1.7
- binaries: piread=/home/nurmdrafi/.pi/agent/bin/piread pibash=/home/nurmdrafi/.pi/agent/bin/pibash piwrite=/home/nurmdrafi/.pi/agent/bin/piwrite
- mode: smoke tag: smoke3

## workload=read-window

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piread | 2 | 2308 | 2354 | 2400 | 0 |
| builtin | node-builtin | 2 | 109804 | 109836 | 109868 | 0 |

verdict read-window: native vs builtin — p50 peak RSS 2354 KiB vs 109836 KiB → builtin uses 46.7x more peak RSS

## workload=bash-seq

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | pibash | 2 | 3428 | 3530 | 3632 | 0 |
| builtin | node-builtin | 2 | 82856 | 83304 | 83752 | 0 |

verdict bash-seq: native vs builtin — p50 peak RSS 3530 KiB vs 83304 KiB → builtin uses 23.6x more peak RSS

## workload=write-100mb

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piwrite | 2 | 2856 | 2860 | 2864 | 0 |
| builtin | node-builtin | 2 | 409520 | 409992 | 410464 | 0 |

verdict write-100mb: native vs builtin — p50 peak RSS 2860 KiB vs 409992 KiB → builtin uses 143.4x more peak RSS

## Methodology

- Peak RSS sampled per run by `/usr/bin/time -v` (GNU time reports getrusage `ru_maxrss` = Linux VmHWM high-water mark, in KiB); whole-process measurement, no /proc polling needed.
- Each side runs the identical frozen workload; native side = the Rust binary process, builtin side = a node process driving the real built-in tool module in-process (probe first; exact node-core replica fallback, labelled `node-core-equivalent`).
- Runs are warm: 0 unrecorded warmup run(s) per side prime the page cache; 2 measured runs per side, interleaved native/builtin per round.
- Compared statistic: median (p50) of measured runs. Rerun spread % = (max−min)/min over per-invocation medians recorded in this results file.
- Fixtures are deterministic (xorshift32, fixed seed): every invocation regenerates byte-identical corpus/content.
