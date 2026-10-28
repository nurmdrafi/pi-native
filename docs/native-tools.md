# Native tools

Four Rust crates in `rust-tools/` register as their own first-class tools, so the TUI shows `piread` / `piedit` / `pibash` / `pidx` instead of shadowing the built-ins. Parameters match the built-in tool verbatim; dispatch goes through a persistent `--serve` daemon (no per-call process spawn), falling back to a one-shot CLI spawn and then the built-in implementation. Every failure path falls back rather than breaking the session.

| Tool     | Replaces                       | Notes                                                             |
| -------- | ------------------------------ | ---------------------------------------------------------------- |
| `piread` | built-in `read` (text files)   | images stay on `read`                                             |
| `piedit` | built-in `edit`                | edit-kind in permission-gate, so Anchor Guard and coverage binding apply unchanged; native diff/patch render |
| `pibash` | built-in `bash`                | bash-kind in permission-gate, so the H1 cap, R10 re-run guard, and destructive analysis apply unchanged |
| `pidx`   | Node session-log parser        | compact per-session extracts, incremental via a (size, mtime) cache |

`pidx` reports replace the ad-hoc session scripts: `--report usage` (model, turns, tokens, cache share, cost) and `--report lifecycle [--session ID]` (per-turn ledger plus `dupCall` / `resendAfterBlock` / `probeRepeat` / `proseOnly` waste detectors), with `--max N` and `--session ID` bounding the slice. A session modified in the last five minutes is excluded from discovery (`ACTIVE_SESSION_MS`), so an audit run mid-session covers only completed sessions: pass `--session <id>` for a specific older one, and never read a report as live coverage.

Built-in `bash` is blocked while `pibash` is registered (permission-gate "Pibash-first"), so shell work runs through the native pipeline — `pibash` runs the same schema and rules and falls back itself, so the block never strands the agent.

**Tool versions** (source of truth: each crate's `Cargo.toml`): `piread` 0.2.0 · `piedit` 0.2.0 · `pibash` 0.1.0 · `pidx` 0.1.0.

Native tools forward the context env keys the built-in tools inject — `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` — so commands see the same `PI_*` context. `PI_CODING_AGENT_DIR` overrides the config directory, `PI_PIDX_MAX_INLINE` changes the inline extract cap (default 2000 chars), and `PI_READ_LINE_CAP` caps piread line width (default off; when set to a positive integer, lines over the cap are truncated to that many characters plus a `...[+N chars]` marker, leaving shorter lines and whitespace byte-identical). `PI_READ_COMPRESS` controls piread's head-tail compaction (**on by default**: a read larger than 40 lines / 2 KB is reduced to a head+tail window with an `[... omitted N chars / M lines ...]` marker, keeping the `[Showing lines A-B of C ...]` notice last; `details.compaction.omissions[]` carries each cut as `{startLine, endLine, chars, lines}` in absolute file lines — the coverage map the permission gate certifies gaps from; `0`/`false`/`off` restores byte-for-byte parity with the built-in `read`, which is what the parity suite and `piedit`'s exact matching depend on). `PI_READ_BIN` / `PI_EDIT_BIN` / `PI_BASH_BIN` / `PI_PIDX_BIN` override the corresponding native binary path (`bin/<tool>` by default); they exist for the parity suites, which point an extension at a throwaway binary to exercise the one-shot rung, plus non-standard installs — not needed in normal use. `PI_COMPACT_EDITOR_LINES` caps the prompt editor height (default 10 lines); a longer buffer keeps its head and tail with an `[... N more lines ...]` notice in between, so a pasted prompt cannot push the transcript off screen.

Parity is pinned by `tests/parity/piread-parity.test.mjs`, `tests/parity/piedit-parity.test.mjs`, and `tests/parity/pibash-parity.test.mjs`, plus `tests/tools/audit/diff-fuzz.mjs` and `tests/integration/pibash-large-output.test.mjs` (1 MB spill/envelope/RSS regression). Measured speedups and full methodology live in [`benchmark/runs/`](../benchmark/runs) and [`CHANGELOG.md`](../CHANGELOG.md). Architecture deep-dive: [`docs/rust-tools-architecture.md`](rust-tools-architecture.md).

