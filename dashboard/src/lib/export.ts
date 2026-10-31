import type { SessionDetail, Snapshot } from "@/types";

import { sortedSkillRows } from "./burn.ts";
import {
  GATE_SHARE_BUCKETS,
  dayKey,
  failureStreakLeague,
  gateShareBucket,
  perCall,
  perCallRate,
} from "./derive.ts";

/** Everything the export writes, derived only from the snapshot the client
 * already holds — the server adds no endpoint for this. */
export interface ExportPayload {
  generatedAt: string;
  serverStartedAt?: string;
  range: { from: string | null; to: string | null };
  totals: Snapshot["aggregates"]["totals"];
  sessions: Snapshot["sessions"];
  gate: {
    byFamily: Snapshot["aggregates"]["gate"]["byFamily"];
    byTool: Snapshot["aggregates"]["gate"]["byTool"];
    avoidedSpend: Snapshot["aggregates"]["gate"]["avoidedSpend"];
    rules: Snapshot["aggregates"]["gate"]["rules"];
    unmappedTags: Snapshot["aggregates"]["gate"]["unmappedTags"];
  };
  /** Panel-shaped derivations recomputed at export time so CSV and JSON
   * never drift apart. Additive — the fields above are untouched. */
  derived: {
    failureStreaks: FailureStreakRow[];
    toolPerCall: ToolPerCallRow[];
    gateShareHistogram: { bucket: string; sessions: number }[];
    ratiosByDay: RatioDay[];
  };
}

/** One row of the failure-streak league, flattened for spreadsheets. */
export interface FailureStreakRow {
  sessionId: string;
  project: string;
  maxFailureStreak: number;
  failureStreakCalls: number;
}

/** One row of the $/call leaderboard; perCall is raw rate, not formatted. */
export interface ToolPerCallRow {
  tool: string;
  calls: number;
  spend: number;
  perCall: number | null;
}

/** Per-day mean of per-session ratios, aligned to the spend-day axis. */
export interface RatioDay {
  day: string;
  cacheHitRate: number | null;
  reasoningShare: number | null;
}

export function buildPayload(snapshot: Snapshot): ExportPayload {
  const gate = snapshot.aggregates.gate;
  return {
    generatedAt: snapshot.generatedAt,
    serverStartedAt: snapshot.serverStartedAt,
    range: snapshot.range,
    totals: snapshot.aggregates.totals,
    sessions: snapshot.sessions,
    gate: {
      byFamily: gate.byFamily,
      byTool: gate.byTool ?? [],
      avoidedSpend: gate.avoidedSpend ?? 0,
      rules: gate.rules ?? [],
      unmappedTags: gate.unmappedTags ?? [],
    },
    derived: {
      failureStreaks: failureStreakRows(snapshot.sessions),
      toolPerCall: toolPerCallRows(snapshot.sessions),
      gateShareHistogram: gateShareHistogram(snapshot.sessions),
      ratiosByDay: ratiosByDay(snapshot),
    },
  };
}

/** $/call needs volume before it means anything — the same floor the
 * overview leaderboard applies; thinner tools stay out of the export too. */
const MIN_CALLS_PER_TOOL = 10;

/** The failure-streak league as export rows: shared ordering, flattened. */
export function failureStreakRows(sessions: Snapshot["sessions"]): FailureStreakRow[] {
  return failureStreakLeague(sessions).map((s) => ({
    sessionId: s.sessionId,
    project: s.project,
    maxFailureStreak: s.agent.maxFailureStreak,
    failureStreakCalls: s.agent.failureStreakCalls,
  }));
}

/** Calls and spend per tool across sessions — the same fold the overview
 * tool panels run: counts from `tools`, cost from `toolCosts`, and a tool
 * with cost but no counted calls still shows up so spend is not lost. */
