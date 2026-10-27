# Rust Tool Optimization Workflow

Purpose: change a native tool's hot path without changing its observable output.
Applies to every crate under `rust-tools/` — the parity and envelope contracts
differ per tool, the procedure does not.

Rule of thumb: the risky part of a native-tool optimization is never the speed,
it is the byte the refactor quietly stops emitting.

## 1. Model the cost before editing

Three numbers decide whether the work is worth doing:

- **fixed cost** — spawn plus protocol. Time the tool's no-op path; treat the
  smaller repeat as the floor (piread's `--version` costs ~3.1 ms).
- **slope** — time the same call over three input sizes (for example 2.5k, 25k,
  250k lines) and subtract. The slope is the only part code change can move.
- **share of budget** — when fixed cost dominates, the lever is the daemon and
  the dispatch ladder, not the algorithm.

A tool whose slope is invisible at real input sizes needs no optimization,
however satisfying the rewrite is. Write the three numbers down before touching
code; they are also the baseline the change is judged against.

### Attribute cost by stage

A single end-to-end number cannot tell you which stage to fix. Add temporary
in-process timers around the pipeline's stages, run the bench, then remove the
timers — the probe is scaffolding, the numbers are the output. This is how the
pibash rework below was aimed: three full-stream passes plus a per-line `String`
malloc showed up as stage costs, not as a vague "compression is slow".

Record which axis you are moving. Milliseconds and tokens are different goals:
the pibash head-tail strategy was chosen to cut *output bytes* (−98.3% for a 10k
line command), and that decision would look like a regression if judged only by
wall clock.

## 2. Freeze the current build

Keep the pre-change binary as the oracle. Build a scratch copy of the workspace
whose `members` lists only the crate under change, revert the candidate edits in
that copy, and build it in release mode. Without that binary, "output is
identical" is an opinion rather than a measurement.

## 3. Pin the seam's contract first

Write characterization tests that describe what the seam *produces*: input bytes
to output segments, input request to output envelope. Run them against the
unchanged code — they must pass before the swap and after it.

Put them where the seam lives (`src/*.rs` test module), not at the tool's edge:
the edge is already covered by the parity suites, and the edge will not tell you
*which* internal rule broke.

## 4. Change one seam

Keep struct names, method signatures and ownership; replace only the internals.
Prefer the smallest seam that contains the cost — one method of one type, so
every caller keeps receiving exactly the bytes it received before.

Never add a rule that special-cases an input shape inside accounting logic. Two
accounting rules for one quantity is how the compaction gap bugs shipped; the fix
was one consistent rule, not a third exception.

## 5. Verification ladder

Run in this order; each step catches a different class of mistake.

1. `cargo test -p <crate>` — unit plus characterization.
2. `cargo clippy -p <crate> --all-targets` — none of these crates allow dead code.
3. Release build, then install through `scripts/lib/install-native.sh`: it stages
   and renames (a live daemon keeps the old inode) and re-signs for macOS.
4. `npm run daemons:kill` — otherwise a running daemon serves the *previous*
   binary for the rest of the session.
5. `npm test` — parity suites against the built-in oracle, plus cross-layer tests.
6. `npm run typecheck`, `npm run doc:check` (the one pre-existing finding is the
   baseline), `npm run gate:eval` (92/92 fixtures, recovery 0.93).
7. `npm run audit:bin-diff` with the frozen binary as old and the new build as
   new; add `--serve` with a recorded request stream to cover the daemon path.

Step 7 is the only step that compares old against new directly. The parity
suites compare the new build against the built-in tool, which answers a different
question: both can be green while the new binary differs from the old one.

## 6. Measure honestly

Interleave the two builds (A/B/A/B per round) instead of running one and then the
other, and run the same binary twice to publish the noise floor beside the delta.
Single-run per-arm numbers swing 25-40% on a developer machine; without a floor
any claimed win is unfalsifiable.

Report slope changes separately from small-input latency. Small inputs are
fixed-cost dominated and will not move, which is correct rather than a failure.

## 7. Land

Changelog entry proposed, not written; no commit, tag or version bump without
explicit permission.

## Worked examples (measured here)

Use these as scale references, not as targets; they show what a given class of
change buys in this codebase.

**pibash copy-on-write rework** — the reference success case. Technique: borrowed
fast paths (return the slice when nothing needs rewriting), one shared split
instead of three, no per-line allocation. Wire bytes unchanged, so every parity
suite stayed green. Measured on `seq 50000` (~290 KB / 50k lines), one-shot CLI:
`strip_ansi` 394 µs to 27 µs, `dedup` 2.06 to 1.64 ms, `head_tail` 1.93 to
0.72 ms, `compress_output` 9.6 to 2.5 ms, end-to-end p50 19.7 to 13.4 ms (−32%).
The full stage table lives in `docs/rust-tools-architecture.md` (context shaping).

**piread scan and decode** — a slope-only win, in two steps. Technique one:
replace per-line `read_until` with a `fill_buf` plus `memchr` search, same
`Segmenter` contract (~15% on a 250k-line read). Technique two: stop decoding and
buffering selected lines once the head buffer is saturated — they can never be
rendered, and the only field such a call still moved was a counter nothing reads
after the scan. Combined, a 250k-line / 5.7 MB read went from 15.7 ms to 7.9 ms
median (5 interleaved rounds), with a 2,500-line read flat at ~2.2 ms. Output was
byte-identical over 128 corpus x argument cases, CLI and daemon
(`npm run audit:bin-diff`). Lesson: a change that only removes per-line overhead
will not move small-input latency, and that is correct rather than a failure.

**piedit large-file path** — a measured dead end, and that is the point. The
suspect was `normalizeForFuzzyMatch`'s whole-content NFKC, which duplicate
counting triggers even for exact edits. Stage timers on 589 KB / 60k lines:
normalize 63 µs, line-ending detection 604 µs, apply 2.7 ms, envelope 2.3 ms —
about 5.7 ms in-process against ~17 ms end to end, so the rest is I/O (read,
write, and 1.18 MB of `baseContent`+`newContent` on stdout). The borrowed-view
guard still landed, because it is right: NFKC is skipped when the content is
ASCII with no trailing whitespace, and the `expect` panic on the view became a
fallback. It is worth ~0.5 ms — below the bench's noise floor. Lesson: the
obvious suspect can be under 5% of the call; twenty minutes of stage timers
prevents a rewrite that buys nothing.

**pibash accumulator** — the smallest useful win, found by the same stage timers.
`append_decoded_text` scanned each chunk three times: once for newline offsets, once
to count newlines, once for the trailing partial line. The count falls out of the
first loop for free. Measured −0.87 ms on a 290 KB / 50k-line command (12.71 →
11.84 ms median, 5 interleaved pinned rounds, ~7%), byte-identical output, and no
change on small commands. Lesson: scan-count duplication hides in plain sight — the
three scans were on adjacent lines, each individually reasonable.

**pidx warm run** — the largest win in the crate set, and it is a deletion of work.
The indexer already skipped rewriting its 15 MB store when nothing changed, but it
still rewrote the 15 MB extract file that is a pure function of that store. Warm run
444 → 28 ms median (~16x), full re-parse unchanged at ~2.1 s, extract output
byte-identical, and a truncated or missing file is still rebuilt. Lesson: check every
artifact a run writes, not just the one with the clever skip flag — the second file
was the entire cost.

**docheck probes** — parallelism where the work is process startup. `strace -f -e
execve` counted 2,771 child processes per run: one `--help` spawn per
(binary, flag) pair, with git's help path dragging `man` and its formatter along,
plus 112 `bash -n` block probes. The probe loop was already isolated behind
`flag_by_key`, so resolving it across cores was a contained change — results are
indexed, so findings stay byte-identical. 3.0 → 1.9 s on four cores; the rest is
the serial `bash -n` phase. Lesson: look for the loop that is already separate
from the output-formatting logic; parallelising that one keeps parity trivial.

**Fixed cost usually wins the ranking.** In-process tool-handler time is ~96 µs
mean / 81 µs p50 per call, while a one-shot spawn is ~3.1-3.5 ms and a warm
daemon answers at ~0.08 ms p50. For a short call, moving from one-shot to daemon
is worth ~40x; micro-optimizing the same call's algorithm is worth a fraction of
one percent. Optimize the rung before optimizing the code.

## Traps already paid for

- **Stale daemon.** After a reinstall the daemon keeps serving the previous
  binary; session audits then report phantom drift that looks like a regression.
- **Budget mismatch.** A compaction target must equal the consumer's cap
  (permission-gate H1: 40 lines / 2 KB) or the output is re-cut downstream and
  the savings never reach the model.
- **Per-line reads vs. chunked search.** Swapping per-line reads for a chunked
  buffer search helps only where the scan is the slope: measured ~15% on a
  250k-line read, zero below 25k lines.
- **Dead-after-the-scan state.** Before skipping work, prove nothing reads the
  state it maintained: `HeadTruncator::lines_seen` was bumped on every saturated
  line and never read again, which is what made the fast path byte-identical;
  verify it against the frozen binary, never by inspection alone.
- **Accounted vs. rendered lines.** Any line accounting must explain blank
  separators and trailing empty segments; those are the one-line drifts that made
  an elided line look covered.

## Related

- `docs/rust-tools-architecture.md` — crate layout, dispatch ladder, envelopes.
- `docs/change-discipline.md` — change ladder, root cause, deployment.
- `tests/README.md` — entry points for every audit and bench driver.
- `research/piread-compaction-approaches.md` — compaction methods tried, with
  outputs and verdict.
- `research/benchmark-observability.md` — which per-call measurements to record
  (queue vs work time, raw vs output bytes) so the next optimization starts with
  data instead of a hunch.
- `docs/plans/permission_gate_implementation_plan.md` §2 — the V-row validation
  table: speed ideas already measured and rejected in this repo (mmap shared
  state, `repr(C)` cross-process struct, telemetry sidecar, binary context
  injection), each with the reason it failed.
