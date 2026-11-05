# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T17:46:13.602Z
- node: v24.21.0
- PI_WRITE_BIN: /home/nurmdrafi/.pi/agent/benchmark/piwrite/shim/piwrite-shim.mjs
- tag: v2smoke3

## mode=--smoke

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 106 | 0.216 | 0.307 | 1.416 | 13.225 |
| A2 | piwrite-oneshot | 2 | 4 | 50.529 | 57.424 | 62.086 | 0.072 |
| A3 | piwrite-serve | 2 | 16 | 0.252 | 0.317 | 0.381 | 12.942 |

verdict 4KB [mode=--smoke tag=v2smoke3]: piwrite-serve vs node-builtin — p50 0.317ms vs 0.307ms → 0.968x faster; throughput 12.942 vs 13.225 MB/s → 0.979x