function toolTotals(sessions: Snapshot["sessions"]): Map<string, { calls: number; cost: number }> {
  const totals = new Map<string, { calls: number; cost: number }>();
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.tools)) {
      const t = totals.get(name) ?? { calls: 0, cost: 0 };
      t.calls += count;
      t.cost += s.toolCosts?.[name] ?? 0;
      totals.set(name, t);
    }
    for (const [name, cost] of Object.entries(s.toolCosts ?? {})) {
      // Counted tools already pulled their cost above; this pass only
      // rescues tools that carry cost without a counted call.
      if (!totals.has(name)) totals.set(name, { calls: 0, cost });
    }
  }
  return totals;
}

/** $/call leaderboard rows, steepest rate first — same filter, same sort
 * as the panel, minus the display slice. */
export function toolPerCallRows(sessions: Snapshot["sessions"]): ToolPerCallRow[] {
  return [...toolTotals(sessions)]
    .filter(([, t]) => t.calls >= MIN_CALLS_PER_TOOL && t.cost > 0)
    .map(([tool, t]) => ({
      tool,
      calls: t.calls,
      spend: t.cost,
      perCall: perCallRate(t.cost, t.calls),
    }))
    .sort((a, b) => (b.perCall ?? 0) - (a.perCall ?? 0));
}

/** Sessions per gate-token-share bucket, in the histogram's axis order. */
export function gateShareHistogram(
  sessions: Snapshot["sessions"],
): { bucket: string; sessions: number }[] {
  const counts = sessions.reduce(
    (acc, s) => {
      acc[gateShareBucket(s.agent.gateTokenSharePct)] += 1;
      return acc;
    },
    [0, 0, 0, 0, 0],
  );
  return GATE_SHARE_BUCKETS.map((bucket, i) => ({ bucket, sessions: counts[i] }));
}

/** Per-day mean of per-session cache/reasoning ratios, aligned to the
 * spend days, rounded to one decimal like the panel; days without
 * sessions carry null. */
export function ratiosByDay(snapshot: Snapshot): RatioDay[] {
  const sum = new Map<string, { hit: number; reason: number; n: number }>();
  for (const s of snapshot.sessions) {
    if (!s.firstTs) continue;
    const key = dayKey(s.firstTs);
    const d = sum.get(key) ?? { hit: 0, reason: 0, n: 0 };
    d.hit += s.cacheHitRate;
    d.reason += s.reasoningShare;
    d.n += 1;
    sum.set(key, d);
  }
  return snapshot.aggregates.spend.days.map(({ day }) => {
    const d = sum.get(day);
    return {
      day,
      cacheHitRate: d ? Math.round((d.hit / d.n) * 10) / 10 : null,
      reasoningShare: d ? Math.round((d.reason / d.n) * 10) / 10 : null,
    };
  });
}

/** CSV cell: quote only what needs it, double the quotes inside. */
function cell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "number" ? String(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (values: unknown[]) => values.map(cell).join(",");

export interface CsvSection {
  name: string;
  columns: string[];
  rows: unknown[][];
}

/** One CSV, one section after another: a `# section` line, the header row,
 * the data rows, then a blank line. Plain enough for any spreadsheet or awk. */
export function buildCsv(meta: Record<string, unknown>, sections: CsvSection[]): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(meta)) out.push(`# ${key}: ${cell(value)}`);
  out.push("");
  for (const section of sections) {
    out.push(`# ${section.name}`);
    out.push(row(section.columns));
    for (const r of section.rows) out.push(row(r));
    out.push("");
  }
  return out.join("\n");
}

