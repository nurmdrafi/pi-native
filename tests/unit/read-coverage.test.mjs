import test from "node:test";
import assert from "node:assert/strict";

import { shiftSpansForEdit, renderedCoverageFromBlocks, renderedSpansFromBlocks, overlapLines, recordGaps } from "../../extensions/permission-gate/rules/read-coverage.ts";
import { globToRegex } from "../../extensions/permission-gate/rules/search-guard.ts";

test("shiftSpansForEdit keeps above, shifts below, drops straddlers", () => {
  const spans = [
    { start: 1, end: 5 }, // above the edit — unchanged
    { start: 8, end: 12 }, // straddles firstEditedLine 10 — dropped
    { start: 15, end: 20 }, // below — shifts by delta
    { start: 30, end: Infinity }, // below, open-ended — shifts, stays open
  ];
  assert.deepEqual(shiftSpansForEdit(spans, 10, 2), [
    { start: 1, end: 5 },
    { start: 17, end: 22 },
    { start: 32, end: Infinity },
  ]);
});

test("shiftSpansForEdit with zero delta is identity on non-straddling spans", () => {
  const spans = [{ start: 5, end: 6 }, { start: 11, end: 14 }];
  assert.deepEqual(shiftSpansForEdit(spans, 10, 0), [
    { start: 5, end: 6 },
    { start: 11, end: 14 },
  ]);
});

// Backlog §8 (2026-10-18): per-edit rebasing — a span shifts by the deltas of
// the regions ABOVE it only, and a span straddling a region SPLITS into its
// unchanged head (original numbers) and shifted tail instead of being
// dropped wholesale (the write→edit wipe: [1,∞] straddling any edit used to
// erase whole-file coverage and block the next edits on self-authored lines).
test("shiftSpansForEdit with regions rebases by per-edit deltas (not the call total)", () => {
  const regions = [
    { start: 50, end: 52, delta: 3 }, // +3 above the span
    { start: 300, end: 301, delta: -2 }, // below the span — must not apply
  ];
  const spans = [
    { start: 100, end: 110 }, // between the regions — shifts by +3, not the +1 total
    { start: 400, end: 410 }, // below both — shifts by the cumulative +1
  ];
  assert.deepEqual(shiftSpansForEdit(spans, 50, 1, regions), [
    { start: 103, end: 113 },
    { start: 401, end: 411 },
  ]);
});

test("shiftSpansForEdit with regions splits a straddling span into head + shifted tail", () => {
  const regions = [{ start: 30, end: 32, delta: 2 }];
  const spans = [{ start: 1, end: Infinity }];
  assert.deepEqual(shiftSpansForEdit(spans, 30, 2, regions), [
    { start: 1, end: 29 }, // unchanged head keeps its numbers
    { start: 35, end: Infinity }, // tail (33+) shifts by +2
  ]);
});

test("shiftSpansForEdit without regions keeps the legacy drop-straddlers path", () => {
  // write result: no regions, no firstEditedLine — the whole prior union goes
  const spans = [{ start: 1, end: Infinity }];
  assert.deepEqual(shiftSpansForEdit(spans, undefined, 0), []);
});

// Backlog §9 (2026-10-25): a compacted (elided) read certified its FULL
// requested window, so the omitted middle was R1-blocked as already-in-context
// while its bytes were never rendered. The parser below maps only the
// rendered runs onto file lines; piread's compress.rs emits exactly one
// "[... omitted D chars / N lines ...]" marker with blank separators.
test("renderedSpansFromBlocks maps head/marker/tail onto file lines", () => {
  const mk = (n, off) => Array.from({ length: n }, (_, i) => `L${off + i}`);
  const content = [
    {
      type: "text",
      text: [
        ...mk(3, 225),
        "",
        "[... omitted 1942 chars / 24 lines ...]",
        "",
        ...mk(2, 252),
      ].join("\n"),
    },
  ];
  assert.deepEqual(renderedSpansFromBlocks(content, 225), [
    { start: 225, end: 227 },
    { start: 252, end: 253 },
  ]);
});

test("renderedSpansFromBlocks without a line-omission marker is undefined", () => {
  assert.equal(
    renderedSpansFromBlocks([{ type: "text", text: "a\nb" }], 1),
    undefined,
  );
  // chars-only marker omits no whole lines — legacy whole-window certification
  assert.equal(
    renderedSpansFromBlocks(
      [{ type: "text", text: "a\n[... omitted 10 chars ...]\nb" }],
      1,
    ),
    undefined,
  );
});

// C3 (2026-10-27): structured omissions[] from details.compaction.
test("renderedCoverageFromBlocks prefers consistent structured omissions and reports gaps", () => {
  const mk = (n, off) => Array.from({ length: n }, (_, i) => `L${off + i}`);
  const content = [
    {
      type: "text",
      text: [
        ...mk(3, 225),
        "",
        "[... omitted 1942 chars / 24 lines ...]",
        "",
        ...mk(2, 252),
      ].join("\n"),
    },
  ];
  const structured = [
    { startLine: 228, endLine: 251, chars: 1942, lines: 24 },
  ];
  const got = renderedCoverageFromBlocks(content, 225, structured);
  assert.deepEqual(got.spans, [
    { start: 225, end: 227 },
    { start: 252, end: 253 },
  ]);
  assert.deepEqual(got.gaps, [{ start: 228, end: 251 }]);
  // agreement by construction: the regex walk yields the same coverage
  assert.deepEqual(renderedCoverageFromBlocks(content, 225, null), got);
});

