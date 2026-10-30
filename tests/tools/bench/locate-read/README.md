# locate-read bench

Measures the built-in read tool (TypeScript) against the Rust-native
piread — default paged mode and fused `--hits` — on real lookup tasks.
Five arms, same 27 tasks:

| arm | mechanism | bytes | calls | ms |
|-----|-----------|------:|------:|---:|
| A | built-in read tool (TypeScript, in-process via `builtin-read.mjs`): whole file under the built-in caps, follow-up window when the target sits past the truncation | 399,683 | 11 | 41 |
| B | memory → `rg -n <symbol>` locate → exact window read (2 calls) | 70,146 | 48 | 156 |
| C | memory → fused locate+read (1 call; python simulation of the shape) | 71,034 | 27 | 138 |
| D | the fused tool as built: `piread --path f --hits <symbol>`, same memory protocol as C | 72,445 | 27 | 92 |
| E | piread default paged mode: whole file under the 100-line / 8 KB budget, gap markers beyond it, plus the follow-up `--offset/--limit` read when the target sits in the gap | 292,672 | 43 | 157 |

Bytes are the model-visible payload (envelope stdout for the piread arms,
content + details JSON for the built-in arm) — the token proxy; calls are
tool calls (turn proxy); ms is wall time. The Rust-conversion story: D
ships 0.18x the built-in read's bytes (5.5x less context per lookup) and
0.25x piread's own paged default with 27 vs 43 calls, landing within 2% of
the C simulation. A is fastest per wall ms — in-process, no spawn, and
whole-file reads serve repeats from memory — but every cold lookup re-ships
the whole file; bytes are the cost that compounds in context.

## Why this target

Session-transcript replay (`churn.mjs`, last 24 h, 67 sessions): 1756 piread
calls, 1056 gapped (60%), 482 gap-aimed follow-up reads (28% of all calls).
The 100-line / 8 KB budget removes 786 of the 1056 gaps; of the 270 left,
only 21 have a small middle (<=60 lines, `churn-gap-size.mjs`) — so the win
has to come from not paging at all, which is the fused mode.

## Method

`proto.py` builds one task per definition row in `bin/outline <file>` for the
FILES corpus below (27 tasks): pick a target line, then run each arm and
count what that arm would have shipped to a model.

- A runs the real built-in read tool in-process (`builtin-read.mjs`, which
  self-links the pi package), whole file per cold task, and counts the
  model-visible payload (content + details JSON); it adds the follow-up
  windowed read's bytes/call when the target lands past the truncation.
- B runs `bin/rg -n <symbol> f`, then `bin/piread --offset/--limit` on the
  merged hit windows (+-12 lines), 2 calls per cold task.
- C simulates the fused shape: same `rg` locate, but windows and hit rows
  render in one result (1 call).
- D runs the shipped fused mode, `bin/piread --path f --hits <symbol>`
  (1 call).
- E runs the shipped paged default, `bin/piread --path f` (100-line / 8 KB
  budget, gap markers), and adds the follow-up read when the target lands
  in the gap.
- A/B/C/D/E keep span caches keyed by (path, 20-line bucket): a warm task
  costs a ~40-byte pointer (or nothing), 1 call.

Arms are read-only; nothing in the repo is modified. Numbers above are from
the run saved in `results.txt` (re-running varies ms only). Corpus files
evolve with the tree — earlier runs on a younger tree measured different
absolutes; relative ratios are the stable signal.

## Inputs

Corpus is the working tree: 10 files spanning Rust sources, TypeScript
extensions, a generator script, and one Markdown doc (see `FILES` in
`proto.py`; `AGENTS.md` has no outline defs and yields no tasks). Tools
used: `bin/piread`, `bin/rg`, `bin/outline`, and the pi package's built-in
read tool (in-process, `builtin-read.mjs`).

## Re-run

    python3 tests/tools/bench/locate-read/proto.py     # A–E table
    node tests/tools/bench/locate-read/churn.mjs       # transcript replay
    node tests/tools/bench/locate-read/churn-gap-size.mjs

`churn.mjs` / `churn-gap-size.mjs` read session transcripts under
`~/.pi/agent/sessions` modified in the last 24 h; their numbers drift as
sessions accumulate.
