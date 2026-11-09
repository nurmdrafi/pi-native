# pibash RSS-rework before/after — 2026-11-08 (run 2026-11-09)

Host linux x64 · node v24.21.0 · BEFORE = frozen oracle `~/.pi/agent/.cache/pibash-oracle` (sha 1d9205a2b8c8…) · AFTER = `rust-tools/target/release/pibash` (sha 873ec3a7ad5e…, rebuilt 00:06:28 after the last src edit; `bin/pibash` carries the same sha). Idle `bin/pibash --serve` daemons killed before the run; every latency/throughput arm runs INTERLEAVED (B,A,B,A) — this host is bimodal (2026-11-07 record: contended windows throttle to ~44–75 MB/s); observed noise floor this run: ±6 % wall (single-pass matrix rows ±10 %), ±0.3 % within seq blocks.

Re-run note: the dispatched bench-compare child was lost after its Unit 2 (its independently observed Unit 2 — BEFORE bimodal 17.21/11.51 ms, AFTER 15.70/15.80 ms — agrees with the rows below); the whole matrix was re-run inline by the orchestrator. Cold start measured via spawnSync `hrtime` (brief prescribed `/usr/bin/time %e`; centisecond resolution is useless at ~4–17 ms — deviation noted).

## Headline

| metric | before | after | delta |
| --- | ---: | ---: | --- |
| cold start p50 (`--command true`) | 4.36 ms | 4.28 ms | flat (noise) |
| seq50000 p50 (per invocation) | 10.8 ms | 15.3 ms | **+4.4 ms (+41 %), real** |
| pipe-through-32mib | 139.3 MB/s | 117.9 MB/s | **−15 %, real** |
| yes-head-100mb peak RSS | 924.8 MB | 6.0 MB | **−99.4 %** |
| yes-head-100mb oneshot wall | 5387 ms (record) | 4996 ms | −7 % (≈ noise edge) |
| daemon 100 MB yes peak RSS | 903.0 MiB | 4.9 MiB | **−99.5 %** |

Mission metric (peak RSS on fold/large outputs) is decisively met; two wall regressions on windowed-class output are real and outside the noise floor (mechanism below) — not claimed as noise.

## 1. Cold start / fixed cost

n=60/arm interleaved (+5 warmup), spawnSync hrtime, `--command true`:

| arm | p50 | p90 | min | max |
| --- | ---: | ---: | ---: | ---: |
| before | 4.36 ms | 4.90 ms | 3.99 ms | 14.35 ms |
| after | 4.28 ms | 5.21 ms | 3.90 ms | 6.47 ms |

Fixed cost unchanged. (max-14.35 is one scheduler outlier on the before arm.)

## 2. seq 50000 (windowed uniform, 289 KB output)

`node rust-tools/pibash/bench-seq50000.mjs <bin> 5 20`, blocks B/A/B/A:

| block | arm | min | p50 | max |
| --- | --- | ---: | ---: | ---: |
| 1 | before | 10.71 | 10.79 | 12.42 |
| 1 | after | 14.51 | 15.33 | 16.29 |
| 2 | before | 10.71 | 10.86 | 11.49 |
| 2 | after | 14.65 | 15.21 | 19.94 |

Delta +4.4 ms p50 (+41 %), consistent across blocks and matching the lost child's independent numbers. Real regression.

## 3. pipe-through-32mib (32 MiB, 64-byte uniform lines, oneshot)

Same workload as `tests/tools/bench/pibash.mjs --throughput` (fixture regenerated at `~/.pi/efforts/pibash-fold-rss/tp-32mib.txt`, 33,554,432 B exact), N=10/arm + 5 warmup, strict per-rep interleave, MB/s = 32 MiB ÷ p50 s:

| arm | p50 | min | max | MB/s |
| --- | ---: | ---: | ---: | ---: |
| before | 229.8 ms | 224.0 | 251.4 | 139.3 |
| after | 271.3 ms | 259.0 | 334.9 | 117.9 |

Delta −21.4 MB/s (−15 %), min-to-min +35 ms. Real regression. (Context, different arms: 2026-11-07 record had builtin-oracle 158.9 vs native-daemon 197.6 MB/s in a clean window.)

## 4. Large-output matrix (records: 2026-10-22 vs 2026-11-08, single pass each)

