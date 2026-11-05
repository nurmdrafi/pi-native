# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T17:20:52.319Z
- node: v24.21.0
- PI_WRITE_BIN: /home/nurmdrafi/.pi/agent/benchmark/piwrite/shim/piwrite-shim.mjs
- tag: v2smoke

## mode=--smoke

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 88 | 0.265 | 0.323 | 2.289 | 11.663 |
| A2 | piwrite-oneshot | 2 | 4 | 49.964 | 57.522 | 74.805 | 0.068 |
| A3 | piwrite-serve | 2 | 16 | 0.352 | 0.686 | 1.02 | 5.971 |

verdict 4KB [mode=--smoke tag=v2smoke]: piwrite-serve vs node-builtin — p50 0.686ms vs 0.323ms → 0.471x faster; throughput 5.971 vs 11.663 MB/s → 0.512x

