#!/usr/bin/env node
/**
 * pidx throughput micro-bench — cold full index of a synthetic 32 MiB
 * session-log corpus, no model, local wall-clock only.
 *
 * Arms (same corpus, N=10 measured after 5 warmup; fresh cold state per
 * native run via a unique --state path):
 *   oracle-write — node-side same-output sweep: read + JSON.parse every line
 *                 of every file, build per-file summaries, JSON.stringify
 *                 them and write one JSONL line per file into the workdir
 *                 (parse + serialize + write — the output work the native
 *                 arm also does; not a full extractor reimplementation)
 *   pidx-cold   — bin/pidx full cold index of the corpus dir, extracts
 *                 written into the workdir via --out
 *   oracle-rerun — the oracle sweep again with a fresh tag (node has no
 *                 state cache; the honest baseline counterpart for warm)
 *   pidx-warm  — bin/pidx rerun over the unchanged corpus with the state
 *                store left in place (cache hit: reused == FILES, no
 *                reparse, no rewrite)
 *
 * Corpus: 40 JSONL files x ~800 KiB in <workdir>/corpus/<project>/,
 * deterministic mulberry32 content (seed below), session-log record shapes
 * (session header, user/assistant/toolResult messages, compactions).
 * File mtimes are backdated 24 h so pidx's 5-min active-session window
 * does not exclude them.
 *
 * MB/s = 32 MiB / p50 s. Writes benchmark/runs/throughput-pidx-<date>.md;
 * `--throughput` prints the md to stdout.
 *
 * Self-assertions: every sample finite, pidx exit 0 with parsed == FILES
 * and reused == 0 each cold run (proof of cold), warm runs reuse == FILES
 * and parsed == 0 (proof of cache hit), extract line count == FILES, all
 * MB/s >= 0.1, report file written non-empty.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "bin", "pidx");
const RUNS_DIR = join(ROOT, "benchmark", "runs");

const N = 10; // measured runs per arm
const WARMUP = 5;
const SEED = 20261107; // deterministic corpus content
const MIB = 32;
const FILES = 40;
const PER_FILE = Math.floor((MIB * 1024 * 1024) / FILES); // ~819 KiB
const CASE = "cold-index";
const WARM_CASE = "warm-rerun";

if (!existsSync(BIN)) {
  console.error("FATAL  bin/pidx missing — run scripts/bootstrap.sh (or the cargo build) first");
  process.exit(1);
}

// ---- deterministic PRNG (mulberry32) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["lorem", "ipsum", "dolor", "sit", "amet", "parser", "session", "index", "extract", "turn"];
function filler(rnd, min, max) {
  const n = min + Math.floor(rnd() * (max - min + 1));
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  words[2] = "32"; // the brief's "lorem ipsum 32" marker, deterministic
  return words.join(" ");
}
function isoAt(baseMs, offsetMs) {
  return new Date(baseMs - offsetMs).toISOString();
}
function hexId(rnd) {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(rnd() * 16).toString(16);
  return s;
}

// ---- corpus generation (session-log-shaped JSONL) ----
const work = mkdtempSync(join(tmpdir(), "pidx-bench-"));
const sessionsDir = join(work, "corpus");
const projectDir = join(sessionsDir, "projA");
mkdirSync(projectDir, { recursive: true });

const BASE_MS = Date.UTC(2026, 10, 7, 0, 0, 0); // 2026-11-07T00:00:00Z
const rnd = mulberry32(SEED);
let totalBytes = 0;
let totalLines = 0;

for (let fi = 0; fi < FILES; fi++) {
  const parts = [`{"type":"session","cwd":"/home/user/projA","ts":"${isoAt(BASE_MS, fi * 60000)}"}`];
  let len = parts[0].length + 1;
  let turn = 0;
  while (len < PER_FILE) {
    const ts = isoAt(BASE_MS, fi * 60000 + turn * 1500);
    const shape = turn % 4;
    let line;
    if (shape === 0) {
      // user message
      line = `{"type":"message","ts":"${ts}","message":{"role":"user","content":"${filler(rnd, 40, 160)}"}}`;
    } else if (shape === 1) {
      // assistant turn: usage + responseId + toolCall/text blocks
      const rid = `r${fi}-${turn}`;
      const cid = `c${fi}-${turn}`;
      const tools = ["piread", "pibash", "piedit", "piwrite"];
      const tool = tools[turn % tools.length];
      line = `{"type":"message","ts":"${ts}","message":{"role":"assistant","responseId":"${rid}","timestamp":"${ts}","model":"bench-model","usage":{"input":${100 + (turn % 50)},"output":${20 + (turn % 30)},"cacheRead":${500 + (turn % 700)},"cacheWrite":${turn % 90},"reasoning":${turn % 40},"totalTokens":${700 + (turn % 800)},"cost":{"total":0.00${10 + (turn % 80)}}},"content":[{"type":"text","text":"${filler(rnd, 20, 80)}"},{"type":"toolCall","id":"${cid}","name":"${tool}"}]}}`;
    } else if (shape === 2) {
      // tool result for the previous call
      const cid = `c${fi}-${turn - 1}`;
      line = `{"type":"message","ts":"${ts}","message":{"role":"toolResult","toolCallId":"${cid}","timestamp":"${ts}","content":"${filler(rnd, 60, 300)}","isError":false}}`;
    } else if (shape === 3) {
      // assistant text-only turn
      const rid = `r${fi}-${turn}`;
      line = `{"type":"message","ts":"${ts}","message":{"role":"assistant","responseId":"${rid}","timestamp":"${ts}","model":"bench-model","usage":{"input":${90 + (turn % 40)},"output":${30 + (turn % 20)},"totalTokens":${150 + (turn % 300)}},"content":[{"type":"text","text":"${filler(rnd, 30, 140)}"}]}}`;
    } else {
      line = `{"type":"compaction","ts":"${ts}"}`;
    }
    parts.push(line);
    len += line.length + 1;
    turn++;
  }
  // a few compaction records mixed in (shape 4 branch above is unreachable via
  // turn%4; append one explicit compaction per file)
  if (fi % 5 === 0) {
    const c = `{"type":"compaction","ts":"${isoAt(BASE_MS, fi * 60000 + 30000)}"}`;
    parts.push(c);
    len += c.length + 1;
  }
  const body = parts.join("\n") + "\n";
  const fname = `${isoAt(BASE_MS, fi * 60000).replace(/[:.]/g, "-")}_${hexId(rnd)}.jsonl`;
  const fpath = join(projectDir, fname);
  writeFileSync(fpath, body);
  totalBytes += Buffer.byteLength(body);
  totalLines += parts.length;
  const past = new Date(Date.now() - 864e5); // 24 h old: outside the 5-min active window
  utimesSync(fpath, past, past);
}

const corpusMib = totalBytes / (1024 * 1024);
assert.ok(corpusMib >= MIB * 0.98, `corpus too small: ${corpusMib} MiB`);
console.log(`corpus: ${FILES} files, ${(corpusMib).toFixed(1)} MiB, ${totalLines} lines, seed ${SEED}`);

// ---- measurement helpers (sibling-bench idiom) ----
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * same-output oracle: read + JSON.parse every line of every file, then build,
 * JSON.stringify and write one summary JSONL line per file into the workdir.
 * Emits exactly {file, records, turns, toolCalls, firstTs, lastTs} per file:
 * records = parsed lines, turns = assistant messages with usage (pidx's turn
 * rule), toolCalls = content blocks of type "toolCall", firstTs/lastTs =
 * min/max top-level ts (ISO strings compare lexicographically). The point is
 * parse + serialize + write — the dominant extra work beyond bare parsing —
 * not a faithful extractor.
 */
