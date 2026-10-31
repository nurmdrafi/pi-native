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

/** Local YYYY-MM-DD for a timestamp: the dashboard is a single-user local
 * tool and its calendar picks local days, so day keys must be local days to
 * match, not UTC slices. */
export const localDayKey = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
    gateTags: gateTagCounts(extract.path),
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

/** Nearest-rank percentile of a latency pool in ms. Null unless the pool
 * holds at least two samples: one sample is already reported exactly by the
 * average, so percentiles of it would add no information and stay absent. */
const percentileMs = (pool, p) => {
  if (!Array.isArray(pool) || pool.length < 2) return null;
  const sorted = [...pool].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return Math.round(sorted[rank - 1]);
};

/** Nearest-rank percentile in ms over weighted (v, w) pairs — each pair one
 * session's contribution, weighted by its message count (spawn count for lag
 * medians). Null under two contributing pairs, same reasoning as
 * percentileMs. */
const weightedPercentileMs = (pairs, p) => {
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((acc, x) => acc + x.w, 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const x of sorted) {
    cum += x.w;
    if (cum >= p * total) return Math.round(x.v);
  }
  return Math.round(sorted[sorted.length - 1].v);
};

/** Subagent metrics from one session's subagent-family calls joined with
 * their results. Latency percentiles pool the per-message latencies the
 * transcript allows here (each call→result gap); the spawn lag is the gap
 * from a subagent call to that instance's first subagent_message call,
 * pooled per agent across its instances. */
