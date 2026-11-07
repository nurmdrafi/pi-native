# rss-arm benchmark summary — 2026-11-07

- generated: 2026-11-07T15:57:43.957Z
- node: v24.21.0
- /usr/bin/time: GNU time 1.7
- binaries: piread=/home/nurmdrafi/.pi/agent/bin/piread pibash=/home/nurmdrafi/.pi/agent/bin/pibash piwrite=/home/nurmdrafi/.pi/agent/bin/piwrite
- mode: smoke tag: smoke1

## workload=read-window

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piread | 2 | 2232 | 2258 | 2284 | 0 |
| builtin | node-builtin | 2 | 110652 | 110704 | 110756 | 0 |

verdict read-window: native vs builtin — p50 peak RSS 2258 KiB vs 110704 KiB → builtin uses 49x more peak RSS

## workload=bash-seq

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | pibash | 2 | 3504 | 3574 | 3644 | 0 |
| builtin | node-core-equivalent | 2 | 82016 | 82242 | 82468 | 0 |

verdict bash-seq: native vs builtin — p50 peak RSS 3574 KiB vs 82242 KiB → builtin uses 23x more peak RSS

## workload=write-100mb

| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |
|---|---|---|---|---|---|---|
| native | piwrite | 2 | 2848 | 2882 | 2916 | 0 |
| builtin | node-core-equivalent | 2 | 409588 | 410016 | 410444 | 0 |

verdict write-100mb: native vs builtin — p50 peak RSS 2882 KiB vs 410016 KiB → builtin uses 142.3x more peak RSS

## Methodology

- Peak RSS sampled per run by `/usr/bin/time -v` (GNU time reports getrusage `ru_maxrss` = Linux VmHWM high-water mark, in KiB); whole-process measurement, no /proc polling needed.
- Each side runs the identical frozen workload; native side = the Rust binary process, builtin side = a node process driving the real built-in tool module in-process (probe first; exact node-core replica fallback, labelled `node-core-equivalent`).
- Runs are warm: 0 unrecorded warmup run(s) per side prime the page cache; 2 measured runs per side, interleaved native/builtin per round.
- Compared statistic: median (p50) of measured runs. Rerun spread % = (max−min)/min over per-invocation medians recorded in this results file.
- Fixtures are deterministic (xorshift32, fixed seed): every invocation regenerates byte-identical corpus/content.
