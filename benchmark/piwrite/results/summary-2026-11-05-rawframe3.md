# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T18:10:39.127Z
- node: v24.21.0
- PI_WRITE_BIN: <unset; default /home/nurmdrafi/.pi/agent/bin/piwrite>
- tag: rawframe3

## mode=--full

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 600 | 0.193 | 0.283 | 3.168 | 13 |
| A2 | piwrite-oneshot | 10 | 110 | 6.077 | 6.262 | 8.204 | 0.642 |
| A3 | piwrite-serve | 10 | 4630 | 0.128 | 0.136 | 0.158 | 29.778 |

verdict 4KB [mode=--full tag=rawframe3]: piwrite-serve vs node-builtin — p50 0.136ms vs 0.283ms → 2.081x faster; throughput 29.778 vs 13 MB/s → 2.291x

### 1MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 260 | 1.899 | 7.41 | 261.634 | 31.689 |
| A2 | piwrite-oneshot | 10 | 110 | 7.368 | 9.013 | 210.242 | 31.274 |
| A3 | piwrite-serve | 10 | 240 | 25.939 | 34.674 | 36.252 | 31.696 |

verdict 1MB [mode=--full tag=rawframe3]: piwrite-serve vs node-builtin — p50 34.674ms vs 7.41ms → 0.214x faster; throughput 31.696 vs 31.689 MB/s → 1x

### 16MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 10 | 30.603 | 203.586 | 905.014 | 60.008 |
| A2 | piwrite-oneshot | 10 | 10 | 19.938 | 206.328 | 746.299 | 60.667 |
| A3 | piwrite-serve | 10 | 10 | 521.523 | 543.6 | 579.073 | 30.673 |

verdict 16MB [mode=--full tag=rawframe3]: piwrite-serve vs node-builtin — p50 543.6ms vs 203.586ms → 0.375x faster; throughput 30.673 vs 60.008 MB/s → 0.511x

### 100MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 2 | 215.998 | 218.453 | 220.907 | 480.002 |
| A2 | piwrite-oneshot | 2 | 2 | 110.059 | 115.963 | 121.867 | 904.233 |
| A3 | piwrite-serve | 2 | 2 | 107.425 | 1782.984 | 3458.543 | 58.81 |

verdict 100MB [mode=--full tag=rawframe3]: piwrite-serve vs node-builtin — p50 1782.984ms vs 218.453ms → 0.123x faster; throughput 58.81 vs 480.002 MB/s → 0.123x

