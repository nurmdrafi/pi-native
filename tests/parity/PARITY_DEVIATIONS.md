# Parity deviations

Intentional deviations of the native tools from their built-in oracles, with
the token impact and the affected assertions. Any change listed here must be
the *only* reason an otherwise-parity assertion differs; everything else stays
byte-identical (see `tests/*-parity.test.mjs`).

## piread — `PI_READ_LINE_CAP` (default OFF)

**What.** When `PI_READ_LINE_CAP` is set to a positive integer, native piread
truncates each selected line longer than the cap to that many characters and
appends `...[+N chars]` (N = characters dropped). Lines at or under the cap,
and all whitespace, are untouched. When unset (default) or non-positive, the
output is byte-identical to the built-in read.

**Why.** From real session logs, lines over 2,000 chars accounted for 1.490% of
all read bytes (26 lines across 25 calls, 136,556 bytes) — above the 0.5%
threshold set for this change. A default cap would break `edit`'s exact
matching, so the cap is opt-in only and never rewrites normal lines.

**Token impact.** Off by default: zero. When enabled, proportional to the
oversized-line share (≈1.5% of read bytes corpus-wide; lines up to 40,010
chars were observed).

**Decision (2026-10-17): stays OFF by default.** `edit` matches `oldText`
against the file base content, not read output, so a model that reads a capped
line and then edits exactly that line would produce a non-matching `oldText`.
The cap is therefore a deliberate opt-in for read-only exploration, not a
default. This is a recorded decision, not an unfinished flag.

**Affected assertions.** `tests/piread-parity.test.mjs`:
- `line-cap: default OFF keeps long lines byte-identical to the oracle`
  (the default path is unchanged).
- `line-cap: set caps only lines over the limit, tagging the dropped count`.
- Rust unit tests: `pipeline::tests::file::line_cap_truncates_only_long_lines`,
  `tests::parses_line_cap_and_defaults_off`.

## piread — `details.via` and `details.fallbackReason`

**What.** Native piread results carry `details.via` with the serving rung:
`"daemon" | "oneshot" | "builtin"`. On the terminal builtin rung (a real
fallback) they also carry `details.fallbackReason` (the cause string). The
built-in read tool has neither field.

**Why.** Previously the rung was advertised by appending a `"\n[piread native]"`
marker to the model-visible `content[].text`. That text was never needed by the
model — the file contents are the same regardless of rung — and it cost ~4
model tokens (16 bytes) on every read call. Moving the signal to `details`
keeps observability (permission-gate coverage, tests) while removing the
model-visible cost. `details` is TUI/structured metadata and does not enter the
model context (working rule 4).

**Token impact.** −16 bytes (−4 est. tokens) per successful read call. On the
`read small (4ln)` fixture this is the entire delta: native and built-in are now
byte-identical (`0.0%`), down from `+69.6%`.

**Affected assertions.** `tests/piread-parity.test.mjs`:
- `parityCase` asserts `details.via` is one of the three rungs, then deletes it
  and collapses an empty `details` back to `undefined` (the built-in's shape)
  before the structural compare.
- The concurrent-dispatch case does the same normalization.
- Both marker-strip sites (previously `MARKER = "\n[piread native]"`) are gone.
- The cross-rung parity test asserts `via`/
  `fallbackReason` per rung and that content bytes are identical across all
  three rungs for the same input.

**Note on `fallbackReason`.** The direct-image path returns `via: "builtin"`
with **no** `fallbackReason` — images are routed to the built-in by design, not
because a rung failed, so advertising a fallback cause would be misleading.
The daemon and one-shot rungs likewise carry no `fallbackReason`.

**Not a deviation.** The `content[].text` itself is now byte-identical to the
built-in for every text case; the marker removal *restores* parity rather than
breaking it.