function oracleSweep(tag) {
  const summaries = [];
  let parsed = 0;
  for (const name of readdirSync(projectDir)) {
    const text = readFileSync(join(projectDir, name), "utf8");
    let records = 0;
    let turns = 0;
    let toolCalls = 0;
    let firstTs = null;
    let lastTs = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line);
      parsed++;
      records++;
      if (typeof e.ts === "string") {
        if (firstTs === null || e.ts < firstTs) firstTs = e.ts;
        if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
      }
      if (e.type === "message" && e.message) {
        const m = e.message;
        if (m.role === "assistant" && m.usage) turns++;
        if (Array.isArray(m.content)) {
          for (const b of m.content) if (b && b.type === "toolCall") toolCalls++;
        }
      }
    }
    summaries.push(JSON.stringify({ file: name, records, turns, toolCalls, firstTs, lastTs }));
  }
  writeFileSync(join(work, `oracle-out-${tag}.jsonl`), summaries.join("\n") + "\n");
  return parsed;
}

/** one cold pidx run: unique --state (cold), extracts to --out in the workdir */
function pidxCold(tag) {
  const r = spawnSync(BIN, ["--sessions-dir", sessionsDir, "--state", join(work, `state-${tag}.bin`), "--out", join(work, `out-${tag}.jsonl`)], { encoding: "utf8" });
  assert.equal(r.status, 0, `pidx exited ${r.status}: ${r.stderr}`);
  const summary = JSON.parse(r.stderr.trim().split("\n").pop());
  const outLines = readFileSync(join(work, `out-${tag}.jsonl`), "utf8").trim().split("\n").length;
  return { summary, outLines };
}