| fixture | RSS before → after | wall d/o before → after |
| --- | --- | --- |
| uniform-1mb | 4.93 → 5.14 MB | 98/58 → 94/64 ms |
| giant-1mb | 5.27 → 6.70 MB | 41/21 → 31/23 ms |
| stderr-mix-1mb | 4.98 → 4.98 MB | 62/44 → 72/74 ms |
| uniform-10mb | 14.86 → 5.84 MB | 395/360 → 483/481 ms |
| giant-10mb | 15.07 → 13.50 MB | 85/77 → 121/115 ms |
| stderr-mix-10mb | 14.89 → 5.93 MB | 372/431 → 396/478 ms |
| signal-death-10mb | 14.66 → 5.72 MB | 369/351 → 742/596 ms |
| uniform-100mb | 104.7 → 5.79 MB | 3560/3524 → 4428/4547 ms |
| giant-100mb | 109.6 → 108.1 MB | 608/613 → 1225/1827 ms |
| stderr-mix-100mb | 104.8 → 6.06 MB | 3506/3538 → 6011/4574 ms |
| yes-head-100mb | 1051.8 → 6.20 MB | 5407/5387 → 5132/4996 ms |
| nonzero-exit-100mb | 104.8 → 5.91 MB | 3408/3842 → 5682/4970 ms |

RSS: every windowed/fold class flat at ~5–6 MB regardless of size; the giant-line band stays ~bytes by design (exact-materialized path; caps record it). Wall: systematic +25–30 % on uniform-100mb and ~2–3× on giant-100mb; yes-head (the fold class) flat-to-better. Single-pass rows: ±10 %.

## 5. Fold-class RSS slope (`yes | head -c N`, 3 runs/arm/size, ru_maxrss KiB)

| bytes | before (3 runs) | after (3 runs) |
| --- | --- | --- |
| 1,000,000 | 11980 / 12184 / 11920 | 5872 / 5152 / 5596 |
| 10,000,000 | 91044 / 91024 / 91024 | 5952 / 6080 / 6156 |
| 104,857,600 | 924788 / 924732 / 924844 | 5944 / 6116 / 6060 |

Before slope b ≈ 18.0 B/line (reproduces the T3 fit 18.002); after flat: peak moves +0.5 MiB across a 100× size range ⇒ b ≈ 0.01 B/line ≈ 0.

## 6. Daemon arm, 100 MB yes (`benchmark/pibash-daemon-rss.mjs`, release binary)

| arm | rss_peak | rss_after_5s | elapsed |
| --- | ---: | ---: | ---: |
| before (T3 record) | 946,872,320 B (903.0 MiB) | 4,247,552 B (4.1 MiB) | 4.478 s |
| after (this run) | 5,111,808 B (4.9 MiB) | 3,272,704 B (3.1 MiB) | 5.887 s |

{"arm":"daemon","bytes":104857600,"rss_peak_bytes":5111808,"rss_after_5s_bytes":3272704,"elapsed_s":5.887}

## 7. Wire parity spot-check (yes-head-100mb, direct)

`--command 'yes | head -c 104857600'` on both binaries: both 1,579,467 B; byte-equal after normalizing the two volatile fields (spill path `pi-bash-<pid>-<ns>.log`, `wall_time_seconds`). Evidence: `~/.pi/efforts/pibash-fold-rss/wire-yes-100mb-{before,after}.json`. The 2026-10-22 record's 1,585,485 B is a custom-tools-era harness measurement; today's oracle binary reproduces 1,579,467 B, so the delta is not a behavior change.

## Regression mechanism (hypothesis, consistent with all rows)

C2 spill-streaming routes Generic kinds through the spill file: windowed-class outputs now pay write-N-bytes + read-N-bytes at TMPDIR that the old in-memory path did not. It scales with output size (uniform-1mb flat, 32 MiB −15 %, 100 MB +25–30 %), hits the materialized giant band twice (~2–3× wall, no RSS win there), and leaves fold-class and cold-start paths untouched. Whether to reclaim it (e.g. memory-buffer fast path under a threshold, or mmap/windowed read of the spill) is a scope decision, not part of this record.

## 8. Latency/throughput recovery patch (2026-11-09 01:05, same host)

