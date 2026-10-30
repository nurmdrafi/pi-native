import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  aggregateModelMix,
  aggregateSessions,
  costAlerts,
  createSessionTailer,
  detailFor,
  gateSummary,
  readPrompts,
  readSubagentArgs,
  sessionTimeline,
  spendSummary,
  subagentMetrics,
  subagentSpawnList,
  summarizeSession,
} from "../scripts/data.mjs";

describe("summarizeSession", () => {
  it("reduces a pidx extract line to a session summary", () => {
    const line = {
      v: 2,
      sessionId: "s1",
      project: "/proj/a",
      path: "/sessions/a.jsonl",
      turns: [
        { rid: "r1", ts: "2026-10-29T10:00:00Z", model: "m1", usage: { cost: { total: 0.5 } } },
        { rid: "r2", ts: "2026-10-29T10:01:00Z", model: "m2", usage: { cost: { total: 1.5 } } },
      ],
      usage: {
        m1: { turns: 1, costTotal: 0.5 },
        m2: { turns: 1, costTotal: 1.5 },
      },
      calls: [
        { name: "pibash", ts: "2026-10-29T10:00:10Z", rid: "r1" },
        { name: "pibash", ts: "2026-10-29T10:00:20Z", rid: "r1" },
        { name: "piread", ts: "2026-10-29T10:01:10Z", rid: "r2" },
      ],
    };
    const s = summarizeSession(line);
    assert.equal(s.sessionId, "s1");
    assert.equal(s.project, "/proj/a");
    assert.equal(s.turns, 2);
    assert.ok(Math.abs(s.cost - 2.0) < 1e-9);
    assert.deepEqual(s.models.sort(), ["m1", "m2"]);
    assert.equal(s.toolCalls, 3);
    assert.deepEqual(s.tools, { pibash: 2, piread: 1 });
    assert.equal(s.firstTs, "2026-10-29T10:00:00Z");
    assert.equal(s.lastTs, "2026-10-29T10:01:00Z");
  });

  it("attributes turn cost evenly across the turn's tool calls", () => {
    const s = summarizeSession({
      v: 2,
      sessionId: "tc",
      project: "/p",
      path: "/x",
      turns: [
        { rid: "r1", ts: "2026-10-29T10:00:00Z", usage: { cost: { total: 1.0 } } },
        { rid: "r2", ts: "2026-10-29T10:01:00Z", usage: { cost: { total: 0.6 } } },
      ],
      calls: [
        { name: "pibash", rid: "r1", ts: "2026-10-29T10:00:10Z" },
        { name: "piread", rid: "r1", ts: "2026-10-29T10:00:20Z" },
        { name: "pibash", rid: "r2", ts: "2026-10-29T10:01:10Z" },
        { name: "orphan", ts: "2026-10-29T10:01:20Z" },
      ],
    });
    assert.ok(Math.abs(s.toolCosts.pibash - 1.1) < 1e-9);
    assert.ok(Math.abs(s.toolCosts.piread - 0.5) < 1e-9);
    assert.equal(s.toolCosts.orphan, undefined);
  });

  it("derives token-efficiency metrics from turn usage", () => {
    const s = summarizeSession({
      v: 2,
      sessionId: "t1",
      project: "/p",
      path: "/x",
      turns: [
        { ts: "2026-10-29T10:00:00Z", model: "m", usage: { input: 100, output: 50, reasoning: 25, cacheRead: 900, cost: { total: 0.1 } } },
        { ts: "2026-10-29T10:10:00Z", model: "m", usage: { input: 100, output: 50, reasoning: 25, cacheRead: 900, cost: { total: 0.1 } } },
      ],
      usage: {},
      calls: [],
    });
    assert.equal(s.inputTokens, 200);
    assert.equal(s.outputTokens, 100);
    assert.equal(s.reasoningTokens, 50);
    assert.equal(s.cacheReadTokens, 1800);
    assert.equal(s.cacheHitRate, 90);
    assert.equal(s.reasoningShare, 33.3);
    assert.equal(s.durationSec, 600);
    assert.equal(s.tokensPerTurn, 1075);
    assert.ok(Math.abs(s.avgTurnCost - 0.1) < 1e-9);
  });

  it("derives agent-quality metrics via the gate-metrics extractor", () => {
    const s = summarizeSession({
      v: 2,
      sessionId: "t2",
      project: "/p",
      path: "/x",
      turns: [],
      usage: {},
      calls: [
        { id: "c1", name: "pibash", ph: "h1", ts: "2026-10-29T10:00:00Z" },
        { id: "c2", name: "pibash", ph: "h1", ts: "2026-10-29T10:00:05Z" },
        { id: "c3", name: "piread", ph: "h2", ts: "2026-10-29T10:00:10Z" },
      ],
      results: [
        { id: "c1", err: true, bytes: 0 },
        { id: "c2", err: true, bytes: 0 },
        { id: "c3", err: false, bytes: 400, blk: "H1" },
      ],
    });
    assert.equal(s.agent.repeatWithoutChange, 1);
    assert.equal(s.agent.maxFailureStreak, 2);
    assert.equal(s.agent.blocks, 1);
    assert.deepEqual(s.agent.blocksByFamily, { H1: 1 });
  });

  it("tolerates an extract with no turns and no calls", () => {
    const s = summarizeSession({ v: 2, sessionId: "s2", project: "/p", path: "/x", turns: [], usage: {}, calls: [] });
    assert.equal(s.turns, 0);
    assert.equal(s.cost, 0);
    assert.deepEqual(s.tools, {});
  });
});

