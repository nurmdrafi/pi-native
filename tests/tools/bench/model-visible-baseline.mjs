#!/usr/bin/env node
/**
 * Model-visible token baseline + regression guard (measurement only).
 *
 * Measures what actually enters the model context: the `content[].text` of a
 * successful tool.execute() result. `details`/`structuredContent` are
 * TUI-only and are NOT counted (working rule 4). Rejections count their error
 * text.
 *
 * Modes:
 *   (default)        print the table, no writes
 *   --update         regenerate tests/fixtures/bench/model-visible-baseline.json
 *   --compare        diff against that JSON; exit 1 if any case's
 *                    model-visible bytes GREW (shrinkage is allowed)
 *   --json <path>    write the raw measurements to <path>
 *
 * Retention assertions (pibash): each bash fixture lists lines that MUST
 * survive compression; PASS/FAIL is reported next to the byte reduction.
 *
 * Read-only: fixtures go to a temp dir; the only repo write is --update.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASELINE = join(ROOT, "tests", "fixtures", "bench", "model-visible-baseline.json");

const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createReadTool, createBashTool, createEditTool } = await import(
  join(pkgLink, "dist", "index.js"),
);

const native = (name) => import(`../../../extensions/${name}/index.ts`);
const pireadExt = (await native("piread")).default;
const pibashExt = (await native("pibash")).default;
const pieditExt = (await native("piedit")).default;

function makePi() {
  const tools = new Map();
  return { tools, registerTool: (d) => tools.set(d.name, d), on: () => () => {} };
}

/** Stubbed ExtensionAPI capturing the extension's tool. Registration is
 * unconditional, so the arms differ only by which tool object is called. */
function loadExtension(ext) {
  const pi = makePi();
  ext(pi);
  return pi.tools.values().next().value;
}

const piread = loadExtension(pireadExt);
const pibash = loadExtension(pibashExt);
const piedit = loadExtension(pieditExt);

const builtinRead = createReadTool(process.cwd());
const builtinBash = createBashTool(process.cwd());
const builtinEdit = createEditTool(process.cwd());

// ---- token estimate ----
// No tokenizer dependency (rule 5). chars/4 is the standard proxy for
// English+code; a word count is reported as a second, cross-checking estimate.
// Deltas are the signal, and both proxies are monotone in bytes.
const estTokens = (s) => Math.ceil(s.length / 4);
const countWords = (s) => (s.match(/\S+/g) ?? []).length;

/** Extract the model-visible text of a tool result (content[].text). */
function visibleText(result) {
  const parts = result?.content ?? [];
  return parts.map((p) => (p?.type === "text" ? p.text : `[${p?.type}]`)).join("");
}

let seq = 0;
async function run(tool, params, ctx) {
  try {
    const value = await tool.execute(`t${++seq}`, params, undefined, undefined, ctx);
    return { rejected: false, text: visibleText(value) };
  } catch (e) {
    return { rejected: true, text: `ERROR: ${String(e?.message ?? e)}` };
  }
}

// ---- fixture corpus ----
const dir = mkdtempSync(join(tmpdir(), "mv-baseline-"));
const F = (n) => join(dir, n);
const mkFile = (name, body) => {
  const p = F(name);
  writeFileSync(p, body);
  return p;
};

// small synthetic file
mkFile("small.txt", "alpha\nbeta\ngamma\ndelta\n");
mkFile("mid200.txt", Array.from({ length: 200 }, (_, i) => `line ${i}: the quick brown fox ${i}`).join("\n") + "\n");

// a source-like file with a genuinely unique anchor, for failure-case edits
const editBody = Array.from({ length: 400 }, (_, i) => `line ${i}: value ${i}`).join("\n") + "\n";
const mkEditFixtures = () => ({
  mine: mkFile("edit.mine.ts", editBody),
  oracle: mkFile("edit.oracle.ts", editBody),
});
// non-unique body: "dup" appears 3x; overlap body needs two adjacent anchors
const DUP_BODY = "header\n" + Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") + "\ndup\ndup\ndup\nfooter\n";
const mkDupFixtures = () => ({
  mine: mkFile("dup.mine.ts", DUP_BODY),
  oracle: mkFile("dup.oracle.ts", DUP_BODY),
});

