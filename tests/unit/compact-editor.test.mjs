import test from "node:test";
import assert from "node:assert/strict";

import { clampEditorLines, MAX_EDITOR_LINES } from "../../extensions/compact-editor/clamp.ts";

const line = (i) => `line ${i}`;

test("short input is returned unchanged", () => {
  const lines = [line(1), line(2), line(3)];
  const out = clampEditorLines(lines, 10);
  assert.deepEqual(out, lines);
});

test("input exactly at the cap is unchanged", () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(i));
  const out = clampEditorLines(lines, 10);
  assert.deepEqual(out, lines);
});

test("long input is clamped to the requested number of lines", () => {
  const lines = Array.from({ length: 200 }, (_, i) => line(i));
  const out = clampEditorLines(lines, 10);
  assert.equal(out.length, 10);
});

test("clamping keeps the head and the tail, dropping the middle", () => {
  const lines = Array.from({ length: 100 }, (_, i) => line(i));
  const out = clampEditorLines(lines, 10);
  assert.equal(out[0], line(0), "first line must survive");
  assert.equal(out.at(-1), line(99), "cursor line (last) must survive");
});

test("the dropped-count notice appears exactly once", () => {
  const lines = Array.from({ length: 100 }, (_, i) => line(i));
  const out = clampEditorLines(lines, 10);
  const notices = out.filter((l) => l.includes("more line"));
  assert.equal(notices.length, 1);
});

test("the notice reports the true number of dropped lines", () => {
  const lines = Array.from({ length: 100 }, (_, i) => line(i));
  const cap = 10;
  const out = clampEditorLines(lines, cap);
  const notice = out.find((l) => l.includes("more line"));
  const dropped = Number(notice.match(/\[(?:\.\.\. )?(\d+) more line/)[1]);
  assert.equal(dropped, lines.length - (cap - 1));
});

test("a cap of 1 still yields a single non-empty line", () => {
  const lines = Array.from({ length: 50 }, (_, i) => line(i));
  const out = clampEditorLines(lines, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0], line(49), "with no room for a notice, keep the tail");
});

test("empty input stays empty", () => {
  assert.deepEqual(clampEditorLines([], 10), []);
});

test("the default cap is a small positive number", () => {
  assert.ok(Number.isInteger(MAX_EDITOR_LINES) && MAX_EDITOR_LINES > 0);
});
