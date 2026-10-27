#!/usr/bin/env node
/**
 * Session block + compaction-contract audit (reusable, 2026-10-28).
 *
 * Parses a pi session JSONL directly (works on the in-flight session pidx
 * skips) and reports:
 *   1. chaining — calls by tool, batch-size histogram, parallel share
 *   2. block ledger — every isError tool result with its gate family
 *   3. recovery — whether each block was remedied by a follow-up call on
 *      the same target within 3 calls (the documented one-shot remedy)
 *   4. compaction contract — for every piread result carrying
 *      details.compaction: re-derive coverage with the gate's own walk and
 *      flag gaps-vs-structured disagreement, tiling holes, and marker-count
 *      mismatches (the 2026-10-27 drift class, now caught on real sessions)
 *
 * Usage:
 *   node tests/tools/audit/session-blocks.mjs [--session <file>] [--json]
 *   npm run audit:session            (newest session under ~/.pi/agent/sessions)
 *
 * Exit code: 0 always — this is an audit report, not a test verdict.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { renderedCoverageFromBlocks } from "../../../extensions/permission-gate/rules/read-coverage.ts";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const sessArg = argv[argv.indexOf("--session") + 1];

function newestSession() {
  const root = join(homedir(), ".pi/agent/sessions");
  let best = null;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  walk(root);
  return best?.p;
}

const sessionFile = sessArg ?? newestSession();
if (!sessionFile) {
  console.error("no session file found");
  process.exit(1);
}

/** @returns {{calls: Map<string, {name, arg, ts}>, results: any[], messages: number[]}} */
function parseSession(file) {
  const calls = new Map();
  const results = [];
  const batchSizes = [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg) continue;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const n = msg.content.filter((b) => b.type === "toolCall").length;
      if (n > 0) batchSizes.push(n);
      for (const b of msg.content) {
        if (b.type === "toolCall") {
          calls.set(b.id, {
            name: b.name,
            arg: String(b.arguments?.path ?? b.arguments?.command ?? ""),
            offset: b.arguments?.offset,
            limit: b.arguments?.limit,
          });
        }
      }
    } else if (msg.role === "toolResult") {
      results.push({
        id: msg.toolCallId,
        tool: msg.toolName,
        isError: msg.isError === true,
        text: (msg.content ?? []).map((b) => b.text ?? "").join("\n"),
        details: msg.details ?? null,
      });
    }
  }
  return { calls, results, batchSizes };
}

const FAMILIES = [
  ["anchor", /Anchor Guard/],
  ["locate", /Locate-first/],
  ["re-read", /Re-read/],
  ["re-run", /Re-run/],
  ["loop", /Loop Guard/],
  ["destructive", /destructive|confirm/i],
  ["other", /.*/],
];
const familyOf = (text) => FAMILIES.find(([, re]) => re.test(text))[0];

const keyOf = (name, arg) => `${name}:${arg.slice(0, 60)}`;

function audit() {
  const { calls, results, batchSizes } = parseSession(sessionFile);
  const byTool = {};
  for (const c of calls.values()) byTool[c.name] = (byTool[c.name] ?? 0) + 1;

  const blocks = [];
  for (const r of results.filter((x) => x.isError)) {
    const c = calls.get(r.id);
    const family = familyOf(r.text.split("\n")[0] ?? "");
    blocks.push({ tool: r.tool, target: c?.arg ?? "?", family, head: r.text.split("\n")[0]?.slice(0, 110) });
  }

  // recovery: a later successful call with the same tool+target
  const seq = results.map((r) => ({ ...r, key: keyOf(r.tool, calls.get(r.id)?.arg ?? "") }));
  const blocksWithRecovery = blocks.map((b, i) => {
    const key = keyOf(b.tool, b.target);
    const idx = seq.findIndex((s, j) => s.isError && s.key === key && j >= i);
    const after = seq.slice(idx + 1, idx + 4);
    return { ...b, recovered: after.some((s) => s.key === key && !s.isError) };
  });

  // compaction contract: every piread result with structured omissions
  const compactionFindings = [];
  for (const r of results) {
    if (r.tool !== "piread") continue;
    const comp = r.details?.compaction;
    if (!comp?.omissions?.length) continue;
    const c = calls.get(r.id);
    const winStart = c?.offset ?? 1;
    const winEnd = c?.limit != null ? winStart + c.limit - 1 : undefined;
    let got;
    try {
      got = renderedCoverageFromBlocks([{ type: "text", text: r.text }], winStart, comp.omissions, winEnd);
    } catch (e) {
      compactionFindings.push({ target: c?.arg ?? "?", issue: `walk threw: ${e.message}` });
      continue;
    }
    const markers = (r.text.match(/^\[\.\.\. omitted \d+ chars \/ \d+ lines \.\.\.]$/gm) ?? []).length;
    if (markers !== comp.omissions.length) {
      compactionFindings.push({ target: c?.arg, issue: `marker count ${markers} != omissions ${comp.omissions.length}` });
      continue;
    }
    if (!got) {
      compactionFindings.push({ target: c?.arg, issue: "markers present but walk produced no coverage" });
      continue;
    }
    const same = JSON.stringify(got.gaps) ===
      JSON.stringify(comp.omissions.map((o) => ({ start: o.startLine, end: o.endLine })));
    if (!same) {
      compactionFindings.push({
        target: c?.arg,
        issue: `gaps ${JSON.stringify(got.gaps)} != structured ${JSON.stringify(comp.omissions.map((o) => [o.startLine, o.endLine]))}`,
      });
    }
    if (winEnd !== undefined) {
      const all = [...got.spans, ...got.gaps].sort((a, b) => a.start - b.start);
      let cursor = winStart;
      for (const s of all) {
        if (s.start !== cursor) {
          compactionFindings.push({ target: c?.arg, issue: `tiling ${cursor} -> ${s.start}` });
          break;
        }
        cursor = s.end + 1;
      }
    }
  }

  const hist = {};
  for (const n of batchSizes) hist[n] = (hist[n] ?? 0) + 1;
  return {
    session: sessionFile,
    calls: { total: calls.size, byTool, batchHistogram: hist,
      parallelShare: batchSizes.length ? Math.round((batchSizes.filter((n) => n > 1).length / batchSizes.length) * 1000) / 10 : 0 },
    blocks: { total: blocks.length,
      byFamily: blocks.reduce((a, b) => ((a[b.family] = (a[b.family] ?? 0) + 1), a), {}),
      unrecovered: blocksWithRecovery.filter((b) => !b.recovered).length,
      ledger: blocksWithRecovery },
    compaction: { checked: results.filter((r) => r.tool === "piread" && r.details?.compaction?.omissions?.length).length,
      findings: compactionFindings },
  };
}

const report = audit();
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`session: ${report.session}`);
  console.log(`calls: ${report.calls.total} byTool=${JSON.stringify(report.calls.byTool)} batch=${JSON.stringify(report.calls.batchHistogram)} parallel=${report.calls.parallelShare}%`);
  console.log(`blocks: ${report.blocks.total} byFamily=${JSON.stringify(report.blocks.byFamily)} unrecovered=${report.blocks.unrecovered}`);
  for (const b of report.blocks.ledger) {
    console.log(`  [${b.family}]${b.recovered ? "" : "[UNRECOVERED]"} ${b.tool} ${(b.target ?? "").slice(0, 60)} :: ${b.head?.slice(0, 90)}`);
  }
  console.log(`compaction: ${report.compaction.checked} results checked, ${report.compaction.findings.length} findings`);
  for (const f of report.compaction.findings) console.log(`  [${f.issue.slice(0, 90)}] ${f.target}`);
}