describe("aggregateSessions", () => {
  const sessions = [
    { sessionId: "a", project: "/p1", turns: 2, cost: 1, firstTs: "2026-10-28T09:00:00Z", lastTs: "2026-10-28T09:05:00Z", models: ["m1"], toolCalls: 4, tools: {} },
    { sessionId: "b", project: "/p1", turns: 1, cost: 2, firstTs: "2026-10-29T09:00:00Z", lastTs: "2026-10-29T09:05:00Z", models: ["m1"], toolCalls: 0, tools: {} },
    { sessionId: "c", project: "/p2", turns: 3, cost: 4, firstTs: "2026-10-29T11:00:00Z", lastTs: "2026-10-29T11:30:00Z", models: ["m2"], toolCalls: 10, tools: {} },
  ];

  it("aggregates cost by UTC day", () => {
    const agg = aggregateSessions(sessions);
    assert.ok(Math.abs(agg.byDay["2026-10-28"] - 1) < 1e-9);
    assert.ok(Math.abs(agg.byDay["2026-10-29"] - 6) < 1e-9);
  });

  it("aggregates sessions and cost by project, sorted by cost desc", () => {
    const agg = aggregateSessions(sessions);
    assert.deepEqual(
      agg.byProject.map((p) => p.project),
      ["/p2", "/p1"],
    );
    assert.equal(agg.byProject[0].sessions, 1);
    assert.equal(agg.byProject[1].sessions, 2);
  });

  it("rolls up efficiency and intervention metrics", () => {
    const mk = (cacheRead, input, blocks, repeats, calls, durationSec, family = undefined) => ({
      cacheReadTokens: cacheRead,
      inputTokens: input,
      agent: { blocks, repeatWithoutChange: repeats, ...(family ? { blocksByFamily: { [family]: blocks } } : {}) },
      toolCalls: calls,
      durationSec,
    });
    const agg = aggregateSessions([
      { sessionId: "a", project: "/p", turns: 2, cost: 1, firstTs: "2026-10-28T09:00:00Z", lastTs: "2026-10-28T09:05:00Z", models: ["m"], toolCalls: 4, tools: {}, ...mk(900, 100, 1, 1, 4, 300, "H1") },
      { sessionId: "b", project: "/p", turns: 1, cost: 2, firstTs: "2026-10-29T09:00:00Z", lastTs: "2026-10-29T09:05:00Z", models: ["m"], toolCalls: 0, tools: {}, ...mk(0, 100, 0, 0, 0, 300) },
    ]);
    assert.equal(agg.cacheHitRate, 81.8);
    assert.equal(agg.blocksTotal, 1);
    assert.deepEqual(agg.blocksByFamily, { H1: 1 });
    assert.equal(agg.blocksPerSession, 0.5);
    assert.equal(agg.repeatPct, 25);
    assert.equal(agg.avgDurationSec, 300);
  });

  it("totals turns, cost and tool calls", () => {
    const agg = aggregateSessions(sessions);
    assert.equal(agg.totals.sessions, 3);
    assert.equal(agg.totals.turns, 6);
    assert.ok(Math.abs(agg.totals.cost - 7) < 1e-9);
    assert.equal(agg.totals.toolCalls, 14);
  });
});

