#!/usr/bin/env node
// Churn measurement: replay piread calls/results from session transcripts and
// ask (1) did a gapped result get followed by a read aimed inside the gap, and
// (2) would the 100-line / 8 KB budget have served that window whole.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".pi/agent/sessions");
const CUTOFF = Date.now() - 24 * 3600 * 1000;
const NEW_LINES = 100;
const NEW_BYTES = 8192;

const files = [];
for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    if (statSync(p).mtimeMs < CUTOFF) continue;
    files.push(p);
  }
}

const perSession = new Map(); // session file -> {calls: Map(id -> {path,offset,limit}), seq: []}
let calls = 0;
let results = 0;
let gapped = 0;
let wouldFit = 0;
let wouldFitChars = 0;
const fitCases = [];

for (const p of files) {
  const seq = [];
  const pending = new Map();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const m = rec.message;
    if (!m) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "toolCall" && c.name === "piread") {
          calls++;
          const a = c.arguments ?? {};
          pending.set(c.id, { path: a.path, offset: a.offset ?? 1, limit: a.limit });
          seq.push({ kind: "call", id: c.id, path: a.path, offset: a.offset ?? 1, limit: a.limit });
        }
      }
    } else if (m.role === "toolResult" && m.toolName === "piread") {
      results++;
      const comp = m.details?.compaction;
      const text = Array.isArray(m.content) ? m.content.map((b) => b.text ?? "").join("") : "";
      const rec2 = {
        kind: "result",
        id: m.toolCallId,
        chars: text.length,
        omissions: comp?.omissions ?? [],
        originalChars: comp?.originalChars ?? text.length,
        truncated: Boolean(m.details?.truncation?.truncated),
      };
      const call = pending.get(m.toolCallId);
      rec2.path = call?.path;
      rec2.offset = call?.offset;
      rec2.limit = call?.limit;
      seq.push(rec2);
    }
  }
  perSession.set(p, seq);
}

// (1) gap-aimed follow-ups
let gapAimed = 0;
const gapAimedPaths = new Map();
// (2) would the new budget have served it whole?
for (const [p, seq] of perSession) {
  const callsByPath = new Map();
  for (const e of seq) if (e.kind === "call") {
    const k = e.path;
    if (!callsByPath.has(k)) callsByPath.set(k, []);
    callsByPath.get(k).push(e);
  }
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e.kind !== "result" || e.omissions.length === 0) continue;
    gapped++;
    const winLines = e.limit ?? 100000;
    if (winLines <= NEW_LINES && e.originalChars <= NEW_BYTES && !e.truncated) {
      wouldFit++;
      wouldFitChars += e.originalChars - e.chars;
      fitCases.push({ path: e.path, omitted: e.omissions.length, originalChars: e.originalChars });
    }
    // next call for the same path after this result
    const later = (callsByPath.get(e.path) ?? []).find((c) => seq.indexOf(c) > i);
    if (!later) continue;
    const start = later.offset;
    const end = later.limit ? later.offset + later.limit - 1 : Infinity;
    const hit = e.omissions.some((o) => start <= o.endLine && end >= o.startLine);
    if (hit) {
      gapAimed++;
      gapAimedPaths.set(e.path, (gapAimedPaths.get(e.path) ?? 0) + 1);
    }
  }
}

const top = [...gapAimedPaths].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(
  JSON.stringify(
    {
      sessions: files.length,
      pireadCalls: calls,
      pireadResults: results,
      gapped,
      gapAimedFollowUps: gapAimed,
      newBudgetWouldServeWhole: wouldFit,
      charsAddedByGapFill: wouldFitChars,
      topGapAimedPaths: top,
    },
    null,
    2,
  ),
);