/** one-time warm-state setup: cold run with FIXED state + out paths */
function pidxWarmPrep() {
  const r = spawnSync(BIN, ["--sessions-dir", sessionsDir, "--state", join(work, "warm-state.bin"), "--out", join(work, "warm-out.jsonl")], { encoding: "utf8" });
  assert.equal(r.status, 0, `pidx warm prep exited ${r.status}: ${r.stderr}`);
}

/** one warm pidx rerun: same fixed state + out, unchanged corpus */
function pidxWarm() {
  const r = spawnSync(BIN, ["--sessions-dir", sessionsDir, "--state", join(work, "warm-state.bin"), "--out", join(work, "warm-out.jsonl")], { encoding: "utf8" });
  assert.equal(r.status, 0, `pidx warm exited ${r.status}: ${r.stderr}`);
  const summary = JSON.parse(r.stderr.trim().split("\n").pop());
  const outLines = readFileSync(join(work, "warm-out.jsonl"), "utf8").trim().split("\n").length;
  return { summary, outLines };
}

function measureArm(fn) {
  for (let i = 0; i < WARMUP; i++) fn(`w${i}`);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const a = process.hrtime.bigint();
    fn(`m${i}`);
    samples.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  samples.forEach((ms) => assert.ok(Number.isFinite(ms) && ms > 0, "sample must be finite"));
  samples.sort((x, y) => x - y);
  return pct(samples, 0.5);
}

// ---- arms ----
const naiveP50 = measureArm((tag) => { const n = oracleSweep(tag); assert.equal(n, totalLines, "oracle sweep line count"); });

let coldChecked = false;
const pidxP50 = measureArm((tag) => {
  const { summary, outLines } = pidxCold(tag);
  if (!coldChecked || tag.startsWith("m")) {
    assert.equal(summary.parsed, FILES, `pidx parsed ${summary.parsed}, want ${FILES}`);
    assert.equal(summary.reused, 0, `cold run reused ${summary.reused} (state not fresh)`);
    assert.equal(summary.excludedActive, 0, "active-session exclusion must not fire");
    assert.equal(outLines, FILES, `extract lines ${outLines}, want ${FILES}`);
    coldChecked = true;
  }
});

// ---- warm arm: existing state over unchanged corpus (the state store's
// payoff) with the oracle rerun — no cache, full redo — as its baseline ----
pidxWarmPrep();
let warmChecked = false;
const pidxWarmP50 = measureArm(() => {
  const { summary, outLines } = pidxWarm();
  if (!warmChecked) {
    assert.equal(summary.reused, FILES, `warm run reused ${summary.reused}, want ${FILES}`);
    assert.equal(summary.parsed, 0, `warm run parsed ${summary.parsed}, want 0 (state not reused)`);
    assert.equal(outLines, FILES, `warm extract lines ${outLines}, want ${FILES}`);
    warmChecked = true;
  }
});
const rerunP50 = measureArm((tag) => { const n = oracleSweep(tag); assert.equal(n, totalLines, "oracle rerun line count"); });