describe("detailFor", () => {
  const extract = {
    v: 2,
    sessionId: "d1",
    project: "/proj/d",
    path: "/sessions/d.jsonl",
    turns: [
      {
        rid: "r1",
        ts: "2026-10-29T10:00:00Z",
        model: "m1",
        usage: { input: 10, output: 5, reasoning: 2, cacheRead: 100, cacheWrite: 0, totalTokens: 117, cost: { total: 0.25 } },
      },
    ],
    usage: { m1: { turns: 1, costTotal: 0.25 } },
    calls: [{ name: "pibash", ts: "2026-10-29T10:00:05Z", rid: "r1", cmd: "ls", path: null }],
    compactions: 2,
    skills: { ponytail: 1 },
  };

  it("maps the full per-session detail", () => {
    const d = detailFor(extract);
    assert.equal(d.sessionId, "d1");
    assert.equal(d.summary.cost, 0.25);
    assert.deepEqual(d.turns[0], {
      i: 0,
      ts: "2026-10-29T10:00:00Z",
      model: "m1",
      input: 10,
      output: 5,
      reasoning: 2,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 117,
      cost: 0.25,
    });
    assert.deepEqual(d.calls[0], { name: "pibash", ts: "2026-10-29T10:00:05Z", cmd: "ls", path: null });
    assert.equal(d.compactions, 2);
    assert.deepEqual(d.skills, { ponytail: 1 });
    assert.deepEqual(d.usageByModel, { m1: { turns: 1, costTotal: 0.25 } });
  });

  it("tolerates missing turns usage, calls, compactions, skills", () => {
    const d = detailFor({ v: 2, sessionId: "d2", project: "/p", path: "/x", turns: [{ rid: "r", ts: null, model: null }] });
    assert.deepEqual(d.turns[0], {
      i: 0, ts: null, model: null, input: 0, output: 0, reasoning: 0,
      cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0,
    });
    assert.deepEqual(d.calls, []);
    assert.equal(d.compactions, 0);
    assert.deepEqual(d.skills, {});
  });
});

describe("aggregateModelMix", () => {
  it("rolls up turns and cost per model across extracts", () => {
    const mix = aggregateModelMix([
      { usage: { m1: { turns: 2, costTotal: 0.5 }, m2: { turns: 1, costTotal: 1.5 } } },
      { usage: { m1: { turns: 1, costTotal: 0.25 } } },
      { usage: {} },
      {},
    ]);
    assert.deepEqual(mix, [
      { model: "m2", turns: 1, cost: 1.5 },
      { model: "m1", turns: 3, cost: 0.75 },
    ]);
  });
});

describe("spendSummary", () => {
  const mk = (firstTs, cost) => ({ firstTs, cost });

  it("summarizes today, 7-day spend and projects end-of-day linearly", () => {
    const now = new Date("2026-10-29T12:00:00Z"); // half the UTC day elapsed
    const sessions = [
      mk("2026-10-29T08:00:00Z", 2.0),
      mk("2026-10-28T08:00:00Z", 3.0),
      mk("2026-10-23T08:00:00Z", 4.0),
      mk("2026-10-20T08:00:00Z", 9.0),
    ];
    const s = spendSummary(sessions, now);
    assert.equal(s.today, 2.0);
    assert.equal(s.week, 9.0);
    assert.ok(Math.abs(s.projectedToday - 4.0) < 1e-9);
    assert.equal(s.days.length, 7);
    assert.equal(s.days[0].day, "2026-10-23");
    assert.equal(s.days[0].cost, 4.0);
    assert.equal(s.days[5].day, "2026-10-28");
    assert.equal(s.days[6].day, "2026-10-29");
    assert.equal(s.days[6].cost, 2.0);
  });

  it("zero-fills missing days and skips projection early in the day", () => {
    const early = new Date("2026-10-29T00:06:00Z"); // < 5% of the day elapsed
    const s = spendSummary([{ firstTs: "2026-10-29T00:01:00Z", cost: 1 }], early);
    assert.equal(s.projectedToday, null);
    assert.equal(s.days[1].cost, 0);
    assert.equal(s.days.filter((d) => d.cost > 0).length, 1);
  });
});

