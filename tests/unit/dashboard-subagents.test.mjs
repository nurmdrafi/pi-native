// Tier-B subagent metrics: latency percentiles, spawn-to-first-message lag
// and a global spawn timeline. Every new field is optional — summaries and
// snapshots produced before this change stay valid unchanged — and the
// percentile fields appear only once their pool holds at least two samples:
// a single sample is already reported exactly by avgLatencyMs, so a
// percentile of it adds no information.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { aggregateSessions, subagentMetrics } = await import(
  join(ROOT, "dashboard/scripts/data.mjs")
);

// One session's subagent traffic, all on 2026-10-29 (UTC). Latency is the
// call→result gap on subagent-family calls; the spawn lag is the gap from a
// subagent call to that instance's first subagent_message call.
// Per-message latencies: r1 spawn 20s, r1 msgs 20s + 40s, r2 spawn 10s,
// r2 msg 30s, b1 spawn 90s → global pool [20,20,40,30,90]k, scout
// [20,20,40,30]k, builder [90]k. Spawn lags: r1 60s, r2 30s (b1 never got
// a message).
const calls = [
  { id: "c1", name: "subagent", ts: "2026-10-29T10:00:00Z" },
  { id: "c3", name: "subagent_message", ts: "2026-10-29T10:01:00Z" },
  { id: "c4", name: "subagent_message", ts: "2026-10-29T10:02:00Z" },
  { id: "c6", name: "subagent_message", ts: "2026-10-29T10:03:00Z" },
  { id: "c2", name: "subagent", ts: "2026-10-29T10:05:00Z" },
  { id: "c5", name: "subagent_message", ts: "2026-10-29T10:05:30Z" },
  { id: "c7", name: "subagent", ts: "2026-10-29T10:10:00Z" },
];
const results = [
  { id: "c1", ts: "2026-10-29T10:00:20Z", err: false },
  { id: "c3", ts: "2026-10-29T10:01:20Z", err: false },
  { id: "c4", ts: "2026-10-29T10:02:40Z", err: false },
  { id: "c2", ts: "2026-10-29T10:05:10Z", err: false },
  { id: "c5", ts: "2026-10-29T10:06:00Z", err: false },
  { id: "c7", ts: "2026-10-29T10:11:30Z", err: false },
];
const argsById = new Map([
  ["c1", { agent: "scout", name: "r1" }],
  ["c2", { agent: "scout", name: "r2" }],
  ["c7", { agent: "builder", name: "b1" }],
  ["c3", { agent: null, name: "r1" }],
  ["c4", { agent: null, name: "r1" }],
  ["c5", { agent: null, name: "r2" }],
  ["c6", { agent: null, name: "r1" }],
]);

test("subagentMetrics pools per-message latencies into p50/p95", () => {
  const m = subagentMetrics(calls, results, argsById);
  assert.equal(m.avgLatencyMs, 35000); // the mean over the same pool, unchanged
  assert.equal(m.p50LatencyMs, 20000); // nearest-rank p50 of [10,20,20,30,40,90]k
  assert.equal(m.p95LatencyMs, 90000);
  const scout = m.byAgent.find((a) => a.agent === "scout");
  assert.equal(scout.p50LatencyMs, 20000); // [20,20,40,30]k
  assert.equal(scout.p95LatencyMs, 40000);
  // A pool of one sample is already reported exactly by avgLatencyMs.
  const builder = m.byAgent.find((a) => a.agent === "builder");
  assert.equal("p50LatencyMs" in builder, false);
  assert.equal("p95LatencyMs" in builder, false);
});

test("byAgent reports the median spawn-to-first-message lag per agent", () => {
  const m = subagentMetrics(calls, results, argsById);
  const scout = m.byAgent.find((a) => a.agent === "scout");
  assert.equal(scout.spawnToFirstMsgMs, 30000); // median of r1 60s, r2 30s
  // b1 was spawned but never messaged: no lag, no field.
  const builder = m.byAgent.find((a) => a.agent === "builder");
  assert.equal("spawnToFirstMsgMs" in builder, false);
});