export function subagentMetrics(calls = [], results = [], argsById = new Map()) {
  const resultById = new Map(results.map((r) => [r.id, r]));
  const instanceAgent = new Map();
  const agents = new Map();
  const agentFor = (key) => {
    let a = agents.get(key);
    if (!a) {
      a = {
        agent: key,
        spawns: 0,
        messages: 0,
        lists: 0,
        errors: 0,
        latencySum: 0,
        latencyCount: 0,
        latencies: [],
        spawnLags: [],
      };
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
  const latencies = [];
  const spawnTsByName = new Map();
  const firstMsgTsByName = new Map();
  for (const c of calls) {
    if (!SUBAGENT_CALL_NAMES.has(c.name)) continue;
    const args = argsById.get(c.id) ?? {};
    const cMs = Date.parse(c.ts);
    let bucket = null;
    if (c.name === "subagent") {
      spawns += 1;
      bucket = agentFor(args.agent ?? "unknown");
      bucket.spawns += 1;
      if (args.name && args.agent) instanceAgent.set(args.name, args.agent);
      if (args.name && !spawnTsByName.has(args.name) && Number.isFinite(cMs))
        spawnTsByName.set(args.name, cMs);
    } else if (c.name === "subagent_message") {
      messages += 1;
      const agent = (args.name && instanceAgent.get(args.name)) || null;
      bucket = agentFor(agent ?? "(direct)");
      bucket.messages += 1;
      if (args.name && !firstMsgTsByName.has(args.name) && Number.isFinite(cMs))
        firstMsgTsByName.set(args.name, cMs);
    } else {
      lists += 1;
    }
    const r = resultById.get(c.id);
    if (!r) continue;
    if (r.err) {
      errors += 1;
      if (bucket) bucket.errors += 1;
    }
    const d = Date.parse(r.ts) - cMs;
    if (Number.isFinite(d) && d >= 0) {
      latencySum += d;
      latencyCount += 1;
      latencies.push(d);
      if (bucket) {
        bucket.latencySum += d;
        bucket.latencyCount += 1;
        bucket.latencies.push(d);
      }
    }
  }
  // Spawn→first-message lag per instance, pooled under the spawning agent.
  for (const [name, spawnMs] of spawnTsByName) {
    const firstMs = firstMsgTsByName.get(name);
    if (!Number.isFinite(firstMs)) continue;
    const lag = firstMs - spawnMs;
    if (lag >= 0) agentFor(instanceAgent.get(name) ?? "unknown").spawnLags.push(lag);
  }
  const withPercentiles = (entry, pool) => {
    const p50 = percentileMs(pool, 0.5);
    const p95 = percentileMs(pool, 0.95);
    if (p50 != null) entry.p50LatencyMs = p50;
    if (p95 != null) entry.p95LatencyMs = p95;
    return entry;
  };
  const out = {
    spawns,
    messages,
    lists,
    errors,
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
  };
  withPercentiles(out, latencies);
  out.byAgent = [...agents.values()]
    .map((a) => {
      const entry = {
        agent: a.agent,
        spawns: a.spawns,
        messages: a.messages,
        errors: a.errors,
        avgLatencyMs: a.latencyCount > 0 ? Math.round(a.latencySum / a.latencyCount) : 0,
      };
      withPercentiles(entry, a.latencies);
      const medianLag = percentileMs(a.spawnLags, 0.5);
      if (medianLag != null) entry.spawnToFirstMsgMs = medianLag;
      return entry;
    })
    .sort((a, b) => b.spawns + b.messages - (a.spawns + a.messages) || a.agent.localeCompare(b.agent));
  return out;
}

// ── Gate rule events (per-rule block/warn counts) ──────────────────────────
/** A guard reason head: `Family (Qualifier): …`. The tag is the rule's own
 * identity in a transcript — the same text the gate writes in front of the
 * fix — so counting tags yields per-rule numbers without the gate writing
 * any state of its own. */
const GATE_TAG_SRC =
  String.raw`(?:Anchor Guard|Token Economy|Loop Guard|Search|Hygiene|Portability|Toolchain|Permission Gate|Phase|Locate-first)(?: \([A-Za-z0-9 /._-]{1,28}\))?`;
const GATE_TAG_ANY = new RegExp(`${GATE_TAG_SRC}(?=:)`, "g");
const GATE_TAG_HEAD = new RegExp(`^${GATE_TAG_SRC}(?=:)`);

/** Tag → config keys in extensions/permission-gate/config.json. A tag two
 * rules share lists both; the outcome then separates them (a blocked call is
 * the strict sibling, a note is the teaching rule). */
export const GATE_TAG_RULES = {
  "Hygiene (Reader-bypass)": ["readerBypass"],
  "Hygiene (Error-swallow)": ["errorSwallow"],
  "Search (Scope)": ["searchScope"],
  "Search (rg-first)": ["searchMidPipe"],
  "Search (fd-first)": ["findFirst"],
  "Search (rg -r)": ["searchReplaceFlag"],
  "Portability (grep -P)": ["searchPortability"],
  "Anchor Guard (Unread)": ["editRegionGuard"],
  "Anchor Guard (Stale)": ["editAnchorGuard"],
  "Anchor Guard (Stale-relaxed)": ["editAnchorGuard"],
  "Anchor Guard": ["editAnchorGuard"],
  "Token Economy (Re-read)": ["reReadGuard", "reReadConsume"],
  "Token Economy (Big read)": ["largeReadGuard"],
  "Token Economy (Piread-first)": ["nativeReadFirst"],
  "Token Economy (Pibash-first)": ["nativeBashFirst"],
  "Token Economy (Re-run)": ["rerunGuard"],
  "Token Economy (Re-block)": ["reblockEscalation"],
  "Locate-first": ["locateFirst"],
  "Loop Guard (LG1)": ["loopGuard"],
  "Loop Guard (Failure loop)": ["failureLoopGuard"],
  "Toolchain (pnpm)": ["toolchainPnpm"],
  "Toolchain (Node)": ["toolchainNode"],
  "Permission Gate (Destructive)": ["destructiveConfirm"],
  "Phase (PH1)": ["phaseNudge"],
  // Retired rule tags still present in transcripts. Each is mapped to the live
  // rule that now owns the behaviour, so an old count lands on a real row
  // instead of an "unmapped" bucket. Verified against session history: these
  // were reasons the gate emitted before the read/output rules were merged.
  "Search (node_modules)": ["searchScope"],
  "Token Economy (Reading)": ["reReadGuard"],
  "Token Economy (Extraction)": ["outputCap"],
  "Token Economy (Command output)": ["outputCap"],
  "Token Economy (git reads)": ["outputCap"],
  "Token Economy (git hooks)": ["outputCap"],
  "Permission Gate (Self-modify)": ["destructiveConfirm"],
  "Permission Gate (Internal)": ["__internal"],
};

/** Rows for guard events that belong to no config rule: the fail-closed
 * handler catch counts as a gate event, so it gets a row of its own rather
 * than disappearing into an "unknown" footnote. */
export const GATE_PSEUDO_RULES = {
  __internal: {
    code: "INT",
    group: "gate",
    label: "Internal gate error (fail-closed)",
  },
};

/** Count tagged reasons in one raw session file: a block is an error result
 * whose first text block is a reason; a note is a tag written into the last
 * text block of a successful result (the gate appends notes there). Only the
 * last block is scanned, so a command that merely prints a tag cannot inflate
 * the counts. Cached by stat — the dashboard polls every few seconds. */
const gateScanCache = new Map();
export function gateTagCounts(sessionFile) {
  if (!sessionFile) return {};
  let st;
  try {
    st = statSync(sessionFile);
  } catch {
    return {};
  }
  const hit = gateScanCache.get(sessionFile);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.counts;
  const counts = {};
  const add = (tag, kind, tool, day) => {
    const c = counts[tag] ?? { block: 0, warn: 0, tools: {}, toolsBlock: {}, toolsWarn: {} };
    c[kind] += 1;
    if (day) {
      c.byDay ??= {};
      const d = c.byDay[day] ?? { block: 0, warn: 0 };
      d[kind] += 1;
      c.byDay[day] = d;
    }
    if (tool) {
      c.tools[tool] = (c.tools[tool] ?? 0) + 1;
      const per = kind === "block" ? "toolsBlock" : "toolsWarn";
      c[per][tool] = (c[per][tool] ?? 0) + 1;
    }
    counts[tag] = c;
  };
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const nameById = new Map();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const inner = msg?.message ?? msg;
      const blocks = Array.isArray(inner?.content) ? inner.content : [];
      if (inner?.role === "assistant") {
        for (const b of blocks)
          if (b?.type === "toolCall" && b.id) nameById.set(b.id, b.name ?? null);
        continue;
      }
      if (inner?.role !== "toolResult") continue;
      const texts = blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
      if (texts.length === 0) continue;
      const tool = inner.toolName ?? nameById.get(inner.toolCallId) ?? null;
      // toolResult timestamps live on the wrapper entry; unwrapped lines keep
      // them on the message itself.
      const ts =
        typeof msg?.timestamp === "string" ? msg.timestamp : typeof inner.timestamp === "string" ? inner.timestamp : null;
      const day = ts ? localDayKey(ts) : null;
      if (inner.isError === true) {
        const m = texts[0].trimStart().match(GATE_TAG_HEAD);
        if (m) add(m[0], "block", tool, day);
        continue;
      }
      const last = texts[texts.length - 1];
      if (texts.length > 1 && GATE_TAG_HEAD.test(last))
        for (const m of last.matchAll(GATE_TAG_ANY)) add(m[0], "warn", tool, day);
    }
  } catch {
    return {};
  }
  gateScanCache.set(sessionFile, { mtimeMs: st.mtimeMs, size: st.size, counts });
  return counts;
}