describe("costAlerts", () => {
  it("flags sessions over and near the budget, sorted by severity", () => {
    const sessions = [
      { sessionId: "a", project: "/p1", cost: 1.2 },
      { sessionId: "b", project: "/p2", cost: 0.9 },
      { sessionId: "c", project: "/p3", cost: 0.3 },
    ];
    const alerts = costAlerts(sessions, 1.0);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].sessionId, "a");
    assert.equal(alerts[0].level, "over");
    assert.equal(alerts[0].pct, 120);
    assert.equal(alerts[1].sessionId, "b");
    assert.equal(alerts[1].level, "near");
    assert.equal(alerts[1].pct, 90);
  });

  it("returns nothing when no budget is configured", () => {
    assert.deepEqual(costAlerts([{ sessionId: "a", project: "/p", cost: 99 }], 0), []);
  });
});

describe("sessionTimeline", () => {
  it("buckets turn cost and tool calls into fixed windows", () => {
    const extract = {
      turns: [
        { ts: "2026-10-29T10:01:00Z", usage: { cost: { total: 0.4 } } },
        { ts: "2026-10-29T10:04:00Z", usage: { cost: { total: 0.6 } } },
        { ts: "2026-10-29T10:20:00Z", usage: { cost: { total: 1.0 } } },
      ],
      calls: [
        { ts: "2026-10-29T10:02:00Z", name: "pibash" },
        { ts: "2026-10-29T10:22:00Z", name: "piread" },
      ],
    };
    const buckets = sessionTimeline(extract, 5 * 60_000);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0].start, Date.parse("2026-10-29T10:00:00Z"));
    assert.equal(buckets[0].turns, 2);
    assert.ok(Math.abs(buckets[0].cost - 1.0) < 1e-9);
    assert.equal(buckets[0].calls, 1);
    assert.equal(buckets[1].turns, 1);
    assert.equal(buckets[1].calls, 1);
  });

  it("ignores entries without parseable timestamps", () => {
    assert.deepEqual(sessionTimeline({ turns: [{ usage: {} }], calls: [] }, 300_000), []);
  });
});

