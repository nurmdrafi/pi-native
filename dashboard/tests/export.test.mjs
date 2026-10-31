import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPayload, payloadToCsv, sessionDetailCsv } from "../src/lib/export.ts";

/** Local-noon ISO stamp, so dayKey is stable in any timezone. */
const noon = (y, m, d) => new Date(y, m, d, 12, 0, 0).toISOString();

function session(over = {}) {
  return {
    sessionId: "s",
    project: "proj",
    path: "/p",
    turns: 0,
    cost: 0,
    models: [],
    toolCalls: 0,
    tools: {},
    toolCosts: {},
    firstTs: null,
    lastTs: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    reasoningShare: 0,
    durationSec: 0,
    tokensPerTurn: 0,
    avgTurnCost: 0,
    compactions: 0,
    blocksByTool: {},
    gateTags: {},
    subagents: { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] },
    agent: {
      repeatWithoutChange: 0,
      failureStreakCalls: 0,
      maxFailureStreak: 0,
      blocks: 0,
      blocksByFamily: {},
      gateTokenSharePct: 0,
    },
    ...over,
  };
}

function snapshot(over = {}) {
  return {
    generatedAt: "2026-10-31T00:00:00.000Z",
    range: { from: null, to: null },
    sessions: [],
    aggregates: {
      byDay: {},
      byProject: [],
      totals: { sessions: 0, turns: 0, cost: 0, toolCalls: 0 },
      modelMix: [],
      cacheHitRate: 0,
      reasoningShare: 0,
      blocksTotal: 0,
      blocksByFamily: {},
      blocksPerSession: 0,
      repeatPct: 0,
      avgDurationSec: 0,
      spend: { today: 0, week: 0, projectedToday: null, days: [] },
      alerts: [],
      subagents: { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] },
      gate: {
        total: 0,
        byFamily: {},
        rules: [],
        bySeverity: { error: 0, warn: 0, off: 0 },
        familySeverity: {},
        blocksByTool: {},
        byTool: [],
        avoidedSpend: 0,
        unmappedTags: [],
      },
    },
    active: [],
    ...over,
  };
}

/** Lines of one `# name` section: everything between the marker and the
 * next blank line (header first, then data rows). */
function section(csv, name) {
  const lines = csv.split("\n");
  const i = lines.indexOf(`# ${name}`);
  assert.ok(i >= 0, `section # ${name} missing`);
  const body = [];
  for (let j = i + 1; j < lines.length && lines[j] !== ""; j++) body.push(lines[j]);
  return body;
}

describe("buildPayload derived", () => {
  it("adds derived additively, leaving the existing keys untouched", () => {
    const p = buildPayload(snapshot());
    assert.equal(p.generatedAt, "2026-10-31T00:00:00.000Z");
    assert.deepEqual(p.range, { from: null, to: null });
    assert.ok(Array.isArray(p.sessions));
    assert.ok(p.totals);
    assert.ok(p.gate);
    assert.ok(p.derived, "derived object missing");
    for (const key of ["failureStreaks", "toolPerCall", "gateShareHistogram", "ratiosByDay"]) {
      assert.ok(Array.isArray(p.derived[key]), `derived.${key} missing`);
    }
  });

  it("ranks failure streaks worst first, ties on total failed calls", () => {
    const sessions = [
      session({ sessionId: "A", agent: { failureStreakCalls: 5, maxFailureStreak: 3 } }),
      session({ sessionId: "B", agent: { failureStreakCalls: 9, maxFailureStreak: 5 } }),
      session({ sessionId: "C", agent: { failureStreakCalls: 7, maxFailureStreak: 3 } }),
      session({ sessionId: "D", agent: { failureStreakCalls: 4, maxFailureStreak: 0 } }),
    ];
    const { failureStreaks } = buildPayload(snapshot({ sessions })).derived;
    assert.deepEqual(
      failureStreaks.map((r) => r.sessionId),
      ["B", "C", "A"],
    );
    assert.deepEqual(failureStreaks[0], {
      sessionId: "B",
      project: "proj",
      maxFailureStreak: 5,
      failureStreakCalls: 9,
    });
  });

  it("keeps thin and free tools out of tool per-call, steepest rate first", () => {
    const s = session({
      tools: { alpha: 10, beta: 10, gamma: 3, delta: 50 },
      toolCosts: { alpha: 4.2, beta: 100, gamma: 5, delta: 0, orphan: 9 },
    });
    const { toolPerCall } = buildPayload(snapshot({ sessions: [s] })).derived;
    assert.deepEqual(
      toolPerCall.map((r) => ({ ...r, perCall: Number(r.perCall.toFixed(9)) })),
      [
        { tool: "beta", calls: 10, spend: 100, perCall: 10 },
        { tool: "alpha", calls: 10, spend: 4.2, perCall: 0.42 },
      ],
    );
  });

  it("buckets gate share exactly like the histogram panel", () => {
    const sessions = [0, 3, 5.1, 25].map((pct, i) =>
      session({ sessionId: `s${i}`, agent: { gateTokenSharePct: pct } }),
    );
    const { gateShareHistogram } = buildPayload(snapshot({ sessions })).derived;
    assert.deepEqual(gateShareHistogram, [
      { bucket: "0", sessions: 1 },
      { bucket: "≤5", sessions: 1 },
      { bucket: "≤10", sessions: 1 },
      { bucket: "≤20", sessions: 0 },
      { bucket: ">20", sessions: 1 },
    ]);
  });

  it("averages cache and reasoning ratios per spend day, null when empty", () => {
    const sessions = [
      session({
        firstTs: noon(2026, 0, 9),
        cacheHitRate: 61.25,
        reasoningShare: 10,
      }),
      session({ firstTs: noon(2026, 0, 9), cacheHitRate: 40, reasoningShare: 5 }),
    ];
    const snap = snapshot({ sessions });
    snap.aggregates.spend.days = [
      { day: "2026-01-09", cost: 1 },
      { day: "2026-01-10", cost: 2 },
    ];
    const { ratiosByDay } = buildPayload(snap).derived;
    assert.deepEqual(ratiosByDay, [
      { day: "2026-01-09", cacheHitRate: 50.6, reasoningShare: 7.5 },
      { day: "2026-01-10", cacheHitRate: null, reasoningShare: null },
    ]);
  });
});