/** Human names for the config keys — what the rule claims in the docs, not
 * the code symbol. `code` is the stable rule id used in source comments and
 * block reasons; `group` is the rule family the gate table groups by. */
export const GATE_RULE_META = {
  editAnchorGuard: { code: "AG", group: "anchor", label: "Edits anchor on lines already in context" },
  editRegionGuard: { code: "AG2", group: "anchor", label: "Edit batch reads every target region first" },
  reReadGuard: { code: "R1", group: "tokens", label: "No re-read of lines fully in context" },
  reReadConsume: { code: "R1x", group: "tokens", label: "Partial re-read (half the lines known)" },
  largeReadGuard: { code: "R1b", group: "tokens", label: "No whole-file read of a big file" },
  locateFirst: { code: "R1c", group: "tokens", label: "Locate before a wide first read" },
  nativeReadFirst: { code: "P1", group: "tokens", label: "Reads go through piread" },
  nativeBashFirst: { code: "P2", group: "tokens", label: "Shell calls go through pibash" },
  outputCap: { code: "H1", group: "tokens", label: "Bash output capped (40 lines / 2 KB)" },
  readOutputCap: { code: "H1b", group: "tokens", label: "Read output capped (300 lines / 8 KB)" },
  rerunGuard: { code: "R10", group: "tokens", label: "Identical re-run with no change since" },
  reblockEscalation: { code: "RB", group: "tokens", label: "Re-sending a blocked command escalates" },
  readerBypass: { code: "SE2", group: "tokens", label: "Read windows via piread, not cat/sed" },
  bashViewCredit: { code: "VC", group: "tokens", label: "View-command lines still credit read spans" },
  commitMessageLint: { code: "R9", group: "gate", label: "Commit message lint" },
  errorSwallow: { code: "SE1", group: "gate", label: "No '|| true' hiding a failure" },
  outputScrub: { code: "OS", group: "gate", label: "Output scrub (ANSI, test runs, builds)" },
  destructiveConfirm: { code: "H2", group: "gate", label: "Destructive command needs approval" },
  toolchainPnpm: { code: "TC1", group: "toolchain", label: "pnpm is the package manager here" },
  toolchainNode: { code: "TC2", group: "toolchain", label: "Node pin before node-family runs" },
  searchScope: { code: "SS1", group: "search", label: "Scope every search" },
  searchMidPipe: { code: "SS2", group: "search", label: "rg replaces grep in pipes" },
  findFirst: { code: "SS3", group: "search", label: "fd replaces find" },
  searchReplaceFlag: { code: "SS4", group: "search", label: "'-r' on rg means --replace" },
  searchPortability: { code: "PB1", group: "search", label: "No 'grep -P' on BSD" },
  loopGuard: { code: "LG1", group: "loop", label: "Same-target churn guard" },
  failureLoopGuard: { code: "R11", group: "loop", label: "Failure-streak guard" },
  phaseNudge: { code: "PH1", group: "advisory", label: "Phase label nudge" },
  cadenceNudge: { code: "CN", group: "advisory", label: "Cadence nudge (turns / context)" },
};