describe("subagent metrics", () => {
  it("counts subagent activity and joins results for errors and latency", () => {
    const extract = {
      v: 2,
      sessionId: "sa1",
      project: "/p",
      path: "/x",
      turns: [],
      calls: [
        { id: "c1", name: "subagent", ts: "2026-10-29T10:00:00Z" },
        { id: "c2", name: "subagent", ts: "2026-10-29T10:01:00Z" },
        { id: "c3", name: "subagent_message", ts: "2026-10-29T10:02:00Z" },
        { id: "c4", name: "subagents_list", ts: "2026-10-29T10:03:00Z" },
        { id: "c5", name: "pibash", ts: "2026-10-29T10:04:00Z" },
      ],
      results: [
        { id: "c1", ts: "2026-10-29T10:00:30Z", err: false },
        { id: "c2", ts: "2026-10-29T10:02:30Z", err: true },
        { id: "c3", ts: "2026-10-29T10:02:40Z", err: false },
      ],
    };
    const s = summarizeSession(extract);
    assert.equal(s.subagents.spawns, 2);
    assert.equal(s.subagents.messages, 1);
    assert.equal(s.subagents.lists, 1);
    assert.equal(s.subagents.errors, 1);
    assert.equal(s.subagents.avgLatencyMs, 53333);
  });

  it("defaults subagent metrics to zero", () => {
    const s = summarizeSession({ v: 2, sessionId: "z", project: "/p", path: "/x", turns: [], calls: [] });
    assert.deepEqual(s.subagents, { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] });
  });

  it("rolls up subagent totals across sessions", () => {
    const agg = aggregateSessions([
      { firstTs: "2026-10-29T10:00:00Z", project: "/a", turns: 1, cost: 1, toolCalls: 1, durationSec: 0, subagents: { spawns: 2, messages: 1, lists: 0, errors: 1, avgLatencyMs: 1000 } },
      { firstTs: "2026-10-29T11:00:00Z", project: "/b", turns: 1, cost: 1, toolCalls: 1, durationSec: 0, subagents: { spawns: 1, messages: 0, lists: 1, errors: 0, avgLatencyMs: 3000 } },
    ]);
    assert.equal(agg.subagents.spawns, 3);
    assert.equal(agg.subagents.messages, 1);
    assert.equal(agg.subagents.lists, 1);
    assert.equal(agg.subagents.errors, 1);
    assert.equal(agg.subagents.avgLatencyMs, 2000);
  });

  it("rolls up per-agent subagent breakdowns across sessions", () => {
    const agg = aggregateSessions([
      {
        firstTs: "2026-10-29T10:00:00Z",
        project: "/a",
        turns: 1,
        cost: 1,
        toolCalls: 1,
        durationSec: 0,
        subagents: {
          spawns: 2,
          messages: 0,
          lists: 0,
          errors: 0,
          avgLatencyMs: 1000,
          byAgent: [
            { agent: "scout", spawns: 2, messages: 0, errors: 0, avgLatencyMs: 1000 },
          ],
        },
      },
      {
        firstTs: "2026-10-29T11:00:00Z",
        project: "/b",
        turns: 1,
        cost: 1,
        toolCalls: 1,
        durationSec: 0,
        subagents: {
          spawns: 1,
          messages: 2,
          lists: 0,
          errors: 0,
          avgLatencyMs: 3000,
          byAgent: [
            { agent: "scout", spawns: 1, messages: 2, errors: 0, avgLatencyMs: 3000 },
          ],
        },
      },
    ]);
    assert.equal(agg.subagents.byAgent.length, 1);
    assert.deepEqual(agg.subagents.byAgent[0], {
      agent: "scout",
      spawns: 3,
      messages: 2,
      errors: 0,
      avgLatencyMs: 2000,
    });
  });

  it("estimates avoided spend from blocked calls and per-tool average cost", () => {
    const agg = aggregateSessions([
      {
        firstTs: "2026-10-29T10:00:00Z",
        project: "/a",
        turns: 4,
        cost: 1,
        toolCalls: 4,
        durationSec: 0,
        tools: { pibash: 4 },
        toolCosts: { pibash: 0.4 },
        blocksByTool: { pibash: 2 },
      },
      {
        firstTs: "2026-10-29T11:00:00Z",
        project: "/b",
        turns: 0,
        cost: 0,
        toolCalls: 0,
        durationSec: 0,
        tools: {},
        toolCosts: {},
        blocksByTool: { piedit: 1 },
      },
    ]);
    // pibash avg = 0.4/4 = 0.1 -> 2 blocked x 0.1; piedit unseen -> global avg 0.4/4.
    assert.equal(agg.avoidedSpend, 0.3);
    assert.deepEqual(agg.blocksByTool, { pibash: 2, piedit: 1 });
  });
});

describe("gateSummary", () => {
  it("totals blocks, keeps family counts and sorts rules by severity", () => {
    const g = gateSummary({ anchor: 4, search: 1 }, { alpha: "error", beta: "warn", gamma: "off", delta: "error" });
    assert.equal(g.total, 5);
    assert.deepEqual(g.byFamily, { anchor: 4, search: 1 });
    assert.deepEqual(g.rules, [
      { id: "alpha", severity: "error", family: null },
      { id: "delta", severity: "error", family: null },
      { id: "beta", severity: "warn", family: null },
      { id: "gamma", severity: "off", family: null },
    ]);
    assert.deepEqual(g.bySeverity, { error: 2, warn: 1, off: 1 });
    // Unmapped rules leave family severity unresolved, not guessed.
    assert.deepEqual(g.familySeverity, { anchor: null, search: null });
    assert.equal(g.avoidedSpend, 0);
  });

  it("joins each family to the worst severity of its rules and carries avoided spend", () => {
    const g = gateSummary(
      { anchor: 4, tokens: 2 },
      { editAnchorGuard: "warn", editRegionGuard: "error", largeReadGuard: "warn" },
      { blocksByTool: { piedit: 4 }, avoidedSpend: 0.42 },
    );
    assert.deepEqual(g.familySeverity, { anchor: "error", tokens: "warn" });
    assert.deepEqual(g.blocksByTool, { piedit: 4 });
    assert.equal(g.avoidedSpend, 0.42);
    assert.deepEqual(g.rules.find((r) => r.id === "editAnchorGuard"), {
      id: "editAnchorGuard",
      severity: "warn",
      family: "anchor",
    });
  });
});

