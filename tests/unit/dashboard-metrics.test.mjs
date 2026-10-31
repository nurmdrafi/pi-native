// Phase-1 aggregate metrics: additive fields on the snapshot aggregates and
// per-session detail — duration percentiles, turn latency pooled from raw
// assistant-message durationMs, tool errors joined from extract results,
// per-day turn/call counts, per-day compaction counts, the project-by-day
// cost cross product, per-model token mix, detail turn durationMs and full
// prompt text. Every shape here is additive: existing pinned fields keep
// their names and types.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { aggregateSessions, detailFor, readPrompts, summarizeSession } = await import(
  join(ROOT, "dashboard/scripts/data.mjs")
);
const { snapshotFor } = await import(join(ROOT, "dashboard/scripts/dashboard.mjs"));

// ── Fixture: one raw session file ─────────────────────────────────────────
const assistant = (rid, ts, durationMs) => ({
  type: "message",
  id: rid,
  parentId: null,
  timestamp: ts,
  message: {
    role: "assistant",
    timestamp: ts,
    responseId: rid,
    model: "m1",
    ...(durationMs != null ? { durationMs } : {}),
    usage: { cost: { total: 0.1 } },
    content: [],
  },
});
const compaction = (ts) => ({ type: "compaction", id: "cx", parentId: null, timestamp: ts, summary: "s" });

const dir = mkdtempSync(join(tmpdir(), "dash-metrics-"));
const fileA = join(dir, "s1.jsonl");
writeFileSync(
  fileA,
  [
    assistant("r1", "2026-10-01T10:00:00.000Z", 1200),
    assistant("r2", "2026-10-02T10:00:00.000Z", 2400),
    assistant("r3", "2026-10-02T11:00:00.000Z", 3600),
    assistant("r4", "2026-10-20T10:00:00.000Z", null),
    compaction("2026-10-02T12:00:00.000Z"),
    compaction("2026-10-02T13:00:00.000Z"),
    compaction("2026-10-20T09:00:00.000Z"),
    JSON.stringify({ type: "message", message: { role: "user", content: "first line\n\nsecond  para" } }),
    "",
  ]
    .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
    .join("\n"),
);

const extractA = {
  v: 2,
  sessionId: "s1",
  project: "/w/demo",
  path: fileA,
  turns: [
    { rid: "r1", ts: "2026-10-01T10:00:00.000Z", model: "m1", usage: { input: 100, output: 50, reasoning: 10, cacheRead: 200, cacheWrite: 20, cost: { total: 1 } } },
    { rid: "r2", ts: "2026-10-02T10:00:00.000Z", model: "m1", usage: { input: 10, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 2, cost: { total: 2 } } },
    { rid: "r3", ts: "2026-10-02T11:00:00.000Z", model: "m2", usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 3 } } },
  ],
  calls: [
    { id: "c1", name: "pibash", rid: "r1", ts: "2026-10-01T10:00:10.000Z" },
    { id: "c2", name: "piread", rid: "r1", ts: "2026-10-01T10:00:20.000Z" },
    { id: "c3", name: "pibash", rid: "r2", ts: "2026-10-02T10:00:10.000Z" },
  ],
  results: [
    { id: "c1", err: true, bytes: 0 },
    { id: "c2", err: false, bytes: 10 },
    { id: "c3", err: true, bytes: 0 },
  ],
  usage: {},
};
const sessionA = {
  sessionId: "s1",
  project: "/w/demo",
  firstTs: "2026-10-01T10:00:00.000Z",
  lastTs: "2026-10-20T10:00:00.000Z",
  turns: 3,
  cost: 6,
  toolCalls: 3,
  tools: { pibash: 2, piread: 1 },
  toolCosts: { pibash: 3, piread: 1 },
  durationSec: 500,
};
// A second project whose session has no extract: the lifetime fallback path.
const sessionF = {
  sessionId: "f1",
  project: "/w/flat",
  firstTs: "2026-10-05T09:00:00.000Z",
  lastTs: "2026-10-05T09:30:00.000Z",
  turns: 4,
  cost: 9,
  toolCalls: 7,
  tools: {},
  toolCosts: {},
  durationSec: 1800,
};

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ── duration percentiles ───────────────────────────────────────────────────
test("duration pools per-session durationSec into p50/p95 seconds", () => {
  const mk = (id, sec) => ({
    sessionId: id,
    project: "/p",
    firstTs: "2026-10-01T10:00:00Z",
    lastTs: "2026-10-01T10:30:00Z",
    turns: 1,
    cost: 1,
    toolCalls: 0,
    tools: {},
    durationSec: sec,
  });
  const agg = aggregateSessions([mk("a", 100), mk("b", 200), mk("c", 300)]);
  assert.deepEqual(agg.duration, { p50Sec: 200, p95Sec: 300 });
  assert.equal(agg.avgDurationSec, 200); // unchanged average
  // Under two samples the percentiles stay null (one sample is the average).
  assert.deepEqual(aggregateSessions([mk("a", 100)]).duration, { p50Sec: null, p95Sec: null });
});