/** Group names in plain words, in display order. */
export const GATE_GROUP_LABELS = {
  anchor: "anchor guard",
  tokens: "token economy",
  search: "search",
  gate: "gate & destructive",
  toolchain: "toolchain",
  loop: "loop guard",
  advisory: "advisory",
};

/** Inverted tag map: for each rule id, the transcript tags whose counts land
 * on its row. First entry is the live tag — the string the gate prints in the
 * terminal — so the dashboard can lead with exactly what the operator saw;
 * retired aliases follow for search. */
const TAGS_BY_RULE = {};
for (const [tag, keys] of Object.entries(GATE_TAG_RULES)) {
  for (const key of keys) (TAGS_BY_RULE[key] ??= []).push(tag);
}

/** Cost stamped on one extract turn — the same field summarizeSession falls
 * back to when per-model usage totals are absent. */
const turnCost = (t) => (typeof t?.usage?.cost?.total === "number" ? t.usage.cost.total : 0);

/** Attribute one session's spend and tool traffic to the half-open epoch-ms
 * window [fromMs, toMs) at turn/call granularity; a null bound is open.
 * Extract turns and calls carry their own timestamps, so the window is tested
 * against those, never against whole-session lifetime totals. A turn or call
 * without a usable timestamp is booked on the session's last activity when
 * that lies inside the window (the closest remaining evidence of when it
 * happened) and dropped otherwise. Tool cost is not stamped per call, so each
 * tool's lifetime cost is prorated by its in-window share of that tool's
 * calls; a tool with no calls cannot be prorated and yields nothing. */
export function attributeSession(s, extract, fromMs = null, toMs = null) {
  const lastMs = s?.lastTs ? Date.parse(s.lastTs) : Number.NaN;
  const effMs = (ts) => {
    const t = ts != null ? Date.parse(ts) : Number.NaN;
    return Number.isFinite(t) ? t : lastMs;
  };
  const inWindow = (ms) =>
    Number.isFinite(ms) && (fromMs == null || ms >= fromMs) && (toMs == null || ms < toMs);
  let cost = 0;
  let turns = 0;
  const byDay = {};
  for (const t of extract?.turns ?? []) {
    const ms = effMs(t?.ts);
    if (!inWindow(ms)) continue;
    const c = turnCost(t);
    cost += c;
    turns += 1;
    const day = new Date(ms).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + c;
  }
  const toolCalls = {};
  const callsTotal = {};
  for (const call of extract?.calls ?? []) {
    callsTotal[call.name] = (callsTotal[call.name] ?? 0) + 1;
    if (inWindow(effMs(call?.ts))) toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
  }
  const toolCosts = {};
  for (const [name, lifetime] of Object.entries(s?.toolCosts ?? {})) {
    if (!(toolCalls[name] > 0)) continue;
    toolCosts[name] = Number((lifetime * (toolCalls[name] / (callsTotal[name] ?? 0))).toFixed(6));
  }
  return { cost, turns, byDay, toolCalls, toolCosts };
}

/** A per-session summary clipped to a date window: cost, turns, tool calls
 * and tool cost reflect only activity inside [fromMs, toMs). The client's
 * per-session rollups (the tools chart) read these objects directly, so the
 * window must be applied here as well as in the aggregates. Identity when the
 * window is unbounded or no extract is available (lifetime fallback). */
export function sessionRangeView(s, extract, fromMs = null, toMs = null) {
  if ((fromMs == null && toMs == null) || !extract) return s;
  const a = attributeSession(s, extract, fromMs, toMs);
  return {
    ...s,
    cost: Number(a.cost.toFixed(6)),
    turns: a.turns,
    tools: a.toolCalls,
    toolCosts: a.toolCosts,
  };
}

