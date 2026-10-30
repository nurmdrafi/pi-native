#!/usr/bin/env node
/**
 * Pure data layer for the dashboard: pidx extract lines in, session summaries,
 * aggregates, gate joins and raw-file readers out. Unit-tested in
 * dashboard/tests/dashboard.test.mjs. No server, no process state beyond the
 * mtime-keyed raw-file cache.
 */
import { readFileSync, statSync } from "node:fs";
import { metrics as gateMetrics } from "../../tests/tools/audit/gate-metrics.mjs";

// ── Pure data layer ────────────────────────────────────────────────────────

export function summarizeSession(extract) {
  const turns = extract.turns ?? [];
  const calls = extract.calls ?? [];
  const usage = extract.usage ?? {};
  const tools = {};
  for (const call of calls) tools[call.name] = (tools[call.name] ?? 0) + 1;
  const callsByRid = new Map();
  for (const call of calls) {
    if (!call.rid) continue;
    const list = callsByRid.get(call.rid) ?? [];
    list.push(call.name);
    callsByRid.set(call.rid, list);
  }
  const toolCosts = {};
  for (const turn of turns) {
    const c = turn.usage?.cost?.total;
    const names = callsByRid.get(turn.rid);
    if (typeof c !== "number" || c === 0 || !names) continue;
    const share = c / names.length;
    for (const name of names) toolCosts[name] = Number(((toolCosts[name] ?? 0) + share).toFixed(6));
  }
  const models = Object.keys(usage);
  let cost = 0;
  for (const model of models) cost += usage[model].costTotal ?? 0;
  const timestamps = turns.map((t) => t.ts).filter(Boolean).sort();

  const sum = (pick) =>
    turns.reduce((acc, t) => acc + (Number.isFinite(pick(t)) ? pick(t) : 0), 0);
  if (cost === 0) cost = sum((t) => t.usage?.cost?.total);
  const inputTokens = sum((t) => t.usage?.input);
  const outputTokens = sum((t) => t.usage?.output);
  const reasoningTokens = sum((t) => t.usage?.reasoning);
  const cacheReadTokens = sum((t) => t.usage?.cacheRead);
  const cacheTotal = cacheReadTokens + inputTokens;
  const firstTs = timestamps[0] ?? null;
  const lastTs = timestamps[timestamps.length - 1] ?? null;
  const durationSec =
    firstTs && lastTs ? Math.round((new Date(lastTs) - new Date(firstTs)) / 1000) : 0;
  const pct1 = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

  // Agent-quality metrics reuse the gate-metrics audit extractor (same pidx
  // fields, same semantics): repeats, failure streaks, gate blocks.
  const g = gateMetrics([extract], extract.project);
  const gateTokens = Math.round(g.gate_block_bytes / 4);
  // Blocked calls (results carrying a gate family) attributed to their tool.
  const nameById = new Map(calls.map((c) => [c.id, c.name]));
  const blocksByTool = {};
  for (const r of extract.results ?? []) {
    if (!r?.blk) continue;
    const name = nameById.get(r.id) ?? "(unknown)";
    blocksByTool[name] = (blocksByTool[name] ?? 0) + 1;
  }

  return {
    sessionId: extract.sessionId,
    project: extract.project,
    path: extract.path,
    turns: turns.length,
    cost: Number(cost.toFixed(6)),
    models,
    toolCalls: calls.length,
    tools,
    firstTs,
    lastTs,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheHitRate: pct1(cacheReadTokens, cacheTotal),
    reasoningShare: pct1(reasoningTokens, reasoningTokens + outputTokens),
    durationSec,
    tokensPerTurn: turns.length > 0 ? Math.round((inputTokens + outputTokens + reasoningTokens + cacheReadTokens) / turns.length) : 0,
    avgTurnCost: turns.length > 0 ? Number((cost / turns.length).toFixed(6)) : 0,
    compactions: typeof extract.compactions === "number" ? extract.compactions : 0,
    agent: {
      repeatWithoutChange: g.repeat_without_change,
      failureStreakCalls: g.calls_in_failure_streak,
      maxFailureStreak: g.max_streak,
      blocks: g.blocks,
      blocksByFamily: g.by_family,
      gateTokenSharePct: Math.round((gateTokens / Math.max(1, g.billed_input_tokens)) * 1000) / 10,
    },
    subagents: subagentMetrics(
      calls,
      extract.results ?? [],
      calls.some((c) => SUBAGENT_CALL_NAMES.has(c.name)) ? readSubagentArgs(extract.path) : new Map(),
    ),
    blocksByTool,
    toolCosts,
  };
}