// ── byDayCounts ────────────────────────────────────────────────────────────
test("byDayCounts tracks turns and calls per day beside byDay cost", () => {
  const agg = aggregateSessions([sessionA], { raw: [extractA] });
  assert.deepEqual(agg.byDayCounts, {
    "2026-10-01": { turns: 1, calls: 2 },
    "2026-10-02": { turns: 2, calls: 1 },
  });
  assert.ok(Math.abs(agg.byDay["2026-10-01"] - 1) < 1e-9); // byDay stays cost-only
});

test("byDayCounts falls back to lifetime turns/calls on the firstTs day", () => {
  const agg = aggregateSessions([sessionF]);
  assert.deepEqual(agg.byDayCounts, { "2026-10-05": { turns: 4, calls: 7 } });
});

test("byDayCounts respects the date window", () => {
  const agg = aggregateSessions([sessionA], {
    raw: [extractA],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-10-03T00:00:00Z"),
  });
  assert.deepEqual(agg.byDayCounts, { "2026-10-02": { turns: 2, calls: 1 } });
});

// ── projectDay ─────────────────────────────────────────────────────────────
test("projectDay is the project-by-day cost cross product", () => {
  const agg = aggregateSessions([sessionA, sessionF], { raw: [extractA] });
  assert.deepEqual(agg.projectDay.projects, ["/w/flat", "/w/demo"]); // byProject order: cost desc
  assert.deepEqual(agg.projectDay.days, ["2026-10-01", "2026-10-02", "2026-10-05"]);
  assert.deepEqual(agg.projectDay.cells, [
    [0, 0, 9],
    [1, 5, 0],
  ]);
});

// ── modelTokenMix ──────────────────────────────────────────────────────────
test("modelTokenMix pools per-model tokens and cost from extract turns", () => {
  const agg = aggregateSessions([sessionA], { raw: [extractA] });
  assert.deepEqual(agg.modelTokenMix.map((m) => m.model), ["m1", "m2"]); // cost desc, name asc on tie
  const m1 = agg.modelTokenMix[0];
  assert.deepEqual(m1, { model: "m1", turns: 2, input: 110, output: 55, reasoning: 11, cacheRead: 220, cacheWrite: 22, cost: 3 });
});

test("modelTokenMix counts only turns inside the window", () => {
  const agg = aggregateSessions([sessionA], {
    raw: [extractA],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-10-03T00:00:00Z"),
  });
  // Oct 1's m1 turn (input 100) is out; both Oct 2 turns are in, cost desc.
  assert.deepEqual(agg.modelTokenMix, [
    { model: "m2", turns: 1, input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 3 },
    { model: "m1", turns: 1, input: 10, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 2, cost: 2 },
  ]);
});

// ── errors ─────────────────────────────────────────────────────────────────
test("errors joins extract results to calls by id, per tool", () => {
  const agg = aggregateSessions([sessionA], { raw: [extractA] });
  assert.equal(agg.errors.toolErrors, 2);
  assert.equal(agg.errors.toolErrorRate, 0.6667);
  assert.deepEqual(agg.errors.byTool, [
    { tool: "pibash", errors: 2, calls: 2, rate: 1 },
    { tool: "piread", errors: 0, calls: 1, rate: 0 },
  ]);
});

