# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T17:38:40.672Z
- node: v24.21.0
- PI_WRITE_BIN: /home/nurmdrafi/.pi/agent/benchmark/piwrite/shim/piwrite-shim.mjs
- tag: v2smoke2

## mode=--smoke

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 114 | 0.273 | 0.448 | 3.801 | 7.096 |
| A2 | piwrite-oneshot | 2 | 2 | 72.009 | 87.5 | 102.99 | 0.047 |
| A3 | piwrite-serve | 2 | 10 | 0.637 | 1.45 | 2.263 | 2.825 |

verdict 4KB [mode=--smoke tag=v2smoke2]: piwrite-serve vs node-builtin — p50 1.45ms vs 0.448ms → 0.309x faster; throughput 2.825 vs 7.096 MB/s → 0.398x

