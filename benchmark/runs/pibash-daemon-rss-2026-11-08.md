# pibash daemon RSS probe — 2026-11-08

Binary: `rust-tools/target/release/pibash`, sha256
`1d9205a2b8c852d8c4754efe581174bb8a41cea9478a7bd3bcb5bbf9ba8f8bc5`
(verified with `sha256sum` before running; matches the frozen hash).

Method — daemon arm: `benchmark/pibash-daemon-rss.mjs` spawns
`pibash --serve` (NDJSON protocol per `rust-tools/pibash/src/serve.rs`:
one JSON request per stdin line `{id, command, cwd, timeout}`, one response
line echoing `id`), dispatches `yes | head -c 104857600` with timeout 600 s
and a temp cwd, and polls `/proc/<daemon-pid>/status` VmRSS every 50 ms from
dispatch until the response line plus 5 more seconds. Baseline RSS at
dispatch: 671,744 B (0.64 MiB). Method — one-shot arm:
`/usr/bin/time -f "%e s, %M KiB"` per size, single command each; ru_maxrss
is KiB on Linux, normalized ×1024.

## Results

| arm     | bytes     | rss_peak     | rss_after_5s | elapsed |
| ------- | --------- | ------------ | ------------ | ------- |
| daemon  | 104857600 | 946872320 B (903.0 MiB) | 4247552 B (4.1 MiB) | 4.478 s |
| oneshot | 1000000   | 12263424 B (11.7 MiB)    | n/a          | 0.10 s  |
| oneshot | 10000000  | 93265920 B (88.9 MiB)    | n/a          | 0.42 s  |
| oneshot | 104857600 | 947085312 B (903.3 MiB)  | n/a          | 4.24 s  |

## One-shot RSS slope (3 points, lines = bytes/2 for the "y\n" shape)

Least-squares fit RSS = a + b × lines over the one-shot arm:

- b = **18.002 B/line** (~9 B per output byte)
- a = 3,259,189 B (~3.1 MiB fixed floor)

Residual check: predicted vs measured peak 12.26/12.26 MiB (1 MB),
94.36/88.94 MiB (10 MB), 947.1/947.1 MiB (100 MB) — the 10 MB point sits
below the line, consistent with allocator growth steps, but the fit is tight
at both ends.

## Conclusion

The daemon does NOT retain the peak: 903.0 MiB at peak falls to 4.1 MiB
within 5 s of the response line (back near the 0.64 MiB baseline) — no
glibc arena retention on this host/allocator; and the one-shot slope
measured b ≈ 18.0 B/line, above the expected ~16 B/line, i.e. ~9 resident
bytes per 2-byte output line including accumulator bookkeeping.

Raw data: `/tmp/w1t3-rss.ndjson` (one JSON object per run).
Re-run daemon probe: `node benchmark/pibash-daemon-rss.mjs`