/** Subagent activity derived from subagent-family calls joined with their results. */
const SUBAGENT_CALL_NAMES = new Set(["subagent", "subagent_message", "subagents_list"]);

/**
 * subagent spawn/message arguments read from a raw session file, keyed by
 * call id: { agent: <agent type>, name: <instance name> }. Cached by mtime so
 * the poll cycle does not reparse unchanged files. Returns an empty map when
 * the file is missing or unreadable.
 */
const subagentArgsCache = new Map();
export function readSubagentArgs(sessionFile) {
  if (!sessionFile) return new Map();
  try {
    const { mtimeMs } = statSync(sessionFile);
    const hit = subagentArgsCache.get(sessionFile);
    if (hit && hit.mtimeMs === mtimeMs) return hit.args;
    const args = new Map();
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item?.type !== "toolCall" || !SUBAGENT_CALL_NAMES.has(item.name)) continue;
        const a = item.arguments ?? {};
        args.set(item.id, { agent: typeof a.agent === "string" ? a.agent : null, name: typeof a.name === "string" ? a.name : null });
      }
    }
    const entry = { mtimeMs, args };
    subagentArgsCache.set(sessionFile, entry);
    return args;
  } catch {
    return new Map();
  }
}

export function subagentMetrics(calls = [], results = [], argsById = new Map()) {
  const resultById = new Map(results.map((r) => [r.id, r]));
  const instanceAgent = new Map();
  const agents = new Map();
  const agentFor = (key) => {
    let a = agents.get(key);
    if (!a) {
      a = { agent: key, spawns: 0, messages: 0, lists: 0, errors: 0, latencySum: 0, latencyCount: 0 };
      agents.set(key, a);
    }
    return a;
  };
  let spawns = 0;
  let messages = 0;
  let lists = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyCount = 0;
  for (const c of calls) {
    if (!SUBAGENT_CALL_NAMES.has(c.name)) continue;
    const args = argsById.get(c.id) ?? {};
    let bucket = null;
    if (c.name === "subagent") {
      spawns += 1;
      bucket = agentFor(args.agent ?? "unknown");
      bucket.spawns += 1;
      if (args.name && args.agent) instanceAgent.set(args.name, args.agent);
    } else if (c.name === "subagent_message") {
      messages += 1;
      const agent = (args.name && instanceAgent.get(args.name)) || null;
      bucket = agentFor(agent ?? "(direct)");
      bucket.messages += 1;
    } else {
      lists += 1;
    }
    const r = resultById.get(c.id);
    if (!r) continue;
    if (r.err) {
      errors += 1;
      if (bucket) bucket.errors += 1;
    }
    const d = Date.parse(r.ts) - Date.parse(c.ts);
    if (Number.isFinite(d) && d >= 0) {
      latencySum += d;
      latencyCount += 1;
      if (bucket) {
        bucket.latencySum += d;
        bucket.latencyCount += 1;
      }
    }
  }
  return {
    spawns,
    messages,
    lists,
    errors,
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
    byAgent: [...agents.values()]
      .map((a) => ({
        agent: a.agent,
        spawns: a.spawns,
        messages: a.messages,
        errors: a.errors,
        avgLatencyMs: a.latencyCount > 0 ? Math.round(a.latencySum / a.latencyCount) : 0,
      }))
      .sort((a, b) => b.spawns + b.messages - (a.spawns + a.messages) || a.agent.localeCompare(b.agent)),
  };
}