export function aggregateSessions(sessions, opts = {}) {
  const byDay = {};
  const byProjectMap = new Map();
  const blocksByFamily = {};
  const gateByDay = {};
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
  // Message-weighted (v, w) pools feeding the aggregate's latency
  // percentiles: one pair per contributing session, weight = message count.
  const latencyPairs = [];
  const agentsMap = new Map();
  const blocksByTool = {};
  const gateTags = {};
  const toolCallsByTool = {};
  const toolCostByTool = {};
  const pct1 = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  // Turn-level attribution for a date window: with raw extracts, cost, turns,
  // tool calls and day buckets are rebuilt from the turns/calls whose
  // timestamps fall inside [opts.from, opts.to). Summing lifetime totals for
  // every session merely touched by the window would show months of spend
  // under a one-day filter, and book a multi-day session's whole cost on its
  // first day. Without an extract the lifetime fields remain the fallback.
  const extractById = new Map((opts.raw ?? []).map((e) => [e.sessionId, e]));
  const bounded = opts.from != null || opts.to != null;
  for (const s of sessions) {
    const extract = extractById.get(s.sessionId);
    const attr = extract ? attributeSession(s, extract, opts.from ?? null, opts.to ?? null) : null;
    if (attr) {
      for (const [day, c] of Object.entries(attr.byDay)) byDay[day] = (byDay[day] ?? 0) + c;
    } else if (s.firstTs) {
      const day = s.firstTs.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + s.cost;
    }
    // A bounded window attributes only in-window turns/calls; unbounded keeps
    // the lifetime totals, which are exact for the whole-history view.
    const cost = attr && bounded ? attr.cost : s.cost;
    const turns = attr && bounded ? attr.turns : s.turns;
    const toolCallCount =
      attr && bounded
        ? Object.values(attr.toolCalls).reduce((acc, n) => acc + n, 0)
        : s.toolCalls;
    const p = byProjectMap.get(s.project) ?? { project: s.project, sessions: 0, turns: 0, cost: 0 };
    p.sessions += 1;
    p.turns += turns;
    p.cost += cost;
    byProjectMap.set(s.project, p);
    totals.turns += turns;
    totals.cost += cost;
    totals.toolCalls += toolCallCount;
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
    if (sa.messages > 0 && sa.avgLatencyMs > 0)
      latencyPairs.push({ v: sa.avgLatencyMs, w: sa.messages });
    for (const a of sa.byAgent ?? []) {
      const t =
        agentsMap.get(a.agent) ??
        { agent: a.agent, spawns: 0, messages: 0, errors: 0, latencySum: 0, latencyCount: 0, meanPairs: [], lagPairs: [] };
      t.spawns += a.spawns;
      t.messages += a.messages;
      t.errors += a.errors;
      t.latencySum += a.avgLatencyMs;
      t.latencyCount += a.avgLatencyMs > 0 ? 1 : 0;
      if (a.messages > 0 && a.avgLatencyMs > 0) t.meanPairs.push({ v: a.avgLatencyMs, w: a.messages });
      if (typeof a.spawnToFirstMsgMs === "number" && a.spawnToFirstMsgMs >= 0 && a.spawns > 0)
        t.lagPairs.push({ v: a.spawnToFirstMsgMs, w: a.spawns });
      agentsMap.set(a.agent, t);
    }
    for (const [tag, c] of Object.entries(s.gateTags ?? {})) {
      const cur = gateTags[tag] ?? { block: 0, warn: 0, tools: {}, toolsBlock: {}, toolsWarn: {} };
      cur.block += c.block ?? 0;
      cur.warn += c.warn ?? 0;
      for (const [tool, n] of Object.entries(c.tools ?? {})) cur.tools[tool] = (cur.tools[tool] ?? 0) + n;
      for (const [tool, n] of Object.entries(c.toolsBlock ?? {}))
        cur.toolsBlock[tool] = (cur.toolsBlock[tool] ?? 0) + n;
      for (const [tool, n] of Object.entries(c.toolsWarn ?? {}))
        cur.toolsWarn[tool] = (cur.toolsWarn[tool] ?? 0) + n;
      gateTags[tag] = cur;
      // Day-keyed copy of the same events, clipped to the caller's window so a
      // one-day filter shows that day's traffic only.
      for (const [day, d] of Object.entries(c.byDay ?? {})) {
        if (opts.fromDay && day < opts.fromDay) continue;
        if (opts.toDay && day > opts.toDay) continue;
        const curDay = gateByDay[day] ?? {};
        const curTag = curDay[tag] ?? { block: 0, warn: 0 };
        curTag.block += d.block ?? 0;
        curTag.warn += d.warn ?? 0;
        curDay[tag] = curTag;
        gateByDay[day] = curDay;
      }
    }
    for (const [tool, count] of Object.entries(s.blocksByTool ?? {})) {
      blocksByTool[tool] = (blocksByTool[tool] ?? 0) + count;
    }
    if (attr && bounded) {
      for (const [tool, count] of Object.entries(attr.toolCalls)) {
        toolCallsByTool[tool] = (toolCallsByTool[tool] ?? 0) + count;
      }
      for (const [tool, toolCost] of Object.entries(attr.toolCosts)) {
        toolCostByTool[tool] = (toolCostByTool[tool] ?? 0) + toolCost;
      }
    } else {
      for (const [tool, count] of Object.entries(s.tools ?? {})) {
        toolCallsByTool[tool] = (toolCallsByTool[tool] ?? 0) + count;
      }
      for (const [tool, cost] of Object.entries(s.toolCosts ?? {})) {
        toolCostByTool[tool] = (toolCostByTool[tool] ?? 0) + cost;
      }
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
  // Aggregate latency percentiles: summaries carry no per-message pool, so
  // each session contributes its mean latency weighted by its message count
  // (message-weighted session means — the per-message pooling happens in
  // subagentMetrics, where transcripts are read). Fields stay absent until
  // two sessions contribute.
  const subP50 = weightedPercentileMs(latencyPairs, 0.5);
  const subP95 = weightedPercentileMs(latencyPairs, 0.95);
  // Global spawn timeline: daily spawn counts from the raw transcripts'
  // subagent calls, clipped to the caller's day window (the same local-day
  // string clipping gateByDay applies). A spawn without a timestamp has no
  // day to book on and is skipped. Built only when raw extracts were given.
  const timeline = [];
  if (Array.isArray(opts.raw)) {
    const spawnDays = {};
    for (const extract of opts.raw) {
      for (const c of extract?.calls ?? []) {
        if (c?.name !== "subagent" || !c.ts) continue;
        const day = localDayKey(c.ts);
        if (!day) continue;
        if (opts.fromDay && day < opts.fromDay) continue;
        if (opts.toDay && day > opts.toDay) continue;
        spawnDays[day] = (spawnDays[day] ?? 0) + 1;
      }
    }
    for (const day of Object.keys(spawnDays).sort()) timeline.push({ day, spawns: spawnDays[day] });
  }
  const byAgent = [...agentsMap.values()]
    .map((t) => {
      const entry = {
        agent: t.agent,
        spawns: t.spawns,
        messages: t.messages,
        errors: t.errors,
        avgLatencyMs: t.latencyCount > 0 ? Math.round(t.latencySum / t.latencyCount) : 0,
      };
      // Message-weighted percentile fields and the spawn-weighted median
      // lag; each stays absent until two sessions contribute to its pool.
      const p50 = weightedPercentileMs(t.meanPairs, 0.5);
      const p95 = weightedPercentileMs(t.meanPairs, 0.95);
      const lag = weightedPercentileMs(t.lagPairs, 0.5);
      if (p50 != null) entry.p50LatencyMs = p50;
      if (p95 != null) entry.p95LatencyMs = p95;
      if (lag != null) entry.spawnToFirstMsgMs = lag;
      return entry;
    })
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
      ...(subP50 != null && { p50LatencyMs: subP50 }),
      ...(subP95 != null && { p95LatencyMs: subP95 }),
      ...(timeline.length > 0 && { timeline }),
      byAgent,
    },
    blocksByTool,
    gateTags,
    gateByDay,
    toolAvgCost: Object.fromEntries(
      Object.entries(toolAvgCost).map(([tool, avg]) => [tool, Number(avg.toFixed(8))]),
    ),
    globalAvgCost: Number(globalAvgCost.toFixed(8)),
    avoidedSpend: Number(avoidedSpend.toFixed(6)),
  };
}

