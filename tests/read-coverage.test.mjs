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
