#!/usr/bin/env node
/**
 * Real-time dashboard over existing pi session logs.
 *
 * Data layer (pure, unit-tested):
 *   - summarizeSession: one pidx extract line → session summary
 *   - aggregateSessions: summaries → by-day cost, by-project rollups, totals
 *   - createSessionTailer: incremental tail of a live session .jsonl → events
 *
 * Server shell (infra — no unit tests; verified by launching and curling):
 *   GET /            single-page UI (vanilla JS, no build step, no deps)
 *   GET /api/sessions  full snapshot: sessions + aggregates + active tails
 *   GET /api/stream    SSE: `snapshot` on each pidx cycle, `live` per new turn
 *
 * Finished sessions come from bin/pidx (incremental, cached under .cache/).
 * Active sessions (which pidx excludes) are found by mtime and tailed here.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metrics as gateMetrics } from "../tests/tools/audit/gate-metrics.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PIDX_BIN = join(REPO_ROOT, "bin", "pidx");
const SESSIONS_DIR = process.env.PI_DASH_SESSIONS_DIR ?? join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions");
const STATE_FILE = join(REPO_ROOT, ".cache", "dashboard-pidx-state.bin");
const GATE_CONFIG = join(REPO_ROOT, "extensions", "permission-gate", "config.json");
const OUT_FILE = join(REPO_ROOT, ".cache", "dashboard-extracts.jsonl");
const PORT = Number(process.env.PI_DASH_PORT ?? 8787);
/** Optional per-session cost budget in USD; 0 disables budget alerts. */
const SESSION_BUDGET = Number(process.env.PI_DASH_SESSION_BUDGET ?? 0);
const POLL_MS = 2_000;
const ACTIVE_WINDOW_MS = 120_000;

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
    subagents: subagentMetrics(calls, extract.results ?? []),
    toolCosts,
  };
}

/** Subagent activity derived from subagent-family calls joined with their results. */
export function subagentMetrics(calls = [], results = []) {
  const resultById = new Map(results.map((r) => [r.id, r]));
  let spawns = 0;
  let messages = 0;
  let lists = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyCount = 0;
  for (const c of calls) {
    if (c.name === "subagent") spawns += 1;
    else if (c.name === "subagent_message") messages += 1;
    else if (c.name === "subagents_list") lists += 1;
    else continue;
    const r = resultById.get(c.id);
    if (!r) continue;
    if (r.err) errors += 1;
    const d = Date.parse(r.ts) - Date.parse(c.ts);
    if (Number.isFinite(d) && d >= 0) {
      latencySum += d;
      latencyCount += 1;
    }
  }
  return {
    spawns,
    messages,
    lists,
    errors,
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
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
  }
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
    },
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
export function gateSummary(blocksByFamily = {}, rules = {}) {
  const byFamily = { ...blocksByFamily };
  let total = 0;
  for (const n of Object.values(byFamily)) total += n;
  const order = { error: 0, warn: 1, off: 2 };
  const ruleList = Object.entries(rules)
    .map(([id, severity]) => ({ id, severity }))
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id));
  const bySeverity = { error: 0, warn: 0, off: 0 };
  for (const r of ruleList) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  return { total, byFamily, rules: ruleList, bySeverity };
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

// ── Server shell ─────────────────────────────────────────────

/** Full per-session detail: everything the pidx extract carries. */
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
    subagents: subagentMetrics(extract.calls ?? [], extract.results ?? []),
    compactions: typeof extract.compactions === "number" ? extract.compactions : 0,
    skills: extract.skills && typeof extract.skills === "object" ? extract.skills : {},
    usageByModel: extract.usage ?? {},
  };
}

function readGateRules() {
  try {
    const cfg = JSON.parse(readFileSync(GATE_CONFIG, "utf8"));
    return cfg?.rules && typeof cfg.rules === "object" ? cfg.rules : {};
  } catch {
    return {};
  }
}

function runPidx() {
  return new Promise((resolvePromise) => {
    execFile(
      PIDX_BIN,
      ["--sessions-dir", SESSIONS_DIR, "--state", STATE_FILE, "--out", OUT_FILE],
      { timeout: 30_000 },
      (error, _stdout, stderr) => resolvePromise({ ok: !error, stderr: String(stderr).slice(0, 200) }),
    );
  });
}