/** Per-model rollup across raw extracts: turns and cost per model. Without a
 * window the lifetime per-model usage totals are exact and used as-is. Under
 * a date window the rollup is rebuilt from the turns stamped inside it — the
 * same turn-timestamp attribution the cost aggregates apply
 * (attributeSession): a turn without a timestamp rides the extract's last
 * turn timestamp and drops when that lies outside the window, so a windowed
 * snapshot no longer reports lifetime totals. Turns carrying no model name
 * cannot be attributed to a model and are skipped in the windowed path. */
export function aggregateModelMix(rawExtracts, fromMs = null, toMs = null) {
  const finish = (mix) =>
    [...mix.values()]
      .map((m) => ({ ...m, cost: Number(m.cost.toFixed(6)) }))
      .sort((a, b) => b.cost - a.cost);
  if (fromMs == null && toMs == null) {
    const mix = new Map();
    for (const extract of rawExtracts) {
      for (const [model, usage] of Object.entries(extract.usage ?? {})) {
        const m = mix.get(model) ?? { model, turns: 0, cost: 0 };
        m.turns += usage.turns ?? 0;
        m.cost += usage.costTotal ?? 0;
        mix.set(model, m);
      }
    }
    return finish(mix);
  }
  const inWindow = (ms) =>
    Number.isFinite(ms) && (fromMs == null || ms >= fromMs) && (toMs == null || ms < toMs);
  const mix = new Map();
  for (const extract of rawExtracts) {
    const turns = extract?.turns ?? [];
    let lastMs = Number.NaN;
    for (const t of turns) {
      const ms = Date.parse(t?.ts);
      if (Number.isFinite(ms) && (Number.isNaN(lastMs) || ms > lastMs)) lastMs = ms;
    }
    for (const t of turns) {
      if (!t?.model) continue;
      const ts = Date.parse(t?.ts);
      const ms = Number.isFinite(ts) ? ts : lastMs; // null-ts rides last activity
      if (!inWindow(ms)) continue;
      const m = mix.get(t.model) ?? { model: t.model, turns: 0, cost: 0 };
      m.turns += 1;
      m.cost += turnCost(t);
      mix.set(t.model, m);
    }
  }
  return finish(mix);
}

