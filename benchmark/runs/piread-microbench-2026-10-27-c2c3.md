# piread micro-bench — C2/C3 compaction-omissions before/after (2026-10-27)

Question: does the new `details.compaction.omissions[]` publication
(compress.rs + envelope serialization + gate coverage map) cost read latency?

Method: `node tests/piread-bench.mjs` twice on the same machine, same corpus —
once against `bin/piread` built at HEAD (`2a760af`, before), once against the
C2/C3 build (after). Binary swapped via `scripts/lib/install-native.sh`
(signing installer) between runs; the after-binary was reinstalled and
verified (`omissions[]` present) afterwards.

## Daemon arm (production path), p50 / p95 in ms

| corpus    | before p50 | after p50 | Δ p50 | before p95 | after p95 |
|-----------|-----------:|----------:|------:|-----------:|----------:|
| one-line  | 0.105      | 0.056     | −0.049 | 0.151 | 0.263 |
| crlf      | 0.049      | 0.041     | −0.008 | 0.131 | 0.057 |
| unicode   | 0.041      | 0.041     | 0.000  | 0.052 | 0.061 |
| long-lines| 0.047      | 0.044     | −0.003 | 0.056 | 0.131 |
| lines2500 | 0.177      | 0.186     | +0.009 | 0.195 | 0.226 |
| bytes60k  | 0.170      | 0.170     | 0.000  | 0.231 | 0.254 |
| head60k   | 0.061      | 0.065     | +0.004 | 0.076 | 0.097 |

## Noise control

- oracle arm (pure Node, binary untouched): one-line p50 0.124→0.167, p95
  0.197→0.891 — run-to-run drift exceeds every piread-arm delta above.
- `--version` spawn loop (touches none of the changed code): p50 1.766→2.185.
- RSS: oracle 195→199 MB, piread 192→184 MB — noise in both directions.

## Conclusion

No measurable regression. Daemon-arm p50 deltas are ≤ 0.009 ms, inside
single-run noise (the oracle control moved more). Expected cost — one small
Vec plus ~60 JSON bytes per compacted read — is below the harness floor.
Full single-run reports: this file's sibling (after) and the git worktree
build at HEAD (before); raw copies were kept in /tmp only.

Single runs, no repetition — tighten with N repeats if a sub-0.01 ms budget
ever matters.