test("sessions without subagent traffic keep the legacy shape", () => {
  const m = subagentMetrics([], [], new Map());
  assert.deepEqual(m, { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] });
});

// Two already-summarized sessions: summaries carry no per-message latency
// pool, so the aggregate message-weights the per-session means. scout means
// 1000ms (3 messages) and 3000ms (1 message) → weighted p50 1000, p95 3000;
// spawn lags 5000ms (2 spawns) and 9000ms (1 spawn) → spawn-weighted median
// 5000. Raw extracts add subagent calls on two days for the spawn timeline.
const s1 = {
  sessionId: "a1",
  project: "/a",
  firstTs: "2026-10-29T10:00:00Z",
  lastTs: "2026-10-29T12:00:00Z",
  turns: 1,
  cost: 1,
  toolCalls: 0,
  durationSec: 0,
  subagents: {
    spawns: 2,
    messages: 3,
    lists: 0,
    errors: 0,
    avgLatencyMs: 1000,
    byAgent: [
      { agent: "scout", spawns: 2, messages: 3, errors: 0, avgLatencyMs: 1000, spawnToFirstMsgMs: 5000 },
    ],
  },
};
const s2 = {
  sessionId: "a2",
  project: "/a",
  firstTs: "2026-10-30T09:00:00Z",
  lastTs: "2026-10-30T10:00:00Z",
  turns: 1,
  cost: 1,
  toolCalls: 0,
  durationSec: 0,
  subagents: {
    spawns: 1,
    messages: 1,
    lists: 0,
    errors: 0,
    avgLatencyMs: 3000,
    byAgent: [
      { agent: "scout", spawns: 1, messages: 1, errors: 0, avgLatencyMs: 3000, spawnToFirstMsgMs: 9000 },
    ],
  },
};
const e1 = {
  sessionId: "a1",
  project: "/a",
  path: "/a/a1.jsonl",
  turns: [],
  calls: [
    { id: "x1", name: "subagent", ts: "2026-10-29T10:00:00Z" },
    { id: "x2", name: "subagent", ts: "2026-10-29T11:00:00Z" },
  ],
  results: [],
  usage: {},
};
const e2 = {
  sessionId: "a2",
  project: "/a",
  path: "/a/a2.jsonl",
  turns: [],
  calls: [{ id: "x3", name: "subagent", ts: "2026-10-30T09:00:00Z" }],
  results: [],
  usage: {},
};

test("aggregates message-weight session means into p50/p95", () => {
  const agg = aggregateSessions([s1, s2]);
  assert.equal(agg.subagents.p50LatencyMs, 1000);
  assert.equal(agg.subagents.p95LatencyMs, 3000);
  const scout = agg.subagents.byAgent.find((a) => a.agent === "scout");
  assert.equal(scout.p50LatencyMs, 1000);
  assert.equal(scout.p95LatencyMs, 3000);
  assert.equal(scout.spawnToFirstMsgMs, 5000); // spawn-weighted median
  // No raw extracts → no timeline key at all, not an empty array.
  assert.equal("timeline" in agg.subagents, false);
});

test("aggregates build a daily spawn timeline from raw transcripts", () => {
  const agg = aggregateSessions([s1, s2], { raw: [e1, e2] });
  assert.deepEqual(agg.subagents.timeline, [
    { day: "2026-10-29", spawns: 2 },
    { day: "2026-10-30", spawns: 1 },
  ]);
  // The day window clips the timeline the same way it clips gate-by-day.
  const clipped = aggregateSessions([s1, s2], {
    raw: [e1, e2],
    fromDay: "2026-10-30",
    toDay: "2026-10-30",
  });
  assert.deepEqual(clipped.subagents.timeline, [{ day: "2026-10-30", spawns: 1 }]);
});