describe("payloadToCsv new sections", () => {
  it("emits one subagent latency row per session and agent", () => {
    const sessions = [
      session({
        sessionId: "s1",
        subagents: {
          spawns: 3,
          messages: 4,
          lists: 0,
          errors: 1,
          avgLatencyMs: 100,
          byAgent: [
            {
              agent: "scout",
              spawns: 3,
              messages: 4,
              errors: 1,
              avgLatencyMs: 100,
              p50LatencyMs: 120,
              spawnToFirstMsgMs: 900,
            },
          ],
        },
      }),
      session({
        sessionId: "s2",
        subagents: {
          spawns: 1,
          messages: 0,
          lists: 0,
          errors: 0,
          avgLatencyMs: 50,
          byAgent: [{ agent: "worker", spawns: 1, messages: 0, errors: 0, avgLatencyMs: 50 }],
        },
      }),
    ];
    const csv = payloadToCsv(buildPayload(snapshot({ sessions })));
    assert.deepEqual(section(csv, "subagent latency"), [
      "sessionId,agent,spawns,errorRate,p50LatencyMs,p95LatencyMs,spawnToFirstMsgMs",
      "s1,scout,3,0.25,120,,900",
      "s2,worker,1,,,,",
    ]);
  });

  it("emits gate by family sorted by blocks", () => {
    const snap = snapshot();
    snap.aggregates.gate.byFamily = { budget: 12, safety: 3 };
    const csv = payloadToCsv(buildPayload(snap));
    assert.deepEqual(section(csv, "gate by family"), [
      "family,blocks",
      "budget,12",
      "safety,3",
    ]);
  });

  it("emits failure streaks in league order", () => {
    const sessions = [
      session({ sessionId: "A", agent: { failureStreakCalls: 5, maxFailureStreak: 3 } }),
      session({ sessionId: "B", agent: { failureStreakCalls: 9, maxFailureStreak: 5 } }),
      session({ sessionId: "D", agent: { failureStreakCalls: 4, maxFailureStreak: 0 } }),
    ];
    const csv = payloadToCsv(buildPayload(snapshot({ sessions })));
    assert.deepEqual(section(csv, "failure streaks"), [
      "sessionId,project,maxFailureStreak,failureStreakCalls",
      "B,proj,5,9",
      "A,proj,3,5",
    ]);
  });

  it("emits tool per-call with money-formatted rates", () => {
    const s = session({
      tools: { alpha: 10, beta: 10, gamma: 3 },
      toolCosts: { alpha: 4.2, beta: 100, gamma: 5 },
    });
    const csv = payloadToCsv(buildPayload(snapshot({ sessions: [s] })));
    assert.deepEqual(section(csv, "tool per-call"), [
      "tool,calls,spend,perCall",
      "beta,10,100,$10.00",
      "alpha,10,4.2,$0.42",
    ]);
  });

  it("keeps the pre-existing sections intact", () => {
    const csv = payloadToCsv(buildPayload(snapshot()));
    assert.deepEqual(section(csv, "sessions")[0].split(","), [
      "sessionId",
      "project",
      "turns",
      "cost",
      "toolCalls",
      "inputTokens",
      "outputTokens",
      "durationSec",
      "blocks",
      "firstTs",
      "lastTs",
    ]);
    assert.deepEqual(section(csv, "gate rules")[0].split(","), [
      "id",
      "code",
      "label",
      "group",
      "severity",
      "blocks",
      "warns",
      "topTool",
      "avoidedSpend",
    ]);
    assert.deepEqual(section(csv, "gate by tool")[0].split(","), ["tool", "blocks", "warns"]);
  });
});

describe("sessionDetailCsv skills section", () => {
  const detail = {
    sessionId: "s1234567890abcd",
    project: "proj",
    summary: {
      turns: 4,
      cost: 0.5,
      toolCalls: 9,
      durationSec: 100,
      cacheHitRate: 42,
    },
    turns: [{ i: 1, cost: 0.25, totalTokens: 10 }],
    calls: [{ name: "Read", ts: "2026-01-01T00:00:00Z", cmd: null, path: "/x" }],
    compactions: 2,
    skills: { ponytail: 5, review: 5, build: 9 },
    usageByModel: { "sonnet": { turns: 4, costTotal: 0.5 } },
    timeline: [],
    prompts: [],
    subagents: { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] },
    subagentSpawns: [],
  };

  it("lists skills most-used first, name order on ties", () => {
    const { text } = sessionDetailCsv(detail);
    assert.deepEqual(section(text, "skills"), [
      "skill,uses",
      "build,9",
      "ponytail,5",
      "review,5",
    ]);
  });

  it("still covers the pre-existing detail sections", () => {
    const { text, name } = sessionDetailCsv(detail);
    assert.match(name, /^session-s1234567890abc\.csv$/);
    assert.ok(section(text, "summary").some((l) => l === "compactions,2"));
    assert.equal(section(text, "turns")[0], "turn,cost,tokens");
    assert.equal(section(text, "calls")[0], "name,ts,cmd,path");
    assert.equal(section(text, "usage by model")[0], "model,turns,cost");
  });
});