const mbs = (p50ms) => MIB / (p50ms / 1000);
const baselineMbs = mbs(naiveP50);
const nativeMbs = mbs(pidxP50);
const rerunMbs = mbs(rerunP50);
const warmMbs = mbs(pidxWarmP50);
assert.ok(baselineMbs >= 0.1 && nativeMbs >= 0.1, "throughput below 0.1 MB/s — refusing to report");
assert.ok(rerunMbs >= 0.1 && warmMbs >= 0.1, "warm throughput below 0.1 MB/s — refusing to report");

console.log(`oracle-write p50 ${naiveP50.toFixed(1)} ms → ${baselineMbs.toFixed(1)} MB/s`);
console.log(`pidx-cold   p50 ${pidxP50.toFixed(1)} ms → ${nativeMbs.toFixed(1)} MB/s (ratio ${(nativeMbs / baselineMbs).toFixed(2)}x baseline)`);
console.log(`oracle-rerun p50 ${rerunP50.toFixed(1)} ms → ${rerunMbs.toFixed(1)} MB/s`);
console.log(`pidx-warm   p50 ${pidxWarmP50.toFixed(1)} ms → ${warmMbs.toFixed(1)} MB/s (ratio ${(warmMbs / rerunMbs).toFixed(2)}x oracle rerun)`);

// ---- report (chart generator parses this verbatim) ----
const nodeV = process.version;
const cargoToml = readFileSync(join(ROOT, "rust-tools", "pidx", "Cargo.toml"), "utf8");
const pidxV = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
const host = `${process.platform} ${process.arch}`;
const date = new Date().toISOString().slice(0, 10);

const md = [
  `# pidx throughput — ${date}`,
  "",
  `Host ${host} · node ${nodeV} · pidx ${pidxV} · N=${N}/arm (${WARMUP} warmup) · MB/s = ${MIB} MiB ÷ p50 s.`,
  "",
  "## Throughput (MB/s)",
  "",
  "| case | payload | baseline MB/s | native MB/s | N |",
  "| --- | --- | ---: | ---: | ---: |",
  `| ${CASE} | ${MIB} MiB | ${baselineMbs.toFixed(1)} | ${nativeMbs.toFixed(1)} | ${N} |`,
  `| ${WARM_CASE} | ${MIB} MiB | ${rerunMbs.toFixed(1)} | ${warmMbs.toFixed(1)} | ${N} |`,
  "",
  "baseline = parse + build + write per-file summaries; native = full extracts + state store.",
  "",
  "warm-rerun: baseline = oracle rerun (node has no state cache — full reparse + rewrite); native = pidx rerun with the existing state store over the unchanged corpus (cache hit — no reparse, no rewrite). Warm speed is the state store paying off, not a like-for-like parse race.",
  "",
  `Corpus: ${FILES} synthetic session-log JSONL files (${corpusMib.toFixed(1)} MiB, mulberry32 seed ${SEED}) in a temp workdir; baseline = node oracle that parses every line and writes one JSONL summary per file, native = full cold index (\`bin/pidx --sessions-dir <corpus> --state <fresh> --out <workdir>\`) writing full per-session extracts — the state-store write is pidx-only extra work.`,
  "",
].join("\n");

mkdirSync(RUNS_DIR, { recursive: true });
const outFile = join(RUNS_DIR, `throughput-pidx-${date}.md`);
writeFileSync(outFile, md);
assert.ok(existsSync(outFile) && statSync(outFile).size > 0, "report file must be written non-empty");

rmSync(work, { recursive: true, force: true });
console.log(`pidx throughput bench: PASS → ${outFile}`);
if (process.argv.includes("--throughput")) process.stdout.write(md);