// Read corpus at increasing sizes. Deterministic REGARDLESS of live repo
// edits: each file is a fixed, seeded sample of N lines drawn from a real
// source snapshot committed alongside this harness (tests/fixtures/bench/
// read-corpus.txt), repeated/truncated to the exact line count. Slicing live
// sources would make the baseline drift whenever those sources change.
const CORPUS_SRC = join(ROOT, "tests", "fixtures", "bench", "read-corpus.txt");
const corpusLines = readFileSync(CORPUS_SRC, "utf8").split("\n");
const corpusFile = (targetLines) => {
  const body = Array.from({ length: targetLines }, (_, i) => corpusLines[i % corpusLines.length]).join("\n") + "\n";
  return mkFile(`read-${targetLines}.txt`, body);
};
const repo100 = corpusFile(100);
const repo300 = corpusFile(300);
const repo1000 = corpusFile(1000);
const repo1922 = corpusFile(1922);

// The built-in bash tool reads ctx.sessionManager for PI_SESSION_ID; the native
// tools tolerate its absence. Supply a minimal stub so both arms run.
const ctx = {
  cwd: dir,
  sessionManager: { getSessionId: () => "mv-baseline", getSessionFile: () => undefined },
  model: undefined,
  thinkingLevel: undefined,
};

// ---- corpus definitions ----
const readCases = [
  ["read small (4ln)", { path: F("small.txt") }],
  ["read mid200 (full)", { path: F("mid200.txt") }],
  ["read mid200 (offset/limit)", { path: F("mid200.txt"), offset: 50, limit: 20 }],
  ["read missing", { path: F("nope.txt") }],
  ["read ~100ln", { path: repo100 }],
  ["read ~300ln", { path: repo300 }],
  ["read ~1000ln", { path: repo1000 }],
  ["read ~1922ln", { path: repo1922 }],
  ["read ~1000ln (repeat)", { path: repo1000 }], // sizes dedupe potential
];

const bashCases = [
  // [name, params, mustSurvive, expectRetention]
  // `expectRetention=false` records a case that the CURRENT pipeline is not
  // designed to retain (generic-command head/tail), matching the built-in
  // oracle; it is informational, not a pass/fail gate.
  ["bash tiny printf", { command: "printf 'ok'" }, [], true],
  ["bash 64 lines", { command: "seq 1 64" }, [], true],
  ["bash 1300 lines", { command: "seq 1 1300" }, [], true],
  ["bash 10k lines", { command: "seq 1 10000" }, [], true],
  [
    "bash failing test-like",
    { command: "sh -c 'for i in $(seq 1 8000); do echo \"   Compiling dep$i\"; done; echo \"error: boom\"; echo \"test result: FAILED\"; exit 1'" },
    ["error: boom", "test result: FAILED"],
    true,
  ],
  ["bash interleaved warnings", { command: "sh -c 'for i in $(seq 1 200); do echo \"warn$i\"; echo \"ok$i\"; done'" }, [], true],
  [
    "bash test names + summary",
    {
      command:
        "sh -c 'for i in $(seq 1 500); do echo \"  ok $i - case $i\"; done; echo \"  FAIL 1 - must survive\"; echo \"test result: FAILED. 500 passed; 1 failed\"'",
    },
    ["FAIL 1 - must survive", "test result: FAILED. 500 passed; 1 failed"],
    true,
  ],
  [
    // Classifies as Build (npm run build), so error_priority runs and a buried
    // failure must survive even mid-stream.
    "bash buried error (build-kind)",
    {
      command:
        "npm run build --silent ; sh -c 'echo start; for i in $(seq 1 4000); do echo \"chunk $i\"; done; echo \"error[E0308]: mismatched types at src/main.rs:42:5\"; for i in $(seq 1 4000); do echo \"tail $i\"; done'",
    },
    ["error[E0308]: mismatched types at src/main.rs:42:5"],
    true,
  ],
  [
    // Generic command: buried actionables are NOT scanned by head_tail, so this
    // is recorded as expected-non-retaining (the built-in loses it too).
    "bash buried first error (generic)",
    { command: "sh -c 'echo head; for i in $(seq 1 4000); do echo \"noise $i\"; done; echo \"ERROR: first real failure at src/main.rs:10:5\"; for i in $(seq 1 4000); do echo \"noise2 $i\"; done'" },
    ["ERROR: first real failure at src/main.rs:10:5"],
    false,
  ],
];