describe("readSubagentArgs", () => {
  it("reads subagent-family toolCall arguments from a raw session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-sa-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "c1", name: "subagent", arguments: { agent: "scout", name: "r1", task: "t" } },
              { type: "toolCall", id: "c2", name: "pibash", arguments: { command: "ls" } },
            ],
          },
        }),
        "{not json",
        JSON.stringify({ type: "message", message: { role: "user", content: "plain" } }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "c3", name: "subagent_message", arguments: { name: "r1", message: "m" } },
            ],
          },
        }),
        "",
      ].join("\n"),
    );
    try {
      const args = readSubagentArgs(file);
      assert.equal(args.size, 2);
      assert.deepEqual(args.get("c1"), { agent: "scout", name: "r1" });
      assert.deepEqual(args.get("c3"), { agent: null, name: "r1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty map for a missing file", () => {
    assert.equal(readSubagentArgs(join(tmpdir(), "no-such-file.jsonl")).size, 0);
  });
});

describe("subagentMetrics byAgent", () => {
  it("groups spawns and messages per agent, resolving instances to their spawner", () => {
    const calls = [
      { id: "c1", name: "subagent", ts: "2026-10-29T10:00:00Z" },
      { id: "c2", name: "subagent", ts: "2026-10-29T10:01:00Z" },
      { id: "c3", name: "subagent_message", ts: "2026-10-29T10:02:00Z" },
      { id: "c4", name: "subagent_message", ts: "2026-10-29T10:03:00Z" },
      { id: "c5", name: "subagents_list", ts: "2026-10-29T10:04:00Z" },
      { id: "c6", name: "pibash", ts: "2026-10-29T10:05:00Z" },
    ];
    const results = [
      { id: "c1", ts: "2026-10-29T10:00:30Z", err: false },
      { id: "c2", ts: "2026-10-29T10:02:30Z", err: true },
      { id: "c3", ts: "2026-10-29T10:02:20Z", err: false },
    ];
    const argsById = new Map([
      ["c1", { agent: "scout", name: "r1" }],
      ["c2", { agent: "builder", name: "r2" }],
      ["c3", { agent: null, name: "r1" }],
      ["c4", { agent: null, name: "ghost" }],
    ]);
    const m = subagentMetrics(calls, results, argsById);
    assert.equal(m.spawns, 2);
    assert.equal(m.messages, 2);
    const scout = m.byAgent.find((a) => a.agent === "scout");
    assert.deepEqual(scout, { agent: "scout", spawns: 1, messages: 1, errors: 0, avgLatencyMs: 25000 });
    const builder = m.byAgent.find((a) => a.agent === "builder");
    assert.deepEqual(builder, { agent: "builder", spawns: 1, messages: 0, errors: 1, avgLatencyMs: 90000 });
    const direct = m.byAgent.find((a) => a.agent === "(direct)");
    assert.deepEqual(direct, { agent: "(direct)", spawns: 0, messages: 1, errors: 0, avgLatencyMs: 0 });
  });

  it("labels spawns without arguments as unknown", () => {
    const m = subagentMetrics([{ id: "c1", name: "subagent", ts: "2026-10-29T10:00:00Z" }], [], new Map());
    assert.deepEqual(m.byAgent, [{ agent: "unknown", spawns: 1, messages: 0, errors: 0, avgLatencyMs: 0 }]);
  });
});