export function payloadToCsv(p: ExportPayload): string {
  return buildCsv(
    {
      source: "pi sessions",
      generatedAt: p.generatedAt,
      range: p.range.from ? `${p.range.from} .. ${p.range.to ?? "now"}` : "all history",
    },
    [
      {
        name: "sessions",
        columns: [
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
        ],
        rows: p.sessions.map((s) => [
          s.sessionId,
          s.project,
          s.turns,
          s.cost,
          s.toolCalls,
          s.inputTokens,
          s.outputTokens,
          s.durationSec,
          s.agent?.blocks ?? 0,
          s.firstTs,
          s.lastTs,
        ]),
      },
      {
        name: "gate rules",
        columns: ["id", "code", "label", "group", "severity", "blocks", "warns", "topTool", "avoidedSpend"],
        rows: p.gate.rules.map((r) => [
          r.id,
          r.code,
          r.label,
          r.group,
          r.severity,
          r.blocks,
          r.warns,
          r.topTool,
          r.avoidedSpend,
        ]),
      },
      {
        name: "gate by tool",
        columns: ["tool", "blocks", "warns"],
        rows: p.gate.byTool.map((t) => [t.tool, t.blocks, t.warns]),
      },
      {
        name: "subagent latency",
        columns: [
          "sessionId",
          "agent",
          "spawns",
          "errorRate",
          "p50LatencyMs",
          "p95LatencyMs",
          "spawnToFirstMsgMs",
        ],
        rows: p.sessions.flatMap((s) =>
          (s.subagents?.byAgent ?? []).map((a) => [
            s.sessionId,
            a.agent,
            a.spawns,
            a.messages > 0 ? a.errors / a.messages : null,
            a.p50LatencyMs ?? null,
            a.p95LatencyMs ?? null,
            a.spawnToFirstMsgMs ?? null,
          ]),
        ),
      },
      {
        name: "gate by family",
        columns: ["family", "blocks"],
        rows: Object.entries(p.gate.byFamily).sort((a, b) => b[1] - a[1]),
      },
      {
        name: "failure streaks",
        columns: ["sessionId", "project", "maxFailureStreak", "failureStreakCalls"],
        rows: p.derived.failureStreaks.map((r) => [
          r.sessionId,
          r.project,
          r.maxFailureStreak,
          r.failureStreakCalls,
        ]),
      },
      {
        name: "tool per-call",
        columns: ["tool", "calls", "spend", "perCall"],
        rows: p.derived.toolPerCall.map((r) => [
          r.tool,
          r.calls,
          r.spend,
          perCall(r.perCall ?? 0),
        ]),
      },
    ],
  );
}

/** Anchor the filename to the window so two exports differ at a glance. */
export function exportBaseName(snapshot: Snapshot): string {
  return snapshot.range.from ? snapshot.range.from.slice(0, 10) : "all";
}

/** Client-side download: build a blob URL, click a throwaway anchor, revoke. */
export function downloadFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** One session as its own CSV: summary metrics, per-turn cost and tokens, tool
 * calls, and the per-model split — same sectioned shape as the full export. */
export function sessionDetailCsv(d: SessionDetail): { name: string; text: string } {
  const text = buildCsv(
    {
      source: "pi sessions",
      sessionId: d.sessionId,
      project: d.project,
      exportedAt: new Date().toISOString(),
    },
    [
      {
        name: "summary",
        columns: ["metric", "value"],
        rows: [
          ["turns", d.summary.turns],
          ["cost", d.summary.cost],
          ["tool calls", d.summary.toolCalls],
          ["compactions", d.compactions],
          ["duration sec", d.summary.durationSec],
          ["cache hit %", d.summary.cacheHitRate],
        ],
      },
      {
        name: "turns",
        columns: ["turn", "cost", "tokens"],
        rows: d.turns.map((t, i) => [t.i ?? i + 1, t.cost, t.totalTokens]),
      },
      {
        name: "calls",
        columns: ["name", "ts", "cmd", "path"],
        rows: d.calls.map((c) => [c.name, c.ts, c.cmd, c.path]),
      },
      {
        name: "usage by model",
        columns: ["model", "turns", "cost"],
        rows: Object.entries(d.usageByModel ?? {}).map(([m, u]) => [m, u.turns, u.costTotal]),
      },
      {
        name: "skills",
        columns: ["skill", "uses"],
        rows: sortedSkillRows(d.skills),
      },
    ],
  );
  return { name: `session-${d.sessionId.slice(0, 14)}.csv`, text };
}
