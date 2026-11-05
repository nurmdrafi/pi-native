# piwrite benchmark summary — 2026-11-05

- generated: 2026-11-05T17:27:52.962Z
- node: v24.21.0
- PI_WRITE_BIN: <unset; default /home/nurmdrafi/.pi/agent/bin/piwrite>
- tag: rawframe

## mode=--full

### 4KB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 510 | 0.203 | 0.294 | 1.202 | 12.905 |
| A2 | piwrite-oneshot | 10 | 110 | 5.861 | 6.262 | 10.208 | 0.63 |
| A3 | piwrite-serve | 10 | 3980 | 0.133 | 0.135 | 0.142 | 30.229 |

verdict 4KB [mode=--full tag=rawframe]: piwrite-serve vs node-builtin — p50 0.135ms vs 0.294ms → 2.178x faster; throughput 30.229 vs 12.905 MB/s → 2.342x

### 1MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 270 | 1.981 | 6.991 | 263.702 | 31.798 |
| A2 | piwrite-oneshot | 10 | 110 | 6.975 | 9.128 | 213.168 | 32.105 |
| A3 | piwrite-serve | 10 | 590 | 30.756 | 34.095 | 36.913 | 31.165 |

verdict 1MB [mode=--full tag=rawframe]: piwrite-serve vs node-builtin — p50 34.095ms vs 6.991ms → 0.205x faster; throughput 31.165 vs 31.798 MB/s → 0.98x

### 16MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 10 | 10 | 30.332 | 200.672 | 750.96 | 66.017 |
| A2 | piwrite-oneshot | 10 | 10 | 21.934 | 229.444 | 898.453 | 58.418 |
| A3 | piwrite-serve | 10 | 10 | 526.656 | 555.105 | 616.378 | 29.904 |

verdict 16MB [mode=--full tag=rawframe]: piwrite-serve vs node-builtin — p50 555.105ms vs 200.672ms → 0.362x faster; throughput 29.904 vs 66.017 MB/s → 0.453x

### 100MB

| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |
|---|---|---|---|---|---|---|---|
| A1 | node-builtin | 2 | 2 | 225.56 | 227.367 | 229.173 | 461.183 |
| A2 | piwrite-oneshot | 2 | 2 | 123.717 | 124.539 | 125.361 | 841.966 |
| A3 | piwrite-serve | 2 | 2 | 121.395 | 1785.022 | 3448.648 | 58.743 |

verdict 100MB [mode=--full tag=rawframe]: piwrite-serve vs node-builtin — p50 1785.022ms vs 227.367ms → 0.127x faster; throughput 58.743 vs 461.183 MB/s → 0.127x