describe("blocked-call attribution", () => {
  it("counts blocked results per tool name in summarizeSession", () => {
    const s = summarizeSession({
      v: 2,
      sessionId: "bt1",
      project: "/p",
      path: "/x",
      turns: [],
      calls: [
        { id: "b1", name: "piedit", ts: "2026-10-29T10:00:00Z" },
        { id: "b2", name: "pibash", ts: "2026-10-29T10:01:00Z" },
      ],
      results: [
        { id: "b1", ts: "2026-10-29T10:00:02Z", err: true, blk: "anchor" },
        { id: "b2", ts: "2026-10-29T10:01:02Z", err: false },
      ],
    });
    assert.deepEqual(s.blocksByTool, { piedit: 1 });
  });

  it("lists spawn records with agent and instance names via detailFor", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-sp-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "subagent", arguments: { agent: "scout", name: "r1" } },
          ],
        },
      }) + "\n",
    );
    try {
      const detail = detailFor({
        v: 2,
        sessionId: "sp1",
        project: "/p",
        path: file,
        turns: [],
        calls: [{ id: "c1", name: "subagent", ts: "2026-10-29T10:00:00Z" }],
        results: [],
      });
      assert.deepEqual(detail.subagentSpawns, [
        { id: "c1", ts: "2026-10-29T10:00:00Z", agent: "scout", name: "r1" },
      ]);
      assert.equal(detail.subagents.byAgent[0].agent, "scout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty spawn list when a session spawned no subagents", () => {
    assert.deepEqual(subagentSpawnList({ calls: [{ id: "x", name: "pibash", ts: null }] }), []);
  });
});

describe("readPrompts", () => {
  it("extracts user prompt previews from a session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-prompts-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "fix the failing dashboard tests now please" } }),
        JSON.stringify({ type: "message", message: { role: "user", timestamp: 1793288036589, content: "epoch stamped" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "ok" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "second prompt" }] } }),
        "",
      ].join("\n"),
    );
    try {
      const prompts = readPrompts(file);
      assert.equal(prompts.length, 3);
      assert.equal(prompts[0].preview, "fix the failing dashboard tests now please");
      assert.equal(prompts[1].preview, "epoch stamped");
      assert.equal(prompts[1].ts, "2026-10-29T15:33:56.589Z");
      assert.equal(prompts[2].preview, "second prompt");
      assert.equal(prompts[0].ts, null);
      const d = detailFor({ sessionId: "p1", project: "/p", path: file, turns: [], calls: [] });
      assert.equal(d.prompts.length, 3);
      assert.deepEqual(d.subagents, { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the session file is missing", () => {
    assert.deepEqual(readPrompts("/nonexistent/x.jsonl"), []);
  });
});

describe("createSessionTailer", () => {
  const assistant = (model, cost, ts) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model,
        timestamp: ts,
        usage: { cost: { total: cost } },
        content: [{ type: "tool_call", name: "pibash" }],
      },
    });

  it("emits turn events incrementally, skipping partial and malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-tail-"));
    try {
      const file = join(dir, "live.jsonl");
      writeFileSync(file, assistant("m1", 0.5, "2026-10-29T10:00:00Z") + "\n");
      const tailer = createSessionTailer(file);
      let events = tailer.tick();
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "turn");
      assert.equal(events[0].model, "m1");
      assert.ok(Math.abs(events[0].cost - 0.5) < 1e-9);
      assert.equal(events[0].toolCalls, 1);

      writeFileSync(file, "{broken\n", { flag: "a" });
      assert.equal(tailer.tick().length, 0);

      writeFileSync(file, assistant("m2", 1, "2026-10-29T10:01:00Z") + "\n", { flag: "a" });
      events = tailer.tick();
      assert.equal(events.length, 1);
      assert.equal(events[0].model, "m2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-assistant entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-tail-"));
    try {
      const file = join(dir, "live.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "session", id: "x" }),
          JSON.stringify({ type: "message", message: { role: "user" } }),
          "",
        ].join("\n"),
      );
      const tailer = createSessionTailer(file);
      assert.equal(tailer.tick().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
