import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = pathToFileURL(join(ROOT, "scripts", "lessons-check.mjs")).href;
const { checkLine, checkFile } = await import(BIN);

const NOW = new Date("2026-11-02T08:00:00Z");
const L = (ts, source, lesson, extra = {}) =>
  JSON.stringify({ ts, source, lesson, ...extra });

const codes = (res, level, line) =>
  res.findings
    .filter((f) => f.level === level && (line == null || f.line === line))
    .map((f) => f.code);

test("clean three-line file: no findings, clean summary, no fails", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "daemon exits silently when the queue drains"),
      L("2026-11-02T06:10:00Z", "b", "widget redraws after a session starts"),
      L("2026-11-02T06:20:00Z", "c", "paths carried over from a stale cd resolve nowhere"),
    ],
    NOW,
  );
  assert.deepEqual(res.findings, []);
  assert.equal(res.fail, 0);
  assert.equal(res.warn, 0);
  assert.equal(res.summary, "3 lines, 0 fail, 0 warn");
});

test("checkLine accepts a well-formed object", () => {
  const obj = { ts: "2026-11-02T06:00:00Z", source: "a", lesson: "fine" };
  assert.deepEqual(checkLine(obj, { now: NOW }), []);
});

test("checkLine flags keys that are not exactly ts,source,lesson", () => {
  const missing = checkLine(
    { ts: "2026-11-02T06:00:00Z", source: "a" },
    { now: NOW },
  );
  assert.deepEqual(missing.map((f) => f.code), ["BAD_KEYS"]);
  const extra = checkLine(
    { ts: "2026-11-02T06:00:00Z", source: "a", lesson: "b", note: "x" },
    { now: NOW },
  );
  assert.deepEqual(extra.map((f) => f.code), ["BAD_KEYS"]);
});

test("checkLine flags naive and future timestamps as BAD_TS", () => {
  const naive = checkLine(
    { ts: "2026-11-02T06:00:00", source: "a", lesson: "b" },
    { now: NOW },
  );
  assert.equal(naive[0].code, "BAD_TS");
  const future = checkLine(
    { ts: "2026-11-02T09:00:00Z", source: "a", lesson: "b" },
    { now: NOW },
  );
  assert.equal(future[0].code, "BAD_TS");
});

test("checkLine flags absolute user paths as IDENTITY", () => {
  const mac = checkLine(
    { ts: "2026-11-02T06:00:00Z", source: "a", lesson: "crash under /Users/nur/proj" },
    { now: NOW },
  );
  assert.equal(mac[0].code, "IDENTITY");
  const linux = checkLine(
    { ts: "2026-11-02T06:00:00Z", source: "a", lesson: "crash under /home/bob/proj" },
    { now: NOW },
  );
  assert.equal(linux[0].code, "IDENTITY");
});

test("checkLine allows neutral path shapes", () => {
  const res = checkLine(
    {
      ts: "2026-11-02T06:00:00Z",
      source: "a",
      lesson: "use ~/.pi/agent, <project-root>/wt/x, relative/x.ts, /tmp/out.md",
    },
    { now: NOW },
  );
  assert.deepEqual(res, []);
});

test("BAD_JSON: an unparseable line fails at its line number", () => {
  const res = checkFile([L("2026-11-02T06:00:00Z", "a", "ok"), "not-json{"], NOW);
  assert.equal(res.fail, 1);
  assert.deepEqual(codes(res, "FAIL", 2), ["BAD_JSON"]);
});

test("BAD_JSON: a JSON value that is not an object fails", () => {
  const res = checkFile(["[1,2]"], NOW);
  assert.deepEqual(codes(res, "FAIL", 1), ["BAD_JSON"]);
});

test("BAD_KEYS: a missing lesson key fails at file level", () => {
  const res = checkFile(['{"ts":"2026-11-02T06:00:00Z","source":"a"}'], NOW);
  assert.deepEqual(codes(res, "FAIL", 1), ["BAD_KEYS"]);
});

test("BAD_TS: a future timestamp fails at file level", () => {
  const res = checkFile([L("2026-11-02T09:00:00Z", "a", "x")], NOW);
  assert.deepEqual(codes(res, "FAIL", 1), ["BAD_TS"]);
});

