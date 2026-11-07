# benchmark/

Suites live in per-arm directories; each arm owns its own `bench.mjs`, `results/` (raw NDJSON, one object per run) and a summary md per run tag.

## rss-arm — peak-RSS arm

`rss-arm/` measures whole-process peak resident memory (KiB) of the native tools (`bin/piread`, `bin/pibash`, `bin/piwrite`) against the pi built-in equivalents driven in-process by node, on identical frozen deterministic workloads (windowed read of a 150k-line corpus, a `seq 1 50000` stream capture, a 100 MB write). Sampling is `/usr/bin/time -v` (ru_maxrss = VmHWM, KiB); medians over interleaved warm runs, plus rerun spread. Run it:

    node benchmark/rss-arm/bench.mjs --selftest
    node benchmark/rss-arm/bench.mjs --full --tag v1   # appends per invocation; reruns accumulate for spread

Results: `rss-arm/results/results-<date>[-<tag>].ndjson`, summary `rss-arm/results/summary-<date>[-<tag>.md`, consolidated rows in `/tmp/bench-rss.ndjson`. Methodology is documented in each summary md.
