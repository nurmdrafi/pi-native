# rss-arm benchmark summary — 2026-11-08

- generated: 2026-11-08T18:40:18.413Z
- node: v24.21.0
- /usr/bin/time: GNU time 1.7
- binaries: piread=/home/nurmdrafi/.pi/agent/bin/piread pibash=/home/nurmdrafi/.pi/agent/bin/pibash piwrite=/home/nurmdrafi/.pi/agent/bin/piwrite
- mode: full tag: rss-rework

## workload=read-window

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piread | 5 | 2236 | 2384 | 2432 | 0 |
| builtin | node-builtin | 5 | 109776 | 110352 | 110600 | 0 |

verdict read-window: native vs builtin — p50 peak RSS 2384 KiB vs 110352 KiB → builtin uses 46.3x more peak RSS

## workload=bash-seq

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | pibash | 5 | 3444 | 3544 | 3552 | 0 |
| builtin | node-builtin | 5 | 83464 | 83764 | 84956 | 0 |

verdict bash-seq: native vs builtin — p50 peak RSS 3544 KiB vs 83764 KiB → builtin uses 23.6x more peak RSS

## workload=write-100mb

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piwrite | 5 | 2764 | 2872 | 3012 | 0 |
| builtin | node-builtin | 5 | 410220 | 410428 | 410752 | 0 |

verdict write-100mb: native vs builtin — p50 peak RSS 2872 KiB vs 410428 KiB → builtin uses 142.9x more peak RSS

## Methodology

- Peak RSS sampled per run by `/usr/bin/time -v` (GNU time reports getrusage `ru_maxrss` = Linux VmHWM high-water mark, in KiB); whole-process measurement, no /proc polling needed.
- Each side runs the identical frozen workload; native side = the Rust binary process, builtin side = a node process driving the real built-in tool module in-process (probe first; exact node-core replica fallback, labelled `node-core-equivalent`).
- Runs are warm: 1 unrecorded warmup run(s) per side prime the page cache; 5 measured runs per side, interleaved native/builtin per round.
- Compared statistic: median (p50) of measured runs. Rerun spread % = (max−min)/min over per-invocation medians recorded in this results file.
- Fixtures are deterministic (xorshift32, fixed seed): every invocation regenerates byte-identical corpus/content.
