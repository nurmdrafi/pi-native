# piread Fused Locate+Read (`--hits`): Finalized Spec

Design note, 2026-10-31.

> **Status: spec locked, Rust build landed (2026-10-31).** Winner of the
> bench (`tests/tools/bench/locate-read/`): arm C — one call that
> locates a symbol and returns its exact windows — ships 0.18x the bytes
> of the built-in read and 0.25x of piread's paged default on 27 real
> lookup tasks; the built `--hits` binary (bench arm D) lands within 2%
> of the simulation and is the fastest locating arm. The two-call
> locate-then-read pattern (482 gap-aimed follow-ups in one day of
> transcripts) is the churn this removes.

## 1. Problem and shape

A lookup read today is two turns: a locate (`rg -n`) then a windowed read
aimed at the hit. Process spawn dominates latency, so the second turn is
pure cost. The fused mode makes it one call: the read tool itself locates
the needle and prints only the merged windows around the hits, within the
existing read budget. The span cache stays model-side (memory of what was
already printed); the binary is stateless.

Measured (`tests/tools/bench/locate-read/`, 27 lookup tasks over 10 repo
files; stdout bytes = token proxy; re-run with `python3 proto.py`):

| arm | mechanism | bytes | calls | ms |
|-----|-----------|------:|------:|---:|
| A | built-in read tool (TypeScript, in-process) | 399,683 | 11 | 41 |
| B | `rg` locate then exact window (2 calls) | 70,146 | 48 | 156 |
| C | fused, simulated | 71,034 | 27 | 138 |
| D | fused as built (`--hits`, real binary) | 72,445 | 27 | 92 |
| E | piread paged default + gap follow-ups | 292,672 | 43 | 157 |

D ships 0.18x A's bytes — 5.5x less context per lookup — and 0.25x E's
bytes with 27 vs 43 calls. A is fastest per wall ms (in-process, no spawn)
and needs fewest calls, but every cold lookup re-ships whole files: bytes,
not ms, are the cost that compounds. B shows the two-call variant is not
worth it: bytes drop but calls rise and time worsens. Caveat: C/D's
warm-lookup cache credits a 40-byte pointer for repeats; cold-call bytes
are the solid core of the ratio claims.

## 2. CLI contract

    piread --path <P> --hits <NEEDLE> [--line-cap <N>]

- `--hits <NEEDLE>` selects fused mode. NEEDLE is matched literally,
  case-sensitively, as a substring per line — no regex. Identifier-shaped
  needles hit exactly the lines `rg -n <needle> <file>` reports.
- `--offset`/`--limit` together with `--hits` is a usage error (exit 2):
  the mode is a locator, not a pager, and a combined form is unpromised.
- Empty needle is a usage error. `--hits=<NEEDLE>` inline form is accepted.
- `--line-cap` applies as in default mode (per-line character cap).
- Default mode output is byte-identical to before (parity suite pins it).

## 3. Selection algorithm

1. Open, decode, binary-sniff exactly as the default read. The `binary`
   flag propagates in the envelope as in default mode; the scan itself runs
   over the lossy text (a NUL-bearing file without the needle simply misses).
2. Hit lines: every 1-based line number whose text contains NEEDLE.
3. Windows: for each hit `h`, `[max(1, h - 12), h + 12]` (12 =
   `read.locate.context`). Merge while the next window starts at or before
   the previous end + 1 (adjacent counts as overlap).
4. Budget: printed lines <= `read.window.lines` (100) and rendered content
   <= `read.window.bytes` (8192). Fill merged windows in file order; the
   window being filled may be cut short when a budget runs out.
5. Line budget cuts mid-window (keep as many whole lines as fit); byte
   budget cuts at a line boundary — never mid-line, so every rendered line
   is a real file line and stays an edit anchor. The byte budget governs
   file lines and gap markers (lines stop 128 bytes early so the pending
   marker always fits); the footer below rides after the budget like the
   default mode's continuation note.

## 4. Rendering

- Every printed line is `N:text` with N the absolute 1-based file line —
  the same shape `rg -n` emits, so existing hit-line parsers (gate R1c)
  can read fused output unchanged.
- Between and around printed windows, an omission marker in the shared
  grammar, extended with the absolute range so the model can continue
  without a re-locate:
  `[... omitted D chars / L lines (a-b) ...]`
- After the last window, one pointer line lists hits that fell outside the
  printed windows (the remainder is hit lines, never a blind gap):
  `[hits beyond window: 214, 890, 1201, +2 more]`
  Listed numbers are capped at `read.locate.pointers` (40); overflow is the
  `+N more` suffix. Omitted entirely when everything printed.
- No hits: success envelope, content
  `[no lines matching '<NEEDLE>' in <P> (L lines, B bytes)]` — a one-line
  miss notice, not an error; the model re-plans on it.

## 5. Envelope

Default fields (`ok`, `content`, `truncation`, `binary`, `totalBytes`) are
unchanged and, in fused mode: `truncation` null (gaps are explicit markers,
not silent truncation), `compaction` null (content already fits budget).
Fused mode adds one field, absent otherwise:

    "locate": {
      "needle": "read_text",
      "hits": [44, 75],          // ascending, capped at read.locate.pointers
      "hitsTotal": 2,            // full match count
      "windows": [[32, 56]],     // printed windows, 1-based inclusive
      "totalLines": 2500         // whole-file line count (coverage domain)
    }

## 6. Daemon protocol (`--serve`)

Requests gain an optional string field `hits`. Present → fused path with the
same envelope; `hits` alongside `offset`/`limit`, or an empty string, is a
per-request protocol error envelope (id echoed). Absent → behavior unchanged.

## 7. Bounds (scripts/gen-bounds.mjs, generated files never hand-edited)

    read.locate.context  = 12   // lines of context each side of a hit
    read.locate.pointers = 40   // hit line numbers listed in the footer

Window and byte budgets reuse `read.window.lines` / `read.window.bytes`.

## 8. Out of scope here (follow-ups, surfaces already prepared)

- TS tool schema: **landed** — `hits` is exposed on the `piread` tool
  (TypeBox schema, daemon + one-shot plumbing, screening, `details.locate`,
  `renderCall` label; pinned by `tests/parity/piread-hits.test.mjs`).
- Read ledger: **landed** — fused records carry the selector and their true
  coverage: omissions are the complement of `locate.windows` over
  `totalLines` (a miss omits the whole file), so successors never mistake a
  windowed locate read for a full read.
- Gate R1c: certify fused reads off the structured `locate` field instead
  of sniffed hit lines. `rg`-shaped rendering keeps today's parser working
  until then; the ledger side of coverage is already honest (above).

## 9. Verification

- `cargo test -p piread`: cli parse/exclusivity, window merge, both budget
  cuts, footer cap, miss notice, binary path, envelope shape, daemon rules.
- `node --test tests/parity/piread-*.test.mjs`: default mode still
  byte-identical to the built-in read.
- Bench arm D (`proto.py`): the same harness against the real binary must
  land at arm C's numbers. Measured (current run, `results.txt`):
  D=72,445 B / 27 calls / 91.9 ms vs C=71,034 B (+2.0%); A (the built-in
  read) = 399,683 B / 11 calls — D ships 0.18x its bytes; E (piread's
  paged default) = 292,672 B / 43 calls — D is 0.25x its bytes.