Two changes to the spill scanner (`compress.rs`): an allocation-free
`SpillWalker` (reused line-window buffers, borrowed `LineView`, recycled ring
slots, reused refill buffer, reused `run_first`/prev buffers — the §7 regression
was ~85 ns/line of heap traffic) and a `STREAM_MATERIALIZE_MAX` hybrid: spills
at or below 16 MiB take the exact materialized path once (one page-cache-hot
read) instead of streaming. Gates re-run: 150 tests green, clippy clean except
the pre-existing runner.rs warning, bin-diff 120/120 diffs=0.

Method note: `bench-large-output.mjs` drives `bin/pibash`, not
`target/release/pibash`; two intermediate matrix re-runs (00:5x) measured a
stale binary and are superseded — the record file
`benchmark/runs/pibash-large-output-2026-11-08.md` now holds the patched run.

| metric | oracle (same-run) | post-C2 (§1-5) | post-patch |
| --- | ---: | ---: | ---: |
| seq50000 p50, interleaved | 11.44-13.86 ms | 15.3 ms | 10.24-13.23 ms (at/below oracle; 10.24/10.47 vs 11.61/11.44 on the final binary, clean window) |
| pipe-through-32mib p50 | 223.6-229.8 ms | 271.3 ms | 248.9-259.0 ms (123.5-128.6 MB/s, −11/−12 % vs oracle) |
| uniform-1mb oneshot wall | 58 ms | 64 ms | 56 ms |
| uniform-10mb wall d/o | 395/360 ms | 483/481 ms | 420/442 ms (parity; RSS 12 MB ≤ 28 MiB cap) |
| stderr-mix-10mb wall d/o | 372/431 ms | 396/478 ms | 384/375 ms (parity; RSS 12 MB) |
| uniform-100mb wall d/o | 3560/3524 ms | 4428/4547 ms | 4242/4349 ms (+19/+23 %; RSS 6 MB) |
| stderr-mix-100mb wall d/o | 3506/3538 ms | 6011/4574 ms | 4453/4219 ms (+27/+19 %; RSS 6 MB) |
| yes-head-100mb wall d/o | 5407/5387 ms | 5132/4996 ms | **3146/3033 ms (−42/−44 %)** |
| giant-100mb wall d/o | 608/613 ms | 1225/1827 ms | 1151/1135 ms (+88 %) |
| yes-head-100mb peak RSS | 1051.8 MB | 6.2 MB | 6.0 MB (flat; all 12 matrix caps green) |

Remaining gaps are structural and documented: per-line streaming bookkeeping
(~60-75 ns/line at 11M lines) on >16 MiB windowed streams, and the
scan-then-materialize double read on declined bands (giant single lines above
the threshold). Cold start, seq-class and the ≤16 MiB classes sit at oracle
parity; the RSS mission is unchanged (flat ~6 MB at 100 MB).

Latency follow-up pass (01:4x-02:1x, same host): stage timers bracketed the
seq50000 pipeline at read_append ~5.9 ms (child-dominated, overlapped),
compress ~1.6 ms, render ~0.01 ms. Two further cuts were tried and REVERTED
after same-window A/B showed no win: raw-buffer retention to skip the spill
read-back (per-request mmap/fault/growth costs exceed the saving) and a
multi-sweep restructure of the fused window scan (added passes, net wash).
Kept: `compress_output_stream`'s Memory arm now borrows via `from_utf8_lossy`
instead of cloning (strictly less work for sub-50 KiB outputs). Final binary
(f2cb082d): every dispatch class below oracle (seq50000 10.312 vs 10.899 ms,
stderr-mix 2.695 vs 5.352 ms); 32 MiB 123.7 MB/s vs baseline 178.0; matrix
12/12 green. The dispatch arm is at its structural floor for this tier —
remaining latency is child spawn/runtime (floor ~5-6 ms) plus the documented
streaming trade on >16 MiB outputs.

---

T6 matrix re-run 2026-11-09T00:37+06 by the orchestrator (bench-compare child lost mid-run; its Unit 2 observations corroborate §2); recovery pass §8 at 01:05. Raw artifacts: `~/.pi/efforts/pibash-fold-rss/` (tp-32mib.txt corpus, bench-tp.mjs driver, wire-yes-100mb-*.json); daemon raw at `/tmp/w1t3-rss.ndjson`.
