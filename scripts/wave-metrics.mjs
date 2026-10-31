#!/usr/bin/env node
/**
 * Wave-metrics extractor (plan research/subagent-improvement-plan.md §11):
 * joins `<repo>/.pi/subagent-results.jsonl` (completion records: id, ts,
 * name, agent?, parentSessionId?, exitCode, elapsed[sec], stats?) with
 * `<repo>/.pi/subagent-history.jsonl` (durable per-child enrichment: id, ts,
 * name, files_changed?, files_read?, diff?, summary?) by id — history is the
 * durable side, so ids present only there still emit, and a compacted-to-
 * empty results file is tolerated. Output is NDJSON: one child line each
 * (children sorted by ts), then one summary line per wave.
 *
 * Tokens come from the real stats shape (extensions/subagents/session.ts
 * SessionStats — flat inputTokens/outputTokens/.../cost; production data has
 * no stats.tokens), with stats.tokens as a compat fallback; unknown values
 * are null, never fabricated zeros. Waves: children sharing a parentSessionId
 * form one wave; children without one cluster by ts gaps — a gap strictly
 * greater than 30 minutes starts a new wave. Missing/empty inputs or corrupt
 * lines are never fatal: exit 0, emit nothing.
 *
 * Usage: node scripts/wave-metrics.mjs [--repo <dir>] [--out <file>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WAVE_GAP_MS = 30 * 60 * 1000;

/** Parse an NDJSON file into last-valid-record-per-id. Corrupt, partial and
 * blank lines are skipped — a crash mid-write must not blind the whole read. */
function readNdjsonById(path, key = "id") {
  const byId = new Map();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return byId; // Missing or unreadable: treated as empty.
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && typeof rec[key] === "string") byId.set(rec[key], rec);
    } catch {
      // Skip malformed line.
    }
  }
  return byId;
}

/** Tokens per child: real shape first (cumulative input+output usage), then a
 * flat stats.tokens compat fallback, else null (unknown, not zero). */
function tokensOf(stats) {
  if (!stats || typeof stats !== "object") return null;
  const input = Number(stats.inputTokens);
  const output = Number(stats.outputTokens);
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  }
  const flat = Number(stats.tokens);
  return Number.isFinite(flat) ? flat : null;
}

const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

/** Merge one results record and/or one history record into a child line.
 * Results is the richer completion record (agent, elapsed, stats); history
 * is the durable enrichment (files_read; files_changed preferred there). */
function buildChild(result, history) {
  const res = result ?? {};
  const hist = history ?? {};
  const ts = Number(res.ts ?? hist.ts);
  const elapsed = Number(res.elapsed);
  const stats = res.stats;
  const cost = stats && typeof stats === "object" ? finiteOrNull(Number(stats.cost)) : null;
  const changed = hist.files_changed ?? res.files_changed;
  const read = hist.files_read;
  return {
    id: (result ?? history).id,
    name: res.name ?? hist.name ?? null,
    agent: res.agent ?? null,
    ts: finiteOrNull(ts),
    parentSessionId: res.parentSessionId ?? null,
    elapsedSec: finiteOrNull(elapsed),
    costUsd: cost,
    tokens: tokensOf(stats),
    filesChangedCount: Array.isArray(changed) ? changed.length : null,
    filesReadCount: Array.isArray(read) ? read.length : null,
  };
}

/** Assign waves: parentSessionId groups (when present), then ts-gap
 * clustering (> WAVE_GAP_MS splits) for the rest. Returns waves ordered by
 * each wave's earliest child ts, numbered 1..n. Children are not mutated. */
function assignWaves(children) {
  const groups = new Map(); // parentSessionId -> children
  const orphans = [];
  for (const c of children) {
    if (c.parentSessionId) {
      if (!groups.has(c.parentSessionId)) groups.set(c.parentSessionId, []);
      groups.get(c.parentSessionId).push(c);
    } else orphans.push(c);
  }
  orphans.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
  // Cluster orphans: consecutive ts gaps beyond the threshold split waves.
  const clusters = [];
  for (const c of orphans) {
    const prev = clusters[clusters.length - 1];
    const gap = prev ? c.ts - prev[prev.length - 1].ts : Infinity;
    if (prev && Number.isFinite(gap) && gap <= WAVE_GAP_MS) prev.push(c);
    else clusters.push([c]);
  }
  return [...groups.values(), ...clusters]
    .sort((a, b) => waveStart(a) - waveStart(b))
    .map((members, i) => ({ waveNo: i + 1, members }));
}

const waveStart = (w) => Math.min(...w.map((c) => (Number.isFinite(c.ts) ? c.ts : Infinity)));

/** One summary line per wave. Totals sum known values only; a wave where no
 * child contributed a value stays null (unknown, not zero). duplicateReads:
 * paths appearing in files_read of 2+ distinct children of the wave. */
function summarize(waveNo, children, historyById) {
  const tss = children.map((c) => c.ts).filter((t) => Number.isFinite(t));
  const costVals = children.map((c) => c.costUsd).filter((v) => Number.isFinite(v));
  const tokVals = children.map((c) => c.tokens).filter((v) => Number.isFinite(v));
  const readOwners = new Map(); // path -> distinct child ids
  for (const c of children) {
    const rec = historyById.get(c.id);
    const reads = rec?.files_read;
    if (!Array.isArray(reads)) continue;
    for (const p of reads) {
      if (typeof p !== "string") continue;
      if (!readOwners.has(p)) readOwners.set(p, new Set());
      readOwners.get(p).add(c.id);
    }
  }
  return {
    wave: waveNo,
    children: children.length,
    totalCostUsd: costVals.length ? costVals.reduce((a, b) => a + b, 0) : null,
    totalTokens: tokVals.length ? tokVals.reduce((a, b) => a + b, 0) : null,
    wallClockSec: tss.length ? (Math.max(...tss) - Math.min(...tss)) / 1000 : null,
    duplicateReads: [...readOwners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([p]) => p)
      .sort(),
  };
}

function usage() {
  return [
    "wave-metrics — per-child and per-wave subagent metrics (NDJSON)",
    "",
    "Usage: node scripts/wave-metrics.mjs [--repo <dir>] [--out <file>]",
    "  --repo <dir>   repo root containing .pi/ (default: cwd)",
    "  --out <file>   write NDJSON here instead of stdout",
    "  --help         show this help",
    "",
    "Reads .pi/subagent-results.jsonl and .pi/subagent-history.jsonl (both",
    "optional; malformed lines skipped). Emits one line per child then one",
    "summary line per wave. Exit 0 even when inputs are missing.",
  ].join("\n");
}

// ── CLI ──
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage() + "\n");
  process.exit(0);
}
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
};
const repo = resolve(argValue("--repo") ?? process.cwd());
const outPath = argValue("--out");

const results = readNdjsonById(join(repo, ".pi", "subagent-results.jsonl"));
const history = readNdjsonById(join(repo, ".pi", "subagent-history.jsonl"));

// History is durable: every id from either side becomes a child.
const ids = new Set([...results.keys(), ...history.keys()]);
const children = [...ids]
  .map((id) => buildChild(results.get(id), history.get(id)))
  .sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || String(a.id).localeCompare(String(b.id)));

summarize.historyById = history;
const waves = assignWaves(children);
const outLines = [
  ...children.map((c) => JSON.stringify(c)),
  ...waves.map((w) => JSON.stringify(summarize(w.waveNo, w.members, history))),
];
const payload = outLines.length ? outLines.join("\n") + "\n" : "";

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), payload, "utf8");
} else {
  process.stdout.write(payload);
}
process.exit(0);