test("inconsistent structured omissions fall back to the marker walk (fence)", () => {
  const mk = (n, off) => Array.from({ length: n }, (_, i) => `L${off + i}`);
  const content = [
    {
      type: "text",
      text: [
        ...mk(3, 225),
        "",
        "[... omitted 1942 chars / 24 lines ...]",
        "",
        ...mk(2, 252),
      ].join("\n"),
    },
  ];
  // right count, wrong position: the tail would resync early and over-cover
  // — the fence must reject it and keep the walked spans
  const lie = [{ startLine: 100, endLine: 123, chars: 1942, lines: 24 }];
  assert.deepEqual(
    renderedCoverageFromBlocks(content, 225, lie),
    renderedCoverageFromBlocks(content, 225, null),
  );
  // count mismatch (two cuts claimed vs one marker): ignored wholesale
  const two = [
    { startLine: 228, endLine: 233, chars: 900, lines: 6 },
    { startLine: 234, endLine: 251, chars: 1042, lines: 18 },
  ];
  assert.deepEqual(
    renderedCoverageFromBlocks(content, 225, two),
    renderedCoverageFromBlocks(content, 225, null),
  );
});

test("recordGaps merges into the coverage entry's gap union", () => {
  const coverage = new Map();
  coverage.set("f", { spans: [{ start: 1, end: 10 }], kind: "read" });
  recordGaps(coverage, "f", [{ start: 3, end: 5 }]);
  recordGaps(coverage, "f", [{ start: 4, end: 8 }]);
  assert.deepEqual(coverage.get("f").gaps, [{ start: 3, end: 8 }]);
  // no entry or no gaps: no-op
  recordGaps(coverage, "nope", [{ start: 1, end: 1 }]);
  recordGaps(coverage, "f", []);
  assert.equal(coverage.get("nope"), undefined);
});

// Backlog §5 (2026-10-26): EOF-sourced compaction tails were implemented,
// measured (+33% p50 on the compacting bench arm — the backward-tail file
// probe), and dropped per the perf gate; the runtime shape never ships.
// This locks the parser's gap-cursor property for any re-adoption: a marker
// whose line count is the file-level gap must land the tail run exactly on
// the file's last lines — no over-certification of the never-rendered
// middle, no loss of the tail. See
// docs/specs/2026-10-26-piread-compaction-eof-tail.md.
test("renderedSpansFromBlocks maps an EOF-sourced tail onto file-end lines", () => {
  const tail = Array.from({ length: 13 }, (_, i) => `E${String(5989 + i).padStart(6, "0")}`);
  const text = [
    ...Array.from({ length: 24 }, (_, i) => `E${String(i + 1).padStart(6, "0")}`),
    "",
    "[... omitted 15808 chars / 5964 lines ...]",
    "",
    ...tail,
    "",
    "[Showing lines 1-2000 of 6002. Use offset=2001 to continue.]",
  ].join("\n");
  assert.deepEqual(renderedSpansFromBlocks([{ type: "text", text }], 1), [
    { start: 1, end: 24 },
    { start: 5989, end: 6001 },
  ]);
});

test("renderedSpansFromBlocks strips the trailing continuation notice", () => {
  const text =
    "h1\nh2\n\n[... omitted 5 chars / 3 lines ...]\n\nt1\n\n[Showing lines 1-10 of 40. Use offset=11 to continue.]";
  assert.deepEqual(renderedSpansFromBlocks([{ type: "text", text }], 1), [
    { start: 1, end: 2 },
    { start: 6, end: 6 },
  ]);
});

test("globToRegex survives '?' globs and matches single-level", () => {
  const re = globToRegex("content[]?"); // threw "Unterminated character class" before the fix
  assert.ok(re);
  assert.ok(re.test("content[]x"));
  assert.ok(!re.test("content[]/x"));
  const ts = globToRegex("*.ts");
  assert.ok(ts.test("a.ts"));
  assert.ok(!ts.test("dir/a.ts"));
  const q = globToRegex("a?c");
  assert.ok(q.test("abc"));
  assert.ok(!q.test("a/c"));
});

test("overlapLines counts the covered part of a window (R1x fraction)", () => {
  // 20 of 40 covered → exactly the 50% bar
  assert.equal(
    overlapLines([{ start: 10, end: 49 }], { start: 30, end: 69 }),
    20,
  );
  // disjoint union: both pieces count, gaps do not
  assert.equal(
    overlapLines(
      [
        { start: 1, end: 9 },
        { start: 30, end: 40 },
      ],
      { start: 5, end: 35 },
    ),
    11,
  );
  // Infinity tail covers any finite window start
  assert.equal(
    overlapLines([{ start: 90, end: Infinity }], { start: 100, end: 120 }),
    21,
  );
  assert.equal(overlapLines([], { start: 1, end: 10 }), 0);
});
