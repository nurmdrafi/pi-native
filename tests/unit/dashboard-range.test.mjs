// Range attribution on the server: a date window must clip cost to the turns
// that actually happened inside it. Summing whole-session lifetime totals for
// any session merely touched by the window showed months of spend under a
// one-day filter, and booked a multi-day session's entire cost on its first
// day. These tests pin turn/call-level attribution for the aggregates, the
// per-session views the client charts read, and the day-keyed spend rollup.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { aggregateModelMix, aggregateSessions, spendSummary } = await import(
  join(ROOT, "dashboard/scripts/data.mjs"),
);
const { snapshotFor } = await import(join(ROOT, "dashboard/scripts/dashboard.mjs"));

const turn = (ts, cost) => ({ ts, usage: { cost: { total: cost } } });
const call = (name, ts) => ({ name, ts });

// One multi-day session (lifetime cost 17 = 2+3+5+7): turns on Oct 1/2/20
// plus one turn without a timestamp; Read calls on Oct 1 and Oct 21, one
// Bash call on Oct 2. Lifetime toolCosts: Read 4 over 2 calls, Bash 3 over 1.
const extract = {
  sessionId: "s1",
  project: "/w/demo",
  path: "/w/demo/s1.jsonl",
  turns: [
    turn("2026-10-01T10:00:00Z", 2),
    turn("2026-10-02T10:00:00Z", 3),
    turn("2026-10-20T10:00:00Z", 5),
    turn(null, 7),
  ],
  calls: [
    call("Read", "2026-10-01T10:01:00Z"),
    call("Read", "2026-10-21T10:01:00Z"),
    call("Bash", "2026-10-02T10:01:00Z"),
  ],
  results: [],
  usage: {},
};
const session = {
  sessionId: "s1",
  project: "/w/demo",
  firstTs: "2026-10-01T10:00:00Z",
  lastTs: "2026-10-20T10:00:00Z",
  turns: 4,
  cost: 17,
  toolCalls: 3,
  tools: { Read: 2, Bash: 1 },
  toolCosts: { Read: 4, Bash: 3 },
};

// A session whose whole life predates any window used here.
const oldExtract = {
  sessionId: "s2",
  project: "/w/old",
  path: "/w/old/s2.jsonl",
  turns: [turn("2026-09-30T10:00:00Z", 100)],
  calls: [call("Read", "2026-09-30T10:01:00Z")],
  results: [],
  usage: {},
};
const oldSession = {
  sessionId: "s2",
  project: "/w/old",
  firstTs: "2026-09-30T10:00:00Z",
  lastTs: "2026-09-30T10:00:00Z",
  turns: 1,
  cost: 100,
  toolCalls: 1,
  tools: { Read: 1 },
  toolCosts: { Read: 100 },
};

const base = () => ({
  raw: [structuredClone(extract), structuredClone(oldExtract)],
  sessions: [{ ...session }, { ...oldSession }],
  active: [],
  generatedAt: "2026-10-31T00:00:00.000Z",
});

test("byProject cost counts only turns inside the window", () => {
  const agg = aggregateSessions([session], {
    raw: [extract],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-11-01T00:00:00Z"),
  });
  // In-window turns: Oct 2 (3) + Oct 20 (5) + the null-ts turn, which rides
  // the session's lastTs (Oct 20, in window) for another 7 -> 15, not 17.
  assert.equal(agg.byProject.length, 1);
  assert.equal(agg.byProject[0].project, "/w/demo");
  assert.equal(agg.byProject[0].cost, 15);
  assert.equal(agg.totals.cost, 15);
  assert.equal(agg.totals.turns, 3);
});

test("a null-ts turn is dropped when the session's last activity is outside the window", () => {
  const agg = aggregateSessions([session], {
    raw: [extract],
    from: Date.parse("2026-10-25T00:00:00Z"),
    to: null,
  });
  assert.equal(agg.totals.cost, 0);
  assert.equal(agg.totals.turns, 0);
  assert.equal(agg.byProject[0].cost, 0);
});

test("byDay books each turn on its own day, not the session's first day", () => {
  const agg = aggregateSessions([session], { raw: [extract] });
  assert.deepEqual(agg.byDay, {
    "2026-10-01": 2,
    "2026-10-02": 3,
    "2026-10-20": 12, // 5 + the null-ts turn riding lastTs
  });
});