/** Daily/weekly spend rollup with a linear end-of-day projection. Days are
 * UTC. With raw extracts each turn's cost lands on the day it happened, so a
 * multi-day session no longer books its whole cost on its first day. */
export function spendSummary(sessions, now = new Date(), opts = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${dayKey(nowMs)}T00:00:00Z`);
  const dayMs = 86_400_000;
  const byDay = {};
  const extractById = new Map((opts.raw ?? []).map((e) => [e.sessionId, e]));
  for (const s of sessions) {
    const extract = extractById.get(s.sessionId);
    if (extract) {
      const attr = attributeSession(s, extract, opts.from ?? null, opts.to ?? null);
      for (const [key, c] of Object.entries(attr.byDay)) byDay[key] = (byDay[key] ?? 0) + c;
      continue;
    }
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
  const tagCounts = extra.gateTags ?? {};
  // Per-rule rollup: a tag naming one rule adds both outcomes; a shared tag
  // splits them (the blocked calls belong to the error-severity sibling, the
  // notes to the teaching rule), so no count lands on two rules at once.
  const perRule = new Map();
  const bump = (key, blocks, warns, tools, toolsBlock = {}) => {
    const cur = perRule.get(key) ?? { blocks: 0, warns: 0, tools: {}, toolsBlock: {} };
    cur.blocks += blocks;
    cur.warns += warns;
    for (const [tool, n] of Object.entries(tools ?? {})) cur.tools[tool] = (cur.tools[tool] ?? 0) + n;
    for (const [tool, n] of Object.entries(toolsBlock))
      cur.toolsBlock[tool] = (cur.toolsBlock[tool] ?? 0) + n;
    perRule.set(key, cur);
  };
  const unmappedTags = [];
  for (const [tag, c] of Object.entries(tagCounts)) {
    const keys = GATE_TAG_RULES[tag];
    if (!keys) {
      unmappedTags.push({ tag, blocks: c.block ?? 0, warns: c.warn ?? 0 });
      continue;
    }
    if (keys.length === 1) {
      bump(keys[0], c.block ?? 0, c.warn ?? 0, c.tools, c.toolsBlock);
      continue;
    }
    const strict = keys.find((k) => rules[k] === "error") ?? keys[0];
    const teaching = keys.find((k) => k !== strict);
    bump(strict, c.block ?? 0, 0, c.tools, c.toolsBlock);
    if (teaching) bump(teaching, 0, c.warn ?? 0, c.tools);
  }
  // Per-tool split of the same events: a tool can be blocked and warned, so
  // both bars are counted separately for the stacked chart.
  const perTool = new Map();
  for (const [tag, c] of Object.entries(tagCounts)) {
    if (!GATE_TAG_RULES[tag]) continue;
    const tools = new Set([
      ...Object.keys(c.toolsBlock ?? {}),
      ...Object.keys(c.toolsWarn ?? {}),
    ]);
    for (const tool of tools) {
      const cur = perTool.get(tool) ?? { tool, blocks: 0, warns: 0 };
      cur.blocks += c.toolsBlock?.[tool] ?? 0;
      cur.warns += c.toolsWarn?.[tool] ?? 0;
      perTool.set(tool, cur);
    }
  }
  const byTool = [...perTool.values()].sort(
    (a, b) => b.blocks + b.warns - (a.blocks + a.warns) || a.tool.localeCompare(b.tool),
  );
  // Per-rule trend across the window's days, using the same tag-to-rule split
  // as the totals above so the sparkline can never disagree with its row.
  // Capped to the most recent days to keep the payload bounded.
  const TREND_DAY_CAP = 45;
  const shownDays = Object.keys(extra.gateByDay ?? {}).sort().slice(-TREND_DAY_CAP);
  const trendByRule = new Map();
  const bumpDay = (key, i, blocks, warns) => {
    let arr = trendByRule.get(key);
    if (!arr) {
      arr = shownDays.map(() => [0, 0]);
      trendByRule.set(key, arr);
    }
    arr[i][0] += blocks;
    arr[i][1] += warns;
  };
  shownDays.forEach((day, i) => {
    for (const [tag, d] of Object.entries(extra.gateByDay?.[day] ?? {})) {
      const keys = GATE_TAG_RULES[tag];
      if (!keys) continue;
      if (keys.length === 1) {
        bumpDay(keys[0], i, d.block ?? 0, d.warn ?? 0);
        continue;
      }
      const strict = keys.find((k) => rules[k] === "error") ?? keys[0];
      const teaching = keys.find((k) => k !== strict);
      bumpDay(strict, i, d.block ?? 0, 0);
      if (teaching) bumpDay(teaching, i, 0, d.warn ?? 0);
    }
  });
  const trendFor = (id) => trendByRule.get(id) ?? shownDays.map(() => [0, 0]);
  // Per-rule avoided-spend proxy, same formula as the headline number: each
  // blocked call is credited the average observed cost of one call of the
  // same tool; tools with no observed cost fall back to the global average.
  const toolAvgCost = extra.toolAvgCost ?? {};
  const globalAvgCost = extra.globalAvgCost ?? 0;
  const avoidedFor = (key) => {
    const c = perRule.get(key);
    if (!c) return 0;
    let sum = 0;
    for (const [tool, n] of Object.entries(c.toolsBlock ?? {}))
      sum += n * (toolAvgCost[tool] ?? globalAvgCost);
    return Number(sum.toFixed(6));
  };
  const ruleList = Object.entries(rules)
    .map(([id, severity]) => {
      const c = perRule.get(id) ?? { blocks: 0, warns: 0, tools: {} };
      const meta = GATE_RULE_META[id] ?? { code: id, group: "advisory", label: id };
      return {
        id,
        code: meta.code,
        label: meta.label,
        group: meta.group,
        severity,
        family: RULE_FAMILY.get(id) ?? null,
        blocks: c.blocks,
        warns: c.warns,
        topTool: Object.entries(c.tools).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        trend: trendFor(id),
        avoidedSpend: avoidedFor(id),
        tags: TAGS_BY_RULE[id] ?? [],
      };
    })
    .sort(
      (a, b) =>
        b.blocks + b.warns - (a.blocks + a.warns) ||
        (order[a.severity] ?? 9) - (order[b.severity] ?? 9) ||
        a.id.localeCompare(b.id),
    );
  const pseudoRows = Object.entries(GATE_PSEUDO_RULES)
    .map(([id, meta]) => {
      const c = perRule.get(id) ?? { blocks: 0, warns: 0, tools: {} };
      return {
        id,
        code: meta.code,
        label: meta.label,
        group: meta.group,
        severity: "—",
        family: null,
        blocks: c.blocks,
        warns: c.warns,
        topTool: Object.entries(c.tools).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        trend: trendFor(id),
        avoidedSpend: avoidedFor(id),
        tags: TAGS_BY_RULE[id] ?? [],
      };
    })
    .filter((r) => r.blocks + r.warns > 0);
  const allRules = [...ruleList, ...pseudoRows].sort(
    (a, b) =>
      b.blocks + b.warns - (a.blocks + a.warns) ||
      (order[a.severity] ?? 9) - (order[b.severity] ?? 9) ||
      a.id.localeCompare(b.id),
  );
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
    rules: allRules,
    days: shownDays,
    bySeverity,
    familySeverity,
    blocksByTool: extra.blocksByTool ?? {},
    byTool,
    avoidedSpend: extra.avoidedSpend ?? 0,
    unmappedTags: unmappedTags.sort((a, b) => b.blocks + b.warns - (a.blocks + a.warns)),
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