export function aggregateSessions(sessions) {
  const byDay = {};
  const byProjectMap = new Map();
  const blocksByFamily = {};
  const totals = { sessions: sessions.length, turns: 0, cost: 0, toolCalls: 0 };
  let cacheRead = 0;
  let cacheTotal = 0;
  let reasoning = 0;
  let reasoningTotal = 0;
  let blocksTotal = 0;
  let repeats = 0;
  let durationSum = 0;
  let durationCount = 0;
  const subagents = { spawns: 0, messages: 0, lists: 0, errors: 0, latencySum: 0, latencyCount: 0 };
  const agentsMap = new Map();
  const blocksByTool = {};
  const toolCallsByTool = {};
  const toolCostByTool = {};
  const pct1 = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  for (const s of sessions) {
    if (s.firstTs) {
      const day = s.firstTs.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + s.cost;
    }
    const p = byProjectMap.get(s.project) ?? { project: s.project, sessions: 0, turns: 0, cost: 0 };
    p.sessions += 1;
    p.turns += s.turns;
    p.cost += s.cost;
    byProjectMap.set(s.project, p);
    totals.turns += s.turns;
    totals.cost += s.cost;
    totals.toolCalls += s.toolCalls;
    cacheRead += s.cacheReadTokens ?? 0;
    cacheTotal += (s.cacheReadTokens ?? 0) + (s.inputTokens ?? 0);
    reasoning += s.reasoningTokens ?? 0;
    reasoningTotal += (s.reasoningTokens ?? 0) + (s.outputTokens ?? 0);
    const agent = s.agent ?? {};
    blocksTotal += agent.blocks ?? 0;
    repeats += agent.repeatWithoutChange ?? 0;
    for (const [family, count] of Object.entries(agent.blocksByFamily ?? {})) {
      blocksByFamily[family] = (blocksByFamily[family] ?? 0) + count;
    }
    if (s.durationSec > 0) {
      durationSum += s.durationSec;
      durationCount += 1;
    }
    const sa = s.subagents ?? { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0 };
    subagents.spawns += sa.spawns;
    subagents.messages += sa.messages;
    subagents.lists += sa.lists;
    subagents.errors += sa.errors;
    if (sa.avgLatencyMs > 0) {
      subagents.latencySum += sa.avgLatencyMs;
      subagents.latencyCount += 1;
    }
    for (const a of sa.byAgent ?? []) {
      const t =
        agentsMap.get(a.agent) ??
        { agent: a.agent, spawns: 0, messages: 0, errors: 0, latencySum: 0, latencyCount: 0 };
      t.spawns += a.spawns;
      t.messages += a.messages;
      t.errors += a.errors;
      t.latencySum += a.avgLatencyMs;
      t.latencyCount += a.avgLatencyMs > 0 ? 1 : 0;
      agentsMap.set(a.agent, t);
    }
    for (const [tool, count] of Object.entries(s.blocksByTool ?? {})) {
      blocksByTool[tool] = (blocksByTool[tool] ?? 0) + count;
    }
    for (const [tool, count] of Object.entries(s.tools ?? {})) {
      toolCallsByTool[tool] = (toolCallsByTool[tool] ?? 0) + count;
    }
    for (const [tool, cost] of Object.entries(s.toolCosts ?? {})) {
      toolCostByTool[tool] = (toolCostByTool[tool] ?? 0) + cost;
    }
  }
  // Avoided-spend proxy: every blocked call is credited the average observed
  // cost of one call of the same tool; tools with no observed cost fall back
  // to the global per-call average.
  const toolAvgCost = {};
  for (const tool of Object.keys(toolCallsByTool)) {
    toolAvgCost[tool] = toolCallsByTool[tool] > 0 ? toolCostByTool[tool] / toolCallsByTool[tool] : 0;
  }
  const toolCostSum = Object.values(toolCostByTool).reduce((acc, c) => acc + c, 0);
  const globalAvgCost = totals.toolCalls > 0 ? toolCostSum / totals.toolCalls : 0;
  let avoidedSpend = 0;
  for (const [tool, count] of Object.entries(blocksByTool)) {
    avoidedSpend += count * (toolAvgCost[tool] ?? globalAvgCost);
  }
  const byAgent = [...agentsMap.values()]
    .map((t) => ({
      agent: t.agent,
      spawns: t.spawns,
      messages: t.messages,
      errors: t.errors,
      avgLatencyMs: t.latencyCount > 0 ? Math.round(t.latencySum / t.latencyCount) : 0,
    }))
    .sort((a, b) => b.spawns + b.messages - (a.spawns + a.messages) || a.agent.localeCompare(b.agent));
  const byProject = [...byProjectMap.values()]
    .map((p) => ({ ...p, cost: Number(p.cost.toFixed(6)) }))
    .sort((a, b) => b.cost - a.cost);
  for (const day of Object.keys(byDay)) byDay[day] = Number(byDay[day].toFixed(6));
  return {
    byDay,
    byProject,
    totals: { ...totals, cost: Number(totals.cost.toFixed(6)) },
    cacheHitRate: pct1(cacheRead, cacheTotal),
    reasoningShare: pct1(reasoning, reasoningTotal),
    blocksTotal,
    blocksByFamily,
    blocksPerSession: sessions.length > 0 ? Number((blocksTotal / sessions.length).toFixed(2)) : 0,
    repeatPct: pct1(repeats, totals.toolCalls),
    avgDurationSec: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    subagents: {
      spawns: subagents.spawns,
      messages: subagents.messages,
      lists: subagents.lists,
      errors: subagents.errors,
      avgLatencyMs:
        subagents.latencyCount > 0 ? Math.round(subagents.latencySum / subagents.latencyCount) : 0,
      byAgent,
    },
    blocksByTool,
    avoidedSpend: Number(avoidedSpend.toFixed(6)),
  };
}