async function readRawExtracts() {
  if (!existsSync(OUT_FILE)) return [];
  const raw = await readFile(OUT_FILE, "utf8");
  const lines = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed extract lines; the next pidx cycle rewrites the file.
    }
  }
  return lines;
}

async function readExtracts() {
  return (await readRawExtracts()).map(summarizeSession);
}

async function findActiveFiles() {
  const found = [];
  const now = Date.now();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const mtime = (await stat(full)).mtimeMs;
          if (now - mtime < ACTIVE_WINDOW_MS) found.push(full);
        } catch {}
      }
    }
  }
  await walk(SESSIONS_DIR);
  return found;
}

const sseClients = new Set();

function broadcast(event, data) {
  for (const res of sseClients) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

let pidxRunning = false;
async function cycle(tailers) {
  if (!pidxRunning) {
    pidxRunning = true;
    const { ok, stderr } = await runPidx();
    pidxRunning = false;
    if (!ok) console.error(`pidx failed: ${stderr}`);
  }

  const activeFiles = await findActiveFiles();
  for (const file of activeFiles) {
    if (!tailers.has(file)) tailers.set(file, createSessionTailer(file));
  }
  const active = [];
  for (const [file, tailer] of tailers) {
    const events = tailer.tick();
    if (events.length > 0) {
      broadcast("live", { file: basename(file), events });
    }
    if (!activeFiles.includes(file)) {
      tailers.delete(file);
      continue;
    }
    active.push({
      file: basename(file),
      path: file,
      project: basename(dirname(file)),
      turns: tailer.turns,
      cost: Number(tailer.cost.toFixed(6)),
    });
  }

  const raw = await readRawExtracts();
  const idByPath = new Map(raw.map((e) => [e.path, e.sessionId]));
  for (const a of active) a.sessionId = idByPath.get(a.path) ?? null;
  const sessions = raw.map(summarizeSession);
  const sessionsAgg = aggregateSessions(sessions);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    sessions: sessions.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "")),
    aggregates: {
      ...sessionsAgg,
      modelMix: aggregateModelMix(raw),
      spend: spendSummary(sessions, new Date()),
      alerts: costAlerts(sessions, SESSION_BUDGET),
      gate: gateSummary(sessionsAgg.blocksByFamily, readGateRules()),
    },
    active,
  };
  broadcast("snapshot", snapshot);
  return snapshot;
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>pi sessions</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, monospace; margin: 0; background: #0d1117; color: #c9d1d9; }
  header { padding: 10px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 24px; align-items: baseline; }
  header h1 { font-size: 15px; margin: 0; }
  .stat { font-size: 12px; color: #8b949e; }
  .stat b { color: #c9d1d9; }
  main { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, 1fr); height: calc(100vh - 45px); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #161b22; white-space: nowrap; }
  th { color: #8b949e; font-weight: normal; position: sticky; top: 0; background: #0d1117; }
  tr:hover, tr.sel { background: #161b22; cursor: pointer; }
  .live { color: #3fb950; }
  #detail { border-left: 1px solid #21262d; padding: 12px 16px; overflow-y: auto; font-size: 12px; }
  #detail h2 { font-size: 13px; margin: 4px 0 10px; word-break: break-all; }
  #detail svg { width: 100%; height: 80px; }
  #feed { margin-top: 14px; border-top: 1px solid #21262d; padding-top: 8px; }
  #feed div { padding: 2px 0; color: #8b949e; }
  .bar { fill: #58a6ff; }
  .num { text-align: right; }
</style></head><body>
<header>
  <h1>pi sessions</h1>
  <span class="stat" id="totals"></span>
  <span class="stat live" id="conn">connecting…</span>
</header>
<main>
  <div style="overflow-y:auto"><table id="tbl"><thead><tr>
    <th>session</th><th>project</th><th>model(s)</th><th class="num">turns</th><th class="num">cost</th><th>last</th>
  </tr></thead><tbody></tbody></table></div>
  <div id="detail"><h2>select a session</h2><div id="feed"></div></div>
</main>
<script>
let snapshot = null, selected = null;
const fmtCost = (c) => '$' + c.toFixed(3);
const ago = (ts) => { if (!ts) return '-'; const s = (Date.now() - new Date(ts)) / 1000;
  return s < 60 ? s.toFixed(0) + 's' : s < 3600 ? (s/60).toFixed(0) + 'm' : (s/3600).toFixed(1) + 'h'; };
function render() {
  if (!snapshot) return;
  const tb = document.querySelector('#tbl tbody');
  const activeFiles = new Set(snapshot.active.map(a => a.file));
  tb.innerHTML = snapshot.sessions.map(s => {
    const file = (s.path || '').split('/').pop();
    const live = activeFiles.has(file);
    return '<tr data-id="' + s.sessionId + '" class="' + (selected === s.sessionId ? 'sel' : '') + '">' +
      '<td>' + (live ? '<span class="live">●</span> ' : '') + s.sessionId.slice(0, 12) + '</td>' +
      '<td title="' + s.project + '">' + (s.project || '').split('/').pop().slice(0, 24) + '</td>' +
      '<td>' + s.models.join(',') + '</td>' +
      '<td class="num">' + s.turns + '</td>' +
      '<td class="num">' + fmtCost(s.cost) + '</td>' +
      '<td>' + ago(s.lastTs) + '</td></tr>';
  }).join('');
  document.getElementById('totals').innerHTML =
    '<b>' + snapshot.aggregates.totals.sessions + '</b> sessions · <b>' +
    snapshot.aggregates.totals.turns + '</b> turns · <b>' + fmtCost(snapshot.aggregates.totals.cost) + '</b> · <b>' +
    snapshot.aggregates.totals.toolCalls + '</b> tool calls';
  document.querySelectorAll('#tbl tbody tr').forEach(tr =>
    tr.onclick = () => { selected = tr.dataset.id; renderDetail(); render(); });
  if (selected) renderDetail();
}
function renderDetail() {
  const s = snapshot.sessions.find(x => x.sessionId === selected);
  if (!s) return;
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1])
    .map(([n, c]) => n + '×' + c).join('  ') || 'none';
  document.querySelector('#detail h2').textContent = s.project + ' — ' + s.sessionId;
  const turns = [];
  for (const s2 of [s]) {} // placeholder to keep scoping simple
  document.getElementById('feed').innerHTML =
    '<div>turns <b>' + s.turns + '</b> · cost <b>' + fmtCost(s.cost) + '</b> · tools: ' + tools + '</div>';
}
const es = new EventSource('/api/stream');
es.addEventListener('snapshot', (e) => { snapshot = JSON.parse(e.data); render(); });
es.addEventListener('live', (e) => {
  const d = JSON.parse(e.data);
  const feed = document.getElementById('feed');
  for (const ev of d.events.slice(-3)) {
    const div = document.createElement('div');
    div.textContent = new Date().toISOString().slice(11, 19) + ' ' + d.file.slice(0, 20) +
      (ev.model ? ' ' + ev.model : '') + (ev.cost ? ' +' + fmtCost(ev.cost) : '');
    feed.prepend(div);
  }
  while (feed.children.length > 30) feed.lastChild.remove();
});
es.onopen = () => document.getElementById('conn').textContent = 'live';
es.onerror = () => document.getElementById('conn').textContent = 'reconnecting…';
</script></body></html>`;

async function main() {
  const tailers = new Map();
  const server = createServer(async (req, res) => {
    if (req.url === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.url?.startsWith("/api/session/")) {
      const id = decodeURIComponent(req.url.slice("/api/session/".length));
      const raw = (await readRawExtracts()).find((e) => e.sessionId === id);
      if (!raw) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(detailFor(raw)));
      return;
    }
    if (req.url === "/api/sessions") {
      const snapshot = await cycle(tailers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.url === "/" || req.url?.startsWith("/assets/")) {
      const DASH_DIST = join(REPO_ROOT, "dashboard", "dist");
      const rel = req.url === "/" ? "index.html" : req.url.slice(1);
      const file = join(DASH_DIST, rel);
      if (existsSync(file)) {
        const mime =
          { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }[
            file.slice(file.lastIndexOf("."))
          ] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": mime });
        res.end(await readFile(file));
        return;
      }
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`dashboard: http://127.0.0.1:${PORT} (sessions: ${SESSIONS_DIR})`);
  await cycle(tailers);
  setInterval(() => {
    cycle(tailers).catch((err) => console.error("cycle failed:", err?.message));
  }, POLL_MS);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