test("tool calls count only calls inside the window and tool cost is prorated", () => {
  const agg = aggregateSessions([session], {
    raw: [extract],
    from: Date.parse("2026-10-02T00:00:00Z"),
    to: Date.parse("2026-11-01T00:00:00Z"),
  });
  // In-window calls: Read Oct 21 only (1 of 2 lifetime), Bash Oct 2 (1 of 1).
  assert.equal(agg.totals.toolCalls, 2);
  assert.equal(agg.toolAvgCost.Read, 2); // 4 * 1/2
  assert.equal(agg.toolAvgCost.Bash, 3); // 3 * 1/1
});

test("ranged snapshot clips the per-session view the client charts read", () => {
  const snap = snapshotFor(base(), { from: "2026-10-02T00:00:00Z", to: "2026-11-01T00:00:00Z" });
  assert.equal(snap.sessions.length, 1); // the September session is out
  const view = snap.sessions[0];
  assert.equal(view.tools.Read, 1);
  assert.equal(view.tools.Bash, 1);
  assert.equal(view.toolCosts.Read, 2); // 4 * 1/2
  assert.equal(view.toolCosts.Bash, 3);
  assert.equal(view.cost, 15);
  assert.equal(view.turns, 3);
  assert.equal(snap.aggregates.byProject.length, 1);
  assert.equal(snap.aggregates.byProject[0].cost, 15);
  assert.equal(snap.aggregates.totals.cost, 15);
});

test("unbounded snapshot keeps lifetime session values", () => {
  const snap = snapshotFor(base(), { from: null, to: null });
  assert.equal(snap.sessions.length, 2);
  const view = snap.sessions.find((s) => s.sessionId === "s1");
  assert.deepEqual(view.tools, { Read: 2, Bash: 1 });
  assert.deepEqual(view.toolCosts, { Read: 4, Bash: 3 });
  assert.equal(view.cost, 17);
  assert.equal(snap.aggregates.totals.cost, 117);
});

test("spendSummary buckets a multi-day session's spend by turn day", () => {
  const spend = spendSummary([session], new Date("2026-10-20T12:00:00Z"), { raw: [extract] });
  assert.equal(spend.today, 12); // Oct 20: 5 + 7, not the whole 17 on Oct 1
  assert.equal(spend.week, 12);
  assert.equal(spend.days.find((d) => d.day === "2026-10-20").cost, 12);
  assert.equal(spend.days.find((d) => d.day === "2026-10-14").cost, 0); // nothing bled in from Oct 1
});

// modelMix belongs to the same range contract: lifetime per-model usage
// totals must not leak into a windowed snapshot. The windowed rollup counts
// each model's turns stamped inside the window, under the same attribution
// rules as the cost aggregates (a turn without a timestamp rides the
// session's last activity and drops when that lies outside).
const mixExtract = {
  sessionId: "s3",
  project: "/w/mix",
  path: "/w/mix/s3.jsonl",
  turns: [
    { ts: "2026-10-01T10:00:00Z", model: "m1", usage: { cost: { total: 2 } } },
    { ts: "2026-10-02T10:00:00Z", model: "m1", usage: { cost: { total: 3 } } },
    { ts: "2026-10-10T10:00:00Z", model: "m2", usage: { cost: { total: 4 } } },
    { ts: "2026-10-20T10:00:00Z", model: "m2", usage: { cost: { total: 6 } } },
    { ts: null, model: "m1", usage: { cost: { total: 7 } } },
  ],
  calls: [],
  results: [],
  usage: { m1: { turns: 3, costTotal: 12 }, m2: { turns: 2, costTotal: 10 } },
};

test("modelMix counts only turns inside the window per model", () => {
  const mix = aggregateModelMix(
    [mixExtract],
    Date.parse("2026-10-02T00:00:00Z"),
    Date.parse("2026-10-11T00:00:00Z"),
  );
  // In-window: m1's Oct 2 turn and m2's Oct 10 turn only. m1's null-ts turn
  // rides the session's last activity (Oct 20) and drops out alongside the
  // Oct 1 and Oct 20 turns.
  assert.equal(mix.length, 2);
  assert.deepEqual(mix.find((m) => m.model === "m1"), { model: "m1", turns: 1, cost: 3 });
  assert.deepEqual(mix.find((m) => m.model === "m2"), { model: "m2", turns: 1, cost: 4 });
});

test("modelMix without a window keeps lifetime usage totals", () => {
  assert.deepEqual(aggregateModelMix([mixExtract]), [
    { model: "m1", turns: 3, cost: 12 },
    { model: "m2", turns: 2, cost: 10 },
  ]);
});
