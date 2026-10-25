# piread Compaction: EOF-Sourced Tail — Design Note

Status: **dropped after measurement** (backlog §5; perf gate — see §7)
Created: 2026-10-26
Scope: `custom-tools/piread/src/` (compress.rs, pipeline.rs), read-coverage contract (§9).

## 1. Problem

Backlog §5: compaction tails the *already-truncated* body. On a 6001-line
whole-file read, the 2000-line truncation window is compacted to head 24 lines
plus a tail of ~13 lines taken from *lines ~1988–2000 of the body* — the tail
of the truncation window, not of the file. The tail's whole purpose ("where a
summary or final state usually lives") is defeated: the reader sees the middle
of the file, not its end.

## 2. Decision

When the rendered body does **not** reach end-of-file, the compaction tail is
sourced from the file's real last lines (the last `tail_lines_budget` lines,
byte-trimmed by the same `take_tail` budget as today). When the body already
ends at EOF (untruncated windowed reads), the body tail *is* the real tail and
the current path is kept.

Precedent: head-tail truncation in shipped agent harnesses preserves the first
and last N bytes of the **real** content with a marker between (e.g.
arXiv 2603.05344: 10 K head + 10 K tail of the actual file); conversation
compaction keeps recency. Tail-of-window is the outlier; tail-of-file is the
norm.

## 3. Trade-off: head and tail describe different byte ranges

Accepted. The head describes the selection's start; the tail describes the
file's end. The two runs are separated by an omission marker whose line count
is the **true file-level gap** (`file_total − tail_kept − (start + head_kept)`),
not the body-internal gap. This is the load-bearing choice — see §4.

The marker's *chars* field stays body-measured (body chars minus head chars):
counting chars of never-decoded middle lines would mean a full-file UTF-8
validation pass on every oversized read — a scan-cost regression for a number
only a human reads. The *lines* field is what machines consume, and it is
file-honest.

## 4. Parity & read-coverage story

- **Parity suite**: unaffected. It pins `PI_READ_COMPRESS=0`; with compaction
  off, `read_text` output is byte-identical to the built-in (compaction is a
  post-pass in `read_text_compacted` only).
- **read-coverage (`renderedSpansFromBlocks`)**: no change needed, by design.
  It walks the rendered text: head lines certify `[start, start+head)`, the
  marker advances the cursor by its stated line count, tail lines certify the
  run that follows. With the marker's count now the true file gap, that cursor
  arithmetic lands the tail run exactly on the file's last lines —
  `[T−tail_kept+1, T]`. Certification remains "only what was rendered entered
  context": the middle stays uncertified (still readable later), the tail is
  certified precisely because it *was* rendered. Overlap fallback: if
  `start + head + tail > file_total` (tiny file, windowed near EOF), the tail
  reverts to the body tail — the old shape, still cursor-correct.
- **Continuation notice**: stays verbatim and last. It describes the
  *truncation* ("Showing lines 1-2000 of 6001. Use offset=2001"), which is
  pinned unrewritten by `tests/piread-huge.test.mjs`; the EOF tail is extra
  context on top, not a rewrite of the truncator's facts.

## 5. Cost model (perf gate)

The tail lines are fetched by a backward `tail(1)`-style read after the main
scan: one seek + one 16 KiB read when the last lines fit (typical), doubling
the window (capped at 4 MiB) only when lines are huge. No per-line work is
added to the streaming scan; the pure `read_text` parity path is untouched.
Guarded skips: single-line files, bodies that already end at EOF, any IO
failure → old body-tail path. The `lines2500` bench arm exercises the changed
path; p50s must stay flat (measured before/after, never asserted).

## 6. What changes for the reader

Before: `L1..L24 · [omitted …] · L1988..L2000 · [Showing lines 1-2000 of 6001…]`
After: `L1..L24 · [omitted …/5964 lines …] · L5989..L6001 · [Showing lines 1-2000 of 6001…]`

The reader learns the file's final state in the same budget the old tail
spent on the truncation window's tail.

## 7. Outcome: implemented, measured, dropped (perf gate)

The full implementation (backward `tail(1)`-style probe, file-level marker
gap, notice-split generalization, overlap fallback; 74/74 `cargo test`,
piread-huge 9/9, gate 279/279, check green) measured on the microbench
harness (`tests/piread-bench.mjs`, N=200/arm):

| corpus (daemon p50) | before | after | Δ |
| --- | ---: | ---: | ---: |
| lines2500 (compaction arm) | 0.181 ms | 0.241 ms | **+0.060 ms (+33%)** |
| bytes60k (compaction arm) | 0.197 ms | 0.202 ms | +0.005 ms |
| all other arms | — | — | flat |

The +33% was stable across runs (20–30× run-to-run noise) and is the
EOF-tail probe's IO: a second open + seek + 16 KiB read per oversized read.
Reusing the read pipeline's already-open fd would save roughly half of it,
but no variant reaches flat — knowing the file's last lines costs either a
second IO pass or per-line bookkeeping on every read. Per the standing
instruction (measurable performance loss ⇒ drop), the runtime change was
reverted; production piread is byte-identical to 1.52.0.

Kept: this note, the measurement, and a `renderedSpansFromBlocks`
gap-cursor property test in `tests/read-coverage.test.mjs` locking the
parser behavior any re-adoption would rely on. Re-adoption path: reuse the
scan's open fd for the tail probe (est. +0.03 ms) and accept a small,
bounded p50 cost — a product decision, not a technical one.
