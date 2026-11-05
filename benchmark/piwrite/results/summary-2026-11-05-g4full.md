# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T18:59:57.363Z
- node: v24.21.0
- PI_WRITE_BIN: <unset; default /home/nurmdrafi/.pi/agent/bin/piwrite>
- tag: g4full

## mode=--full

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 380 | 0.307 | 0.506 | 29.749 | 5.478 |
| A2 | piwrite-oneshot | 10 | 70 | 6.785 | 9.612 | 29.329 | 0.411 |
| A3 | piwrite-serve | 10 | 3480 | 0.133 | 0.136 | 0.207 | 29.004 |

verdict 4KB [mode=--full tag=g4full]: piwrite-serve vs node-builtin — p50 0.136ms vs 0.506ms → 3.721x faster; throughput 29.004 vs 5.478 MB/s → 5.295x

### 1MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 140 | 2.289 | 5.097 | 269.163 | 29.912 |
| A2 | piwrite-oneshot | 10 | 60 | 8.663 | 14.537 | 223.636 | 33.55 |
| A3 | piwrite-serve | 10 | 660 | 33.202 | 34.181 | 35.684 | 30.552 |

verdict 1MB [mode=--full tag=g4full]: piwrite-serve vs node-builtin — p50 34.181ms vs 5.097ms → 0.149x faster; throughput 30.552 vs 29.912 MB/s → 1.021x

### 16MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 10 | 42.913 | 188.12 | 844.472 | 60.113 |
| A2 | piwrite-oneshot | 10 | 10 | 27.808 | 229.956 | 768.23 | 60.795 |
| A3 | piwrite-serve | 10 | 10 | 539.491 | 554.013 | 567.546 | 30.284 |

verdict 16MB [mode=--full tag=g4full]: piwrite-serve vs node-builtin — p50 554.013ms vs 188.12ms → 0.34x faster; throughput 30.284 vs 60.113 MB/s → 0.504x

### 100MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 2 | 477.652 | 489.891 | 502.129 | 214.043 |
| A2 | piwrite-oneshot | 2 | 2 | 206.164 | 238.683 | 271.201 | 439.318 |
| A3 | piwrite-serve | 2 | 2 | 189.604 | 1892.759 | 3595.914 | 55.399 |

verdict 100MB [mode=--full tag=g4full]: piwrite-serve vs node-builtin — p50 1892.759ms vs 489.891ms → 0.259x faster; throughput 55.399 vs 214.043 MB/s → 0.259x

