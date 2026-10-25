import test from "node:test";
import assert from "node:assert/strict";

import { shiftSpansForEdit } from "../extensions/permission-gate/read-coverage.ts";
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