test("IDENTITY: an absolute user path fails at file level", () => {
  const res = checkFile(
    [L("2026-11-02T06:00:00Z", "a", "log at /Users/nur/agent/lessons")],
    NOW,
  );
  assert.deepEqual(codes(res, "FAIL", 1), ["IDENTITY"]);
});

test("DUP: a near-duplicate pair is warned once, at the later line, exit stays clean", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "reader gate blocks cat reads use piread windows"),
      L("2026-11-02T06:01:00Z", "b", "reader gate blocks cat reads uses piread windows"),
    ],
    NOW,
  );
  assert.equal(res.fail, 0);
  assert.equal(res.warn, 1);
  assert.equal(res.summary, "2 lines, 0 fail, 1 warn");
  assert.deepEqual(codes(res, "WARN"), ["DUP"]);
  assert.equal(res.findings[0].line, 2);
  assert.match(res.findings[0].detail, /line 1/);
});

test("DUP: three similar lines yield each unordered pair exactly once", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "reader gate blocks cat reads use piread windows"),
      L("2026-11-02T06:01:00Z", "b", "reader gate blocks cat reads uses piread windows"),
      L("2026-11-02T06:02:00Z", "c", "reader gate blocks cat reads use piread windows daemon"),
    ],
    NOW,
  );
  assert.deepEqual(
    res.findings.map((f) => [f.line, f.detail.match(/line (\d+)/)[1]]),
    [
      [2, "1"],
      [3, "1"],
      [3, "2"],
    ],
  );
});

test("ORDER: a ts earlier than the previous line warns", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:10:00Z", "a", "first lesson topic alpha"),
      L("2026-11-02T06:00:00Z", "b", "second lesson topic beta"),
    ],
    NOW,
  );
  assert.equal(res.fail, 0);
  assert.deepEqual(codes(res, "WARN"), ["ORDER"]);
  assert.equal(res.findings[0].line, 2);
});

test("ORDER: equal timestamps are not a dip", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "first lesson topic alpha"),
      L("2026-11-02T06:00:00Z", "b", "second lesson topic beta"),
    ],
    NOW,
  );
  assert.deepEqual(res.findings.filter((f) => f.code === "ORDER"), []);
});

test("YEAR_MIX: a year differing from the previous line warns", () => {
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "typed the year right"),
      L("2025-11-02T06:00:00Z", "b", "typed the year wrong"),
    ],
    NOW,
  );
  assert.ok(codes(res, "WARN").includes("YEAR_MIX"));
});

test("dirty file: one line per FAIL and WARN code, ordered findings, summary", () => {
  const later = new Date("2027-06-01T00:00:00Z");
  const res = checkFile(
    [
      L("2026-11-02T06:00:00Z", "a", "reader gate blocks cat reads use piread windows"),
      L("2026-11-02T06:01:00Z", "b", "reader gate blocks cat reads uses piread windows"),
      L("2026-11-02T06:00:30Z", "c", "unrelated subject about pane sizing"),
      L("2027-01-05T00:00:00Z", "d", "another unrelated subject about logs"),
      "not-json{",
      '{"ts":"2027-02-01T00:00:00Z","source":"e"}',
      L("2028-01-01T00:00:00Z", "f", "future stamp topic"),
      L("2027-03-01T00:00:00Z", "g", "mentions /Users/nur/agent once"),
    ],
    later,
  );
  assert.deepEqual(
    res.findings.map((f) => `${f.level} ${f.line} ${f.code}`),
    [
      "WARN 2 DUP",
      "WARN 3 ORDER",
      "WARN 4 YEAR_MIX",
      "FAIL 5 BAD_JSON",
      "FAIL 6 BAD_KEYS",
      "FAIL 7 BAD_TS",
      "FAIL 8 IDENTITY",
    ],
  );
  assert.equal(res.summary, "8 lines, 4 fail, 3 warn");
  assert.ok(res.fail > 0); // the bin exits 1 when fail > 0
});

test("blank lines are skipped and do not count as lines", () => {
  const res = checkFile([L("2026-11-02T06:00:00Z", "a", "ok"), "", "  "], NOW);
  assert.equal(res.summary, "1 lines, 0 fail, 0 warn");
});