test("errors counts only calls inside the window", () => {
  const agg = aggregateSessions([sessionA], {
    raw: [extractA],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-10-03T00:00:00Z"),
  });
  assert.equal(agg.errors.toolErrors, 1);
  assert.equal(agg.errors.toolErrorRate, 1);
  assert.deepEqual(agg.errors.byTool, [{ tool: "pibash", errors: 1, calls: 1, rate: 1 }]);
});

test("errors is empty and finite without raw extracts", () => {
  const agg = aggregateSessions([sessionF]);
  assert.deepEqual(agg.errors, { toolErrors: 0, toolErrorRate: 0, byTool: [] });
});

// ── compactionsByDay ───────────────────────────────────────────────────────
test("compactionsByDay counts raw compaction events per day", () => {
  const agg = aggregateSessions([sessionA], { raw: [extractA] });
  assert.deepEqual(agg.compactionsByDay, [
    { day: "2026-10-02", count: 2 },
    { day: "2026-10-20", count: 1 },
  ]);
});

test("compactionsByDay respects the date window", () => {
  const agg = aggregateSessions([sessionA], {
    raw: [extractA],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-10-03T00:00:00Z"),
  });
  assert.deepEqual(agg.compactionsByDay, [{ day: "2026-10-02", count: 2 }]);
});

// ── turnLatency ────────────────────────────────────────────────────────────
test("turnLatency pools raw assistant durationMs into p50/p95", () => {
  const agg = aggregateSessions([sessionA], { raw: [extractA] });
  assert.deepEqual(agg.turnLatency, { p50Ms: 2400, p95Ms: 3600 });
});

test("turnLatency respects the date window", () => {
  const agg = aggregateSessions([sessionA], {
    raw: [extractA],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-10-03T00:00:00Z"),
  });
  assert.deepEqual(agg.turnLatency, { p50Ms: 2400, p95Ms: 3600 }); // r2+r3 in window
});

test("turnLatency stays null without durationMs samples", () => {
  const agg = aggregateSessions([sessionF]);
  assert.deepEqual(agg.turnLatency, { p50Ms: null, p95Ms: null });
});

test("summarizeSession exposes the session's own turn latency", () => {
  const s = summarizeSession(extractA);
  assert.deepEqual(s.turnLatency, { p50Ms: 2400, p95Ms: 3600 });
});

// ── detailFor ──────────────────────────────────────────────────────────────
test("detail turns carry durationMs joined by response id", () => {
  const d = detailFor(extractA);
  assert.equal(d.turns[0].durationMs, 1200); // rid r1
  assert.equal(d.turns[1].durationMs, 2400); // rid r2
  // A turn whose rid has no raw match omits the key entirely.
  const d2 = detailFor({
    ...extractA,
    turns: [{ rid: "rX", ts: "2026-10-01T10:00:00.000Z", model: "m1", usage: { cost: { total: 1 } } }],
  });
  assert.equal("durationMs" in d2.turns[0], false);
});

test("readPrompts keeps the full text beside the preview", () => {
  const prompts = readPrompts(fileA);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, "first line\n\nsecond  para");
  assert.equal(prompts[0].preview, "first line second para");
});

// ── snapshot passthrough ───────────────────────────────────────────────────
test("snapshotFor carries the new aggregates through unchanged", () => {
  const base = {
    raw: [structuredClone(extractA)],
    sessions: [{ ...sessionA }],
    active: [],
    generatedAt: "2026-10-31T00:00:00.000Z",
  };
  const snap = snapshotFor(base, { from: null, to: null });
  assert.equal(snap.aggregates.errors.toolErrors, 2);
  assert.deepEqual(snap.aggregates.byDayCounts["2026-10-01"], { turns: 1, calls: 2 });
  assert.equal(snap.aggregates.compactionsByDay.length, 2);
  assert.deepEqual(snap.aggregates.duration, { p50Sec: null, p95Sec: null }); // one session only
});
