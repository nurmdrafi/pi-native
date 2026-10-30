#!/usr/bin/env node
// Second pass: for gapped piread results that the 100-line / 8 KB budget does
// NOT already fix, how big is the omitted middle? A small middle is the
// marker-over-10-lines case that costs a whole re-read turn.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".pi/agent/sessions");
const CUTOFF = Date.now() - 24 * 3600 * 1000;
const NEW_LINES = 100;
const NEW_BYTES = 8192;

const buckets = { "<=20": 0, "21-60": 0, "61-200": 0, ">200": 0 };
let notFit = 0;
let notFitSmall = 0;

for (const d of readdirSync(ROOT)) {
  const dir = join(ROOT, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    if (statSync(p).mtimeMs < CUTOFF) continue;
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
          if (c?.type === "toolCall" && c.name === "piread") pending.set(c.id, c.arguments ?? {});
        }
      } else if (m.role === "toolResult" && m.toolName === "piread") {
        const comp = m.details?.compaction;
        if (!comp?.omissions?.length) continue;
        const a = pending.get(m.toolCallId) ?? {};
        const winLines = a.limit ?? 100000;
        const orig = comp.originalChars ?? 0;
        const truncated = Boolean(m.details?.truncation?.truncated);
        if (winLines <= NEW_LINES && orig <= NEW_BYTES && !truncated) continue; // already fixed
        notFit++;
        const mid = comp.omissions.reduce((s, o) => s + (o.lines ?? 0), 0);
        if (mid <= 20) buckets["<=20"]++;
        else if (mid <= 60) buckets["21-60"]++;
        else if (mid <= 200) buckets["61-200"]++;
        else buckets[">200"]++;
        if (mid <= 60) notFitSmall++;
      }
    }
  }
}

console.log(JSON.stringify({ notFit, notFitSmall, buckets }));