## Performance

Dispatch latency, p50 ms — `built-in` is the stock pi tool (bash/read/edit), `native` is the replacement. The native tools replace a per-call process spawn with a persistent `--serve` daemon, so the win is the amortized spawn floor (~3.7–3.8 ms pinned on 2026-10-28, 1.8–2.0 ms on the quieter 2026-10-26 host), not output shaping. Absolute numbers are wall-clock on one machine and move with hardware and load; the Δ column is the comparison that matters. In every table below, `built-in` / `oracle` names the same stock pi TypeScript tool the native tool replaces — the parity oracle the native path must byte-match. For model-context cost (bytes actually entering the transcript) see [Context shaping](#context-shaping-what-enters-the-model) below — that is the other half of the story, and the one that compounds across turns. Sources: the `piread`, `piedit` and `pibash` rows are medians of three pinned runs on 2026-10-28 (records in [`benchmark/runs/`](../benchmark/runs); UTC dates), the `pidx` row is a live cold/warm run on the same day — regenerate with `npm run bench:piread`, `npm run bench:piedit`, `npm run bench:pibash`.

| Tool     | Replaces        | Representative case                 | built-in p50 | native p50   | Δ p50     |
| -------- | --------------- | ----------------------------------- | -----------: | -----------: | --------- |
| `piread` | built-in `read` | one-line file                       | 0.300 ms     | 0.087 ms     | **−0.21** |
| `piread` | built-in `read` | 2500-line window                    | 0.782 ms     | 0.389 ms     | **−0.39** |
| `piedit` | built-in `edit` | mid exact (1800 B)                  | 0.820 ms     | 0.330 ms     | **−0.49** |
| `piedit` | built-in `edit` | 1 MiB file (588,890 B)              | 99.232 ms    | 36.392 ms    | **2.7×**  |
| `pibash` | built-in `bash` | `printf`                             | 5.095 ms     | 3.174 ms     | **−1.92** |
| `pibash` | built-in `bash` | `seq 50000`                          | 18.204 ms    | 12.567 ms    | **−5.64** |
| `pidx`   | Node log parser | 511 sessions / 110 MB (cold → warm) | —            | 2.1 s → 28 ms | **n/a**   |

`pibash` was the one tool with a class above its oracle until 2026-10-28. Original regression (2026-10-17): +3.57 ms at p50, widening with output size — the envelope shipped the payload twice (`content[0].text` + `structuredContent.output`), structural and parity-pinned. **Fixed since** (single-materialization envelope, copy-on-write compression stages, one shared line split — see [`docs/rust-tools-architecture.md`](rust-tools-architecture.md) § pibash; `rust-tools/pibash/bench-seq50000.mjs`): daemon p50 15.78 → 13.46 ms on 2026-10-19, wire bytes unchanged, parity pinned. Re-audited 2026-10-26: the residual was +0.66/+0.85 ms — the parity-pinned envelope plus the Tier-1 compression pre-pass, work the built-in never does (the in-process oracle arm also skips the serialization a real session pays). That was accepted at the time and is **resolved on 2026-10-28**: every class now sits below the built-in oracle (`seq 50000` −5.64 ms, `large-blob` −3.02 ms). One thing did turn out droppable on 2026-10-28: `OutputAccumulator::append_decoded_text` scanned every chunk three times (`match_indices`, then `matches().count()`, then `rfind`); the count now comes out of the loop that already visits the newlines. Byte-identical output (15-file `cat` corpus plus `seq 50000`, path/timing fields excluded), **−0.87 ms on `seq 50000`** (12.71 → 11.84 ms median, 5 interleaved pinned rounds, ~7%), unchanged at `seq 2500`. The stage split on 489 KB / 50k lines is now `append` 3.2 ms, `head_tail` 2.7 ms, `split_lines` 1.6 ms, snapshot 0.1 ms — no single dominant stage left. `pidx` is a daemonless one-shot CLI, so it has no oracle/daemon split; its figures are a live cold/warm run on this repo's corpus and have no committed bench file yet. Re-measured 2026-10-28 (511 sessions / 110 MB, pinned): full re-parse 2.1 s, warm run 28 ms. The warm path previously rewrote the 15 MB extract file on every call — the store is unchanged, so that file is unchanged too, and an up-to-date file is now left untouched (444 → 28 ms median, 3 rounds; ~16x).

### Run-to-run stability (piread, 2026-10-28 pinned rerun)

Method: stale `--serve` daemons killed, each bench pinned to one core (`taskset -c 3`), three sequential runs, per-arm median below. Pinning cut the oracle arm's spread on `lines2500` from 0.99–1.32 ms to 0.76–0.80 ms, which is what makes the Δ quotable: it is now −0.39 ms ± 0.01 across runs, against −0.46 to −0.80 when the runs float across cores. The daemon leads the oracle on every corpus in every run; the closest call is `bytes60k` (−0.03 ms), where both arms are doing the same 60 KB of I/O.

| corpus | built-in p50 | daemon p50 | Δ p50 | one-shot p50 |
| --- | ---: | ---: | ---: | ---: |
| one-line | 0.300 | 0.087 | **−0.21** | 3.53 |
| crlf | 0.297 | 0.072 | **−0.23** | 3.40 |
| unicode | 0.284 | 0.071 | **−0.21** | 3.43 |
| long-lines | 0.287 | 0.098 | **−0.19** | 3.48 |
| lines2500 | 0.782 | 0.389 | **−0.39** | 4.03 |
| bytes60k | 0.479 | 0.449 | **−0.03** | 4.41 |
| head60k | 0.380 | 0.165 | **−0.22** | 4.02 |

Daemon peak RSS ~2 MB (vmhwm, Linux probe); one-shot pays the spawn floor every call — ~3.3–3.5 ms on the 2026-10-28 host, 1.9–2.1 ms on the quieter 2026-10-26 host.

**Scan rework (2026-10-28).** `piread` no longer calls `read_until` per line: it searches
each fill buffer with `memchr`, and once the head buffer is saturated it counts later
selected lines without decoding them. Output is byte-identical (128 corpus × argument cases,
CLI and daemon). None of the corpora above moves, because they are all ≤2,500 lines /
60 KB and the run is I/O-bound at that size; large reads do: 250,000 lines / 5.7 MB went
from 15.7 ms to 7.9 ms median (interleaved A/B, 5 rounds).

<details>
<summary>Per-tool detail</summary>

**piread** vs the built-in `read` (N=200/arm, 10 warmup; p50 ms):

| corpus | built-in `read` p50 | `piread` daemon p50 | `piread` one-shot p50 | Δ p50 |
| --- | ---: | ---: | ---: | ---: |
| one-line | 0.130 | 0.052 | 1.921 | −0.078 |
| crlf | 0.133 | 0.041 | 1.894 | −0.092 |
| unicode | 0.128 | 0.042 | 1.884 | −0.086 |
| long-lines | 0.129 | 0.046 | 1.881 | −0.083 |
| lines2500 | 0.361 | 0.179 | 2.053 | −0.182 |
| bytes60k | 0.221 | 0.170 | 2.066 | −0.051 |
| head60k | 0.182 | 0.064 | 1.896 | −0.118 |

`piread` is **byte-identical** to the built-in `read` on every text case that fits the model-visible budget (see `npm run bench:model-visible:compare`); larger reads are head-tail compacted by default, so their content is a bounded window rather than the full 2000-line cap — set `PI_READ_COMPRESS=0` to restore exact parity. The daemon path wins on every corpus (~3.4x on small reads, ~2.3x on 2,500 lines in the 2026-10-28 rerun), and the one-shot path pays the spawn floor.

**piedit** (N=100/arm; median of three pinned runs on 2026-10-28; oracle vs piedit p50 ms):

| corpus | bytes | built-in p50 | piedit p50 | Δ p50 |
| --- | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.567 | 0.302 | −0.265 |
| mid-exact | 1800 | 0.820 | 0.330 | −0.490 |
| mid-multi | 1800 | 0.718 | 0.353 | −0.365 |
| fuzzy-trailing-ws | 30 | 0.609 | 0.254 | −0.355 |
| multiline-block | 18890 | 2.445 | 1.033 | −1.412 |
| large-1mib | 588890 | 99.232 | 36.392 | −62.840 |

The third run of that set overlapped a host load spike — spawn floor 3.6 → 5.3 ms — and inflated
both arms by ~40%; the medians above absorb it, and `large-1mib` held at 34–37 ms through all
three, which is the diagnostic that it measures I/O rather than the edit path. An earlier
quiet-host run recorded 4.2 ms for that class against today's 36 ms for identical code, because
that class writes the file and prints ~1.2 MB of `baseContent`+`newContent` per call. Stage timers
on 589 KB put the in-process work at ~5.7 ms (envelope 2.3 ms, apply 2.7 ms, scans 0.7 ms); the
rest is read, write and stdout.

**pibash** (N=60/arm; oracle vs daemon p50 ms; median of three pinned runs on 2026-10-28 —[`benchmark/runs/pibash-microbench-2026-10-27.md`](../benchmark/runs/pibash-microbench-2026-10-27.md)):

| command class | built-in p50 | pibash p50 | Δ p50 |
| --- | ---: | ---: | ---: |
| true | 5.202 | 3.070 | −2.13 |
| printf | 5.095 | 3.174 | −1.92 |
| rg-version | 6.837 | 4.778 | −2.06 |
| seq1000 | 5.590 | 3.844 | −1.75 |
| seq2500 | 7.149 | 4.658 | −2.49 |
| seq50000 | 18.204 | 12.567 | −5.64 |
| large-blob | 9.400 | 6.377 | −3.02 |
| stderr-mix | 6.005 | 3.019 | −3.00 |
| exit-nonzero | 5.592 | 2.881 | −2.71 |

Every class is now below the oracle, including `seq 50000` and `large-blob`, which were the two
above it in the 2026-10-26 audit; the host is slower overall (spawn floor ~5.0 ms here vs ~1.9 ms
then), so compare the Δ within a run, not the absolutes across audits.

Spawn floor per session: ~5.0 ms on the 2026-10-28 host (paid once, not per call). Daemon RSS is not reported here: the resident-set probe used by `piread`/`pibash` benchmarks reads `/proc`, so it is Linux-only and is skipped elsewhere.

</details>

## Context shaping: what enters the model

| Case | native bytes | built-in bytes | Δ |
| --- | ---: | ---: | ---: |
| `read ~100ln` | 1,898 | 4,435 | **−57.2%** |
| `read ~300ln` | 1,675 | 12,343 | **−86.4%** |
| `read ~1000ln` | 1,945 | 41,275 | **−95.3%** |
| `read ~1922ln` | 2,040 | 51,188 | **−96.0%** |
| `bash 1300 lines` | 171 | 5,393 | **−96.8%** |
| `bash 10k lines` | 173 | 10,129 | **−98.3%** |
| `bash failing test-like` | 807 | 42,144 | **−98.1%** |
| `bash interleaved warnings` | 258 | 2,584 | **−90.0%** |
| **all cases (TOTAL)** | **15,569** | **273,312** | **−94.3%** |

Reads and shell output converge on roughly the same ~2 KB ceiling regardless of source size — cost stops scaling with the file instead of growing linearly.

**How each tool shapes:**

| Tool | Strategy | Notes |
| --- | --- | --- |
| `pibash` | head-tail / error-priority | command-aware (`Test`/`Build`/`Git`/`Search`/`Log`/`Generic`); failures keep a 2/3 tail, successes a 2/3 head; full output spilled to a temp file |
| `piread` | head-tail | 2/3 head : 1/3 tail; the `[Showing lines A-B of C …]` continuation notice is always kept last, so the reader still learns the file continues |
| `piedit` | none (bounded by design) | returns a status line + diff; `renderDiff` keeps the content pair out of the boundary entirely |
| `pidx` | pointer only | extracts written to a file and rewritten only when the cache changes; only a compact pointer line enters context, hard-capped at `PI_PIDX_MAX_INLINE` (default 2000 chars) |

Every approach considered (external prior art included), its measured output, and why head-tail + line-exact `omissions[]` won: [`research/piread-compaction-approaches.md`](../research/piread-compaction-approaches.md).
