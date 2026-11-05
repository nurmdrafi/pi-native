# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T18:05:39.375Z
- node: v24.21.0
- PI_WRITE_BIN: /home/nurmdrafi/.pi/agent/benchmark/piwrite/shim/piwrite-shim.mjs
- tag: v2smoke4

## mode=--smoke

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 102 | 0.246 | 0.314 | 0.545 | 12.74 |
| A2 | piwrite-oneshot | 2 | 4 | 50.198 | 55.718 | 64.77 | 0.072 |
| A3 | piwrite-serve | 2 | 16 | 0.274 | 0.354 | 0.433 | 11.587 |

verdict 4KB [mode=--smoke tag=v2smoke4]: piwrite-serve vs node-builtin — p50 0.354ms vs 0.314ms → 0.887x faster; throughput 11.587 vs 12.74 MB/s → 0.909x

