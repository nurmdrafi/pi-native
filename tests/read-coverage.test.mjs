import test from "node:test";
import assert from "node:assert/strict";

import { shiftSpansForEdit, renderedSpansFromBlocks, subtractSpan } from "../extensions/permission-gate/read-coverage.ts";
import { globToRegex } from "../extensions/permission-gate/search-guard.ts";

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

test("subtractSpan splits a straddling span into both uncovered sides", () => {
  assert.deepEqual(subtractSpan([{ start: 1, end: 60 }], { start: 10, end: 20 }), [
    { start: 1, end: 9 },
    { start: 21, end: 60 },
  ]);
});

test("subtractSpan keeps disjoint spans and drops a fully covered one", () => {
  const spans = [
    { start: 1, end: 9 },
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ];
  assert.deepEqual(subtractSpan(spans, { start: 10, end: 20 }), [
    { start: 1, end: 9 },
    { start: 30, end: 40 },
  ]);
});

test("subtractSpan clips an Infinity tail past a finite window", () => {
  assert.deepEqual(subtractSpan([{ start: 1, end: Infinity }], { start: 10, end: 20 }), [
    { start: 1, end: 9 },
    { start: 21, end: Infinity },
  ]);
  assert.deepEqual(subtractSpan([{ start: 1, end: Infinity }], { start: 1, end: Infinity }), []);
});
