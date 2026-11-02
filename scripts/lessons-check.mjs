#!/usr/bin/env node
// Append-time validator for the NDJSON lessons log (default ~/.pi/agent/lessons/harness.ndjson).
// Each line must be one JSON object with exactly the keys ts, source, lesson.
// Usage: bin/lessons-check [path]
//   Exit 0 = clean or warnings only; exit 1 = any failure.
//   Prints one line per finding: "FAIL <line> <code> <detail>" or "WARN <line> <code> <detail>",
//   then a summary line: "<n> lines, <f> fail, <w> warn".
// Importable as an ESM module: exports checkLine(obj, ctx) and checkFile(lines, now).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FAIL = "FAIL";
const WARN = "WARN";
const WANT_KEYS = ["lesson", "source", "ts"]; // sorted
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
// Absolute user home path: /Users/<name>/ or /home/<name>/. Neutral shapes
// (~/.pi/agent, <project-root>, relative paths, /tmp) never match.
const IDENTITY_RE = /\/(?:Users|home)\/[^/\s"'`<>,;:)\]}]+\//;
const DUP_THRESHOLD = 0.6;
const STOPWORDS = new Set(
  ("a an the and or but if then else when while of to in on at by for with from as is are was were be been being " +
    "it its this that these those not no nor so too very can will just should would could do does did has have had " +
    "i you he she we they them their his her my your our us me him who whom which what where why how all any both " +
    "each few more most other some such only own same than there here again once into over under out up down off " +
    "about against between")
    .split(" "),
);

function tokenize(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function validTs(ts) {
  return typeof ts === "string" && TS_RE.test(ts) && Number.isFinite(Date.parse(ts));
}

/** Check one parsed entry: returns [{code, detail}] for FAIL-level issues (BAD_KEYS, BAD_TS, IDENTITY). */
export function checkLine(obj, ctx = {}) {
  const findings = [];
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const keys = Object.keys(obj).sort();
  if (keys.join(",") !== WANT_KEYS.join(",")) {
    findings.push({
      code: "BAD_KEYS",
      detail: `keys are [${keys.join(", ") || "none"}], want exactly [ts, source, lesson]`,
    });
  }
  if (!validTs(obj.ts)) {
    findings.push({ code: "BAD_TS", detail: `ts ${JSON.stringify(obj.ts ?? null)} is not ISO-8601 with Z` });
  } else if (Date.parse(obj.ts) > now.getTime()) {
    findings.push({ code: "BAD_TS", detail: `ts ${obj.ts} is later than current UTC ${now.toISOString()}` });
  }
  const haystack = Object.values(obj).filter((v) => typeof v === "string").join(" ");
  const identity = haystack.match(IDENTITY_RE);
  if (identity) {
    findings.push({ code: "IDENTITY", detail: `absolute user path "${identity[0]}" leaks an identity` });
  }
  return findings;
}

/** Check a whole file: lines = raw line strings (no trailing newlines). Returns
 *  { findings: [{line, level, code, detail}], lines, fail, warn, summary }. */
export function checkFile(lines, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const rows = [];
  for (const raw of lines) {
    const text = String(raw).trim();
    if (text !== "") rows.push(text);
  }
  const parsed = rows.map((text, i) => {
    let obj = null;
    let err = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      err = e;
    }
    return {
      no: i + 1,
      ok: obj !== null && typeof obj === "object" && !Array.isArray(obj),
      obj,
      err,
      tokens: null,
    };
  });
  for (const p of parsed) if (p.ok) p.tokens = tokenize(p.obj.lesson);

  const findings = [];
  for (let j = 0; j < parsed.length; j++) {
    for (let i = 0; i < j; i++) {
      const sim = jaccard(parsed[i].tokens, parsed[j].tokens);
      if (sim > DUP_THRESHOLD) {
        findings.push({
          line: parsed[j].no,
          level: WARN,
          code: "DUP",
          detail: `near-duplicate of line ${parsed[i].no} (jaccard ${sim.toFixed(2)})`,
        });
      }
    }
  }

  let prevTs = null; // last ts that passed BAD_TS (trustworthy for order checks)
  for (const p of parsed) {
    if (!p.ok) {
      findings.push({
        line: p.no,
        level: FAIL,
        code: "BAD_JSON",
        detail: p.err ? `invalid JSON: ${p.err.message}` : `not a JSON object`,
      });
      continue;
    }
    for (const f of checkLine(p.obj, { now: at })) {
      findings.push({ line: p.no, level: FAIL, ...f });
    }
    if (validTs(p.obj.ts) && Date.parse(p.obj.ts) <= at.getTime()) {
      const ts = p.obj.ts;
      if (prevTs !== null && ts < prevTs) {
        findings.push({
          line: p.no,
          level: WARN,
          code: "ORDER",
          detail: `ts ${ts} earlier than previous line's ${prevTs}`,
        });
      }
      const year = ts.slice(0, 4);
      const prevYear = prevTs === null ? null : prevTs.slice(0, 4);
      if (prevYear !== null && year !== prevYear) {
        findings.push({
          line: p.no,
          level: WARN,
          code: "YEAR_MIX",
          detail: `year ${year} differs from previous line's ${prevYear}`,
        });
      }
      prevTs = ts;
    }
  }

  findings.sort((a, b) => a.line - b.line || (a.level === FAIL ? -1 : 1) - (b.level === FAIL ? -1 : 1));
  const fail = findings.filter((f) => f.level === FAIL).length;
  const warn = findings.length - fail;
  return {
    findings,
    lines: parsed.length,
    fail,
    warn,
    summary: `${parsed.length} lines, ${fail} fail, ${warn} warn`,
  };
}

function main() {
  const target = process.argv[2] ?? join(homedir(), ".pi", "agent", "lessons", "harness.ndjson");
  let text;
  try {
    text = readFileSync(target, "utf8");
  } catch (err) {
    process.stderr.write(`lessons-check: cannot read ${target}: ${err.message}\n`);
    process.exit(1);
  }
  const res = checkFile(text.split(/\r?\n/), new Date());
  for (const f of res.findings) {
    process.stdout.write(`${f.level} ${f.line} ${f.code} ${f.detail}\n`);
  }
  process.stdout.write(`${res.summary}\n`);
  process.exit(res.fail > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