// ---- runners ----
function row(name, tool, mine, oracle, extra = {}) {
  return {
    name,
    tool,
    native: { bytes: mine.text.length, tokens: estTokens(mine.text), words: countWords(mine.text), rejected: mine.rejected },
    builtin: { bytes: oracle.text.length, tokens: estTokens(oracle.text), words: countWords(oracle.text), rejected: oracle.rejected },
    ...extra,
  };
}

async function measureRead() {
  const rows = [];
  for (const [name, params] of readCases) {
    const mine = await run(piread, params, ctx);
    const oracle = await run(builtinRead, params, ctx);
    rows.push(row(name, "piread", mine, oracle));
  }
  return rows;
}

async function measureBash() {
  const rows = [];
  for (const [name, params, mustSurvive, expectRetention] of bashCases) {
    const mine = await run(pibash, params, ctx);
    const oracle = await run(builtinBash, params, ctx);
    const missing = mustSurvive.filter((line) => !mine.text.includes(line));
    const oracleMissing = mustSurvive.filter((line) => !oracle.text.includes(line));
    const pass = expectRetention ? missing.length === 0 : missing.length > 0;
    rows.push(
      row(name, "pibash", mine, oracle, {
        retention: { mustSurvive, missing, oracleMissing, expectRetention, pass },
      }),
    );
  }
  return rows;
}

async function measureEdit() {
  const rows = [];
  const editCases = [
    ["edit single line", (p) => ({ path: p, edits: [{ oldText: "value 200", newText: "VALUE 200" }] })],
    ["edit multi line", (p) => ({ path: p, edits: [{ oldText: "value 10: value", newText: "X" }] })],
  ];
  for (const [name, mk] of editCases) {
    const { mine: minePath, oracle: oraclePath } = mkEditFixtures();
    const norm = (r) => ({ ...r, text: r.text.replaceAll("edit.mine.ts", "<F>").replaceAll("edit.oracle.ts", "<F>") });
    const a = norm(await run(piedit, mk(minePath), ctx));
    const b = norm(await run(builtinEdit, mk(oraclePath), ctx));
    rows.push(row(name, "piedit", a, b));
  }
  // failure cases: not found, non-unique, overlap
  const failCases = [
    ["edit failure: not found", (p) => ({ path: p, edits: [{ oldText: "value 99999: absent", newText: "X" }] })],
    ["edit failure: non-unique", (p) => ({ path: p, edits: [{ oldText: "dup", newText: "DUP" }] })],
    [
      "edit failure: overlap",
      (p) => ({
        path: p,
        edits: [
          { oldText: "value 10: value 11", newText: "A" },
          { oldText: "value 11: value 12", newText: "B" },
        ],
      }),
    ],
  ];
  for (const [name, mk] of failCases) {
    const dup = name.includes("non-unique");
    const { mine: minePath, oracle: oraclePath } = dup ? mkDupFixtures() : mkEditFixtures();
    const norm = (r) => ({ ...r, text: r.text.replaceAll("dup.mine.ts", "<F>").replaceAll("dup.oracle.ts", "<F>").replaceAll("edit.mine.ts", "<F>").replaceAll("edit.oracle.ts", "<F>") });
    const a = norm(await run(piedit, mk(minePath), ctx));
    const b = norm(await run(builtinEdit, mk(oraclePath), ctx));
    rows.push(row(name, "piedit", a, b));
  }
  return rows;
}

const rows = [...(await measureRead()), ...(await measureBash()), ...(await measureEdit())];