/** Per-model rollup across raw extracts: turns and cost per model. */
export function aggregateModelMix(rawExtracts) {
  const mix = new Map();
  for (const extract of rawExtracts) {
    for (const [model, usage] of Object.entries(extract.usage ?? {})) {
      const m = mix.get(model) ?? { model, turns: 0, cost: 0 };
      m.turns += usage.turns ?? 0;
      m.cost += usage.costTotal ?? 0;
      mix.set(model, m);
    }
  }
  return [...mix.values()]
    .map((m) => ({ ...m, cost: Number(m.cost.toFixed(6)) }))
    .sort((a, b) => b.cost - a.cost);
}

/** Daily/weekly spend rollup with a linear end-of-day projection. Days are UTC. */
export function spendSummary(sessions, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${dayKey(nowMs)}T00:00:00Z`);
  const dayMs = 86_400_000;
  const byDay = {};
  for (const s of sessions) {
    if (!s.firstTs) continue;
    const key = s.firstTs.slice(0, 10);
    byDay[key] = (byDay[key] ?? 0) + s.cost;
  }
  const todayKey = dayKey(dayStart);
  let today = 0;
  let week = 0;
  for (const [key, cost] of Object.entries(byDay)) {
    if (key === todayKey) today += cost;
    if (Date.parse(`${key}T00:00:00Z`) >= dayStart - 6 * dayMs) week += cost;
  }
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(dayStart - i * dayMs);
    days.push({ day: key, cost: Number((byDay[key] ?? 0).toFixed(6)) });
  }
  const elapsedFraction = (nowMs - dayStart) / dayMs;
  let projectedToday = 0;
  if (today > 0) projectedToday = elapsedFraction >= 0.05 ? Number((today / elapsedFraction).toFixed(2)) : null;
  return {
    today: Number(today.toFixed(6)),
    week: Number(week.toFixed(6)),
    projectedToday,
    days,
  };
}

/** Sessions at (>=100%) or near (>=80%) a per-session cost budget. */
export function costAlerts(sessions, budgetUsd) {
  if (!budgetUsd || budgetUsd <= 0) return [];
  return sessions
    .map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      cost: s.cost,
      budget: budgetUsd,
      pct: Math.round((s.cost / budgetUsd) * 100),
    }))
    .filter((a) => a.pct >= 80)
    .map((a) => ({ ...a, level: a.pct >= 100 ? "over" : "near" }))
    .sort((a, b) => b.pct - a.pct);
}

/** Time-bucketed activity (turns, cost, tool calls) for a session timeline chart. */
export function sessionTimeline(extract, bucketMs = 300_000) {
  const buckets = new Map();
  const bucketFor = (ts) => {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return null;
    const start = Math.floor(t / bucketMs) * bucketMs;
    let b = buckets.get(start);
    if (!b) {
      b = { start, turns: 0, cost: 0, calls: 0 };
      buckets.set(start, b);
    }
    return b;
  };
  for (const turn of extract.turns ?? []) {
    const b = bucketFor(turn.ts);
    if (!b) continue;
    b.turns += 1;
    b.cost += typeof turn.usage?.cost?.total === "number" ? turn.usage.cost.total : 0;
  }
  for (const call of extract.calls ?? []) {
    const b = bucketFor(call.ts);
    if (b) b.calls += 1;
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, cost: Number(b.cost.toFixed(6)) }))
    .sort((a, b) => a.start - b.start);
}

/** Permission-gate overview: block totals by family plus every rule's severity. */
/**
 * Config rule ids grouped by the block family they emit (family = block-reason
 * prefix in the permission gate). Extracts count blocks per family only, so
 * severity is joined at family granularity: worst severity among the rules.
 */
const FAMILY_RULES = {
  anchor: ["editAnchorGuard", "editRegionGuard"],
  tokens: [
    "reReadGuard",
    "reReadConsume",
    "largeReadGuard",
    "locateFirst",
    "nativeReadFirst",
    "nativeBashFirst",
    "outputCap",
    "readOutputCap",
    "rerunGuard",
    "reblockEscalation",
    "readerBypass",
    "bashViewCredit",
  ],
  search: ["searchScope", "searchMidPipe", "searchReplaceFlag", "findFirst", "searchPortability"],
  gate: ["commitMessageLint", "errorSwallow", "outputScrub"],
  toolchain: ["toolchainPnpm", "toolchainNode"],
  loop: ["loopGuard", "failureLoopGuard"],
};
const RULE_FAMILY = new Map(
  Object.entries(FAMILY_RULES).flatMap(([family, ids]) => ids.map((id) => [id, family])),
);

export function gateSummary(blocksByFamily = {}, rules = {}, extra = {}) {
  const byFamily = { ...blocksByFamily };
  let total = 0;
  for (const n of Object.values(byFamily)) total += n;
  const order = { error: 0, warn: 1, off: 2 };
  const ruleList = Object.entries(rules)
    .map(([id, severity]) => ({ id, severity, family: RULE_FAMILY.get(id) ?? null }))
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id));
  const bySeverity = { error: 0, warn: 0, off: 0 };
  for (const r of ruleList) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  const familySeverity = {};
  for (const family of Object.keys(byFamily)) {
    let worst = null;
    for (const id of FAMILY_RULES[family] ?? []) {
      const sev = rules[id];
      if (!sev) continue;
      if (worst === null || (order[sev] ?? 9) < (order[worst] ?? 9)) worst = sev;
    }
    familySeverity[family] = worst;
  }
  return {
    total,
    byFamily,
    rules: ruleList,
    bySeverity,
    familySeverity,
    blocksByTool: extra.blocksByTool ?? {},
    avoidedSpend: extra.avoidedSpend ?? 0,
  };
}

/** User-prompt previews read from a raw session file (local only, capped). */
export function readPrompts(sessionFile, cap = 200) {
  let content;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const prompts = [];
  for (const line of content.split("\n")) {
    if (prompts.length >= cap) break;
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    const m = entry.message;
    if (!m || m.role !== "user") continue;
    const raw =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b?.type === "text")
              .map((b) => b.text)
              .join(" ")
          : "";
    const tsRaw = m.timestamp;
    prompts.push({
      ts: typeof tsRaw === "number" ? new Date(tsRaw).toISOString() : tsRaw ?? null,
      preview: raw.replace(/\s+/g, " ").trim().slice(0, 120),
    });
  }
  return prompts;
}

export function createSessionTailer(sessionFile) {
  let offset = 0;
  return {
    file: sessionFile,
    turns: 0,
    cost: 0,
    tick() {
      let content;
      try {
        content = readFileSync(sessionFile, "utf8");
      } catch {
        return [];
      }
      if (content.length <= offset) return [];
      const fresh = content.slice(offset);
      const lastNewline = fresh.lastIndexOf("\n");
      if (lastNewline === -1) return [];
      const complete = fresh.slice(0, lastNewline + 1);
      offset += complete.length;

      const events = [];
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type !== "message") continue;
        const message = entry.message;
        if (!message || message.role !== "assistant") continue;
        const cost = message.usage?.cost?.total;
        const contentBlocks = Array.isArray(message.content) ? message.content : [];
        const toolCalls = contentBlocks.filter((b) => typeof b?.type === "string" && b.type.toLowerCase().includes("tool")).length;
        this.turns += 1;
        this.cost += typeof cost === "number" ? cost : 0;
        events.push({
          kind: "turn",
          ts: message.timestamp ?? null,
          model: message.model ?? null,
          cost: typeof cost === "number" ? Number(cost.toFixed(6)) : 0,
          durationMs: typeof message.durationMs === "number" ? message.durationMs : null,
          toolCalls,
        });
      }
      return events;
    },
  };
}

/** Full per-session detail: everything the pidx extract carries. */
/** Chronological spawn records (agent type + instance name) for one session. */
export function subagentSpawnList(extract, cap = 50) {
  const calls = extract.calls ?? [];
  if (!calls.some((c) => c.name === "subagent")) return [];
  const argsById = readSubagentArgs(extract.path);
  return calls
    .filter((c) => c.name === "subagent")
    .slice(0, cap)
    .map((c) => {
      const a = argsById.get(c.id) ?? {};
      return { id: c.id, ts: c.ts ?? null, agent: a.agent ?? "unknown", name: a.name ?? null };
    });
}

export function detailFor(extract) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    sessionId: extract.sessionId,
    project: extract.project,
    summary: summarizeSession(extract),
    turns: (extract.turns ?? []).map((t, i) => ({
      i,
      ts: t.ts ?? null,
      model: t.model ?? null,
      input: num(t.usage?.input),
      output: num(t.usage?.output),
      reasoning: num(t.usage?.reasoning),
      cacheRead: num(t.usage?.cacheRead),
      cacheWrite: num(t.usage?.cacheWrite),
      totalTokens: num(t.usage?.totalTokens),
      cost: num(t.usage?.cost?.total),
    })),
    calls: (extract.calls ?? []).map((c) => ({
      name: c.name,
      ts: c.ts,
      cmd: c.cmd ?? null,
      path: c.path ?? null,
    })),
    timeline: sessionTimeline(extract),
    prompts: readPrompts(extract.path),
    subagents: subagentMetrics(
      extract.calls ?? [],
      extract.results ?? [],
      (extract.calls ?? []).some((c) => SUBAGENT_CALL_NAMES.has(c.name))
        ? readSubagentArgs(extract.path)
        : new Map(),
    ),
    subagentSpawns: subagentSpawnList(extract),
    compactions: typeof extract.compactions === "number" ? extract.compactions : 0,
    skills: extract.skills && typeof extract.skills === "object" ? extract.skills : {},
    usageByModel: extract.usage ?? {},
  };
}