const totals = rows.reduce(
  (t, r) => {
    t.native.bytes += r.native.bytes;
    t.native.tokens += r.native.tokens;
    t.native.words += r.native.words;
    t.builtin.bytes += r.builtin.bytes;
    t.builtin.tokens += r.builtin.tokens;
    t.builtin.words += r.builtin.words;
    return t;
  },
  { native: { bytes: 0, tokens: 0, words: 0 }, builtin: { bytes: 0, tokens: 0, words: 0 } },
);

const result = { generatedAt: new Date().toISOString(), rows, totals };

const has = (flag) => process.argv.includes(flag);
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// ---- --update: regenerate the committed baseline ----
if (has("--update")) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(result, null, 2) + "\n");
  console.log(`baseline updated: ${BASELINE}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// ---- --compare: regression guard ----
if (has("--compare")) {
  if (!existsSync(BASELINE)) {
    console.error(`no baseline at ${BASELINE}; run with --update first`);
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const byName = new Map(base.rows.map((r) => [`${r.tool}\0${r.name}`, r]));
  const regressions = [];
  const shrunk = [];
  const added = [];
  for (const r of rows) {
    const key = `${r.tool}\0${r.name}`;
    const b = byName.get(key);
    if (!b) {
      added.push(r);
      continue;
    }
    if (r.native.bytes > b.native.bytes) regressions.push({ r, b });
    else if (r.native.bytes < b.native.bytes) shrunk.push({ r, b });
  }
  console.log(`\n=== model-visible --compare vs ${BASELINE} ===`);
  for (const { r, b } of shrunk) {
    console.log(`SHRUNK  ${r.name.padEnd(30)} ${b.native.bytes} -> ${r.native.bytes} B (${r.native.bytes - b.native.bytes})`);
  }
  for (const r of added) console.log(`ADDED   ${r.name.padEnd(30)} ${r.native.bytes} B`);
  for (const { r, b } of regressions) {
    console.log(`GREW    ${r.name.padEnd(30)} ${b.native.bytes} -> ${r.native.bytes} B (+${r.native.bytes - b.native.bytes})`);
  }
  if (added.length) {
    console.log(`\nFAIL: ${added.length} new case(s) not in baseline; run --update to record them.`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  if (regressions.length) {
    console.log(`\nFAIL: ${regressions.length} case(s) GREW model-visible bytes.`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`\nOK: no case grew (${shrunk.length} shrunk).`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// ---- default: print the table ----
console.log("\n=== model-visible baseline (content[].text only) ===");
console.log(
  "case".padEnd(30) +
    "native B".padStart(10) +
    "native tok".padStart(11) +
    "builtin B".padStart(11) +
    "builtin tok".padStart(12) +
    "  Δ%" +
    "  retain",
);
for (const r of rows) {
  const delta = r.builtin.bytes ? (((r.native.bytes - r.builtin.bytes) / r.builtin.bytes) * 100).toFixed(1) : "n/a";
  const retain = r.retention
    ? r.retention.expectRetention
      ? (r.retention.pass ? "PASS" : `FAIL(${r.retention.missing.length})`)
      : (r.retention.pass ? "ok" : "info:not-retained")
    : "";
  console.log(
    r.name.padEnd(30) +
      String(r.native.bytes).padStart(10) +
      String(r.native.tokens).padStart(11) +
      String(r.builtin.bytes).padStart(11) +
      String(r.builtin.tokens).padStart(12) +
      "  " + delta.padStart(6) +
      "  " + retain,
  );
}
console.log(
  "TOTAL".padEnd(30) +
    String(totals.native.bytes).padStart(10) +
    String(totals.native.tokens).padStart(11) +
    String(totals.builtin.bytes).padStart(11) +
    String(totals.builtin.tokens).padStart(12) +
    "  " + (((totals.native.bytes - totals.builtin.bytes) / totals.builtin.bytes) * 100).toFixed(1).padStart(6),
);

const jsonOut = argOf("--json");
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  console.log(`\njson written: ${jsonOut}`);
}

rmSync(dir, { recursive: true, force: true });
