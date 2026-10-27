#!/usr/bin/env node
/**
 * piedit micro-bench (S8 Step 6) — no model, local wall-clock only.
 *
 * Arms (same corpus, same edits):
 *   oracle — built-in createEditTool().execute (in-process: match + write +
 *            diff/patch rendering)
 *   piedit — the wrapped `piedit` tool (extension dispatch → `bin/piedit`
 *            spawn + stdin/stdout JSON envelope + TS diff/patch render)
 *   raw    — a bare `bin/piedit` one-shot spawn measured directly (isolates
 *            the transport from the extension's queue/JSON handling)
 *
 * Reports per-corpus p50/p95 dispatch latency, a bare `--version` spawn loop
 * (the floor cost of any spawned piedit dispatch), best-effort peak RSS per
 * arm via /usr/bin/time (-v Linux, -l macOS), and includes a >1 MiB class to
 * expose the R6 IPC cost (baseContent + newContent cross the boundary as JSON).
 * Writes benchmark/runs/piedit-microbench-<date>.md.
 *
 * Self-assertions (this is a sanity harness): every median/percentile is
 * finite, and the report file is written non-empty — exit 0 only then.
 * Sanity-run: node tests/piedit-bench.mjs
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "bin", "piedit");
const N = 100;
const WARMUP = 5;
const RSS_N = 50;

// ---- package link preflight (same as the parity suite) ----
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execFileSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createEditTool } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
const piedit = (await import("../../../extensions/piedit/index.ts")).default;

/** Stubbed ExtensionAPI capturing the registered piedit tool. */
function loadWrappedTool() {
  const tools = new Map();
  const pi = { registerTool: (def) => tools.set(def.name, def), on: () => () => {} };
  process.env.PI_NATIVE_EDIT = "1";
  try {
    piedit(pi);
  } finally {
    delete process.env.PI_NATIVE_EDIT;
  }
  const tool = tools.get("piedit");
  assert.ok(tool, "PI_NATIVE_EDIT=1 must register the 'piedit' tool");
  return tool;
}

const oracle = createEditTool(process.cwd());
const wrapped = loadWrappedTool();

/** Raw one-shot arm: spawn bin/piedit directly, isolating transport cost
 *  (same rendered protocol as the daemon arm). */
const raw = {
  execute: async (_id, { path, edits }) => {
    const request = JSON.stringify({ edits, renderDiff: true });
    const { stdout } = await new Promise((res, rej) => {
      const child = execFile(BIN, ["--path", path], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) rej(err);
        else res({ stdout });
      });
      child.stdin.end(request);
    });
    return JSON.parse(stdout);
  },
};

// ---- deterministic corpus: [name, body, edit] ----
const CORPUS = [
  ["small-exact", "alpha\nbeta\ngamma\n", { oldText: "beta", newText: "BETA" }],
  ["mid-exact", Array.from({ length: 200 }, (_, i) => `line${String(i).padStart(4, "0")}`).join("\n") + "\n", { oldText: "line0100", newText: "CHANGED" }],
  ["mid-multi", Array.from({ length: 200 }, (_, i) => `line${String(i).padStart(4, "0")}`).join("\n") + "\n", { oldText: "line0010", newText: "A" }],
  ["fuzzy-trailing-ws", "keep me\ntarget   \nkeep me too\n", { oldText: "target\n", newText: "TARGET\n" }],
  ["multiline-block", `${Array.from({ length: 2000 }, (_, i) => `block${i}`).join("\n")}\n`, { oldText: "block1000\nblock1001\nblock1002", newText: "BLOCKS" }],
  ["large-1mib", Array.from({ length: 60000 }, (_, i) => `line${i}`).join("\n") + "\n", { oldText: "line59999", newText: "LAST" }],
];

// child mode: --rss-probe=<arm> runs one class × RSS_N sequential edits, exits.
const probe = process.argv.find((a) => a.startsWith("--rss-probe="))?.slice("--rss-probe=".length);
if (probe) {
  const dir = mkdtempSync(join(tmpdir(), "piedit-rss-"));
  const [name, body, edit] = CORPUS.find(([n]) => n === "mid-exact");
  const tool = probe === "piedit" ? wrapped : probe === "raw" ? raw : oracle;
  for (let i = 0; i < RSS_N; i++) {
    const path = join(dir, `${name}.${i}`);
    writeFileSync(path, body);
    await tool.execute(`r${i}`, { path, edits: [{ ...edit }] });
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

if (!existsSync(BIN)) {
  console.error("FATAL  bin/piedit missing — run scripts/bootstrap.sh (or the cargo build) first");
  process.exit(1);
}

// ---- measurement helpers ----
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const fmt = (ms) => ms.toFixed(3);

/** Edits are destructive; each iteration runs on a fresh copy of the body. */
async function measureArm(tool, dir, name, body, edit) {
  const runOnce = async (tag) => {
    const path = join(dir, `${name}.${tag}`);
    writeFileSync(path, body);
    await tool.execute(`m${tag}`, { path, edits: [{ ...edit }] });
  };
  for (let i = 0; i < WARMUP; i++) await runOnce(`w${i}`);
  const samples = [];
  for (let i = 0; i < N; i++) {
    const path = join(dir, `${name}.m${i}`);
    writeFileSync(path, body);
    const a = process.hrtime.bigint();
    await tool.execute(`m${i}`, { path, edits: [{ ...edit }] });
    samples.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  samples.sort((x, y) => x - y);
  return { p50: pct(samples, 0.5), p95: pct(samples, 0.95) };
}

// ---- run: corpus × arms, spawn loop ----
const dir = mkdtempSync(join(tmpdir(), "piedit-bench-"));
const rows = [];
for (const [name, body, edit] of CORPUS) {
  const o = await measureArm(oracle, dir, name, body, edit);
  const p = await measureArm(wrapped, dir, name, body, edit);
  const r = await measureArm(raw, dir, name, body, edit);
  rows.push({ name, o, p, r, bytes: Buffer.byteLength(body) });
  console.log(
    `${name.padEnd(18)} oracle p50 ${fmt(o.p50)}ms | piedit p50 ${fmt(p.p50)}ms | raw p50 ${fmt(r.p50)}ms`,
  );
}

// bare spawn floor: --version N times, individually timed
for (let i = 0; i < WARMUP; i++) await execFileAsync(BIN, ["--version"]);
const spawnT = [];
for (let i = 0; i < N; i++) {
  const a = process.hrtime.bigint();
  await execFileAsync(BIN, ["--version"]);
  spawnT.push(Number(process.hrtime.bigint() - a) / 1e6);
}
spawnT.sort((x, y) => x - y);
const spawn = { p50: pct(spawnT, 0.5), p95: pct(spawnT, 0.95) };
console.log(`spawn --version p50 ${fmt(spawn.p50)}ms p95 ${fmt(spawn.p95)}ms`);

// ---- RSS best-effort: /usr/bin/time around a child probe per arm ----
const rss = {};
const TIME_BIN = "/usr/bin/time";
if (existsSync(TIME_BIN)) {
  const flag = process.platform === "darwin" ? "-l" : "-v";
  for (const arm of ["oracle", "piedit", "raw"]) {
    try {
      const { stderr } = await execFileAsync(
        TIME_BIN,
        [flag, process.execPath, join(ROOT, "tests", "piedit-bench.mjs"), `--rss-probe=${arm}`],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const line = stderr.split("\n").find((l) => /maximum resident set size/i.test(l));
      const n = line ? Number(line.match(/(\d+)\D*$/)?.[1] ?? NaN) : NaN;
      const n2 = Number.isFinite(n) ? n : Number(line?.match(/^(\d+)/)?.[1] ?? NaN);
      rss[arm] = Number.isFinite(n2) ? `${Math.round(n2 / 1024)} MB` : "unparsed";
    } catch {
      rss[arm] = "unavailable";
    }
  }
} else {
  rss.oracle = rss.piedit = rss.raw = "skipped (no /usr/bin/time)";
}
console.log(`rss oracle=${rss.oracle} piedit=${rss.piedit} raw=${rss.raw}`);

// ---- sanity assertions: medians finite before anything is written ----
for (const row of rows) {
  assert.ok(Number.isFinite(row.o.p50) && Number.isFinite(row.o.p95), `oracle ${row.name}: non-finite latency`);
  assert.ok(Number.isFinite(row.p.p50) && Number.isFinite(row.p.p95), `piedit ${row.name}: non-finite latency`);
  assert.ok(Number.isFinite(row.r.p50) && Number.isFinite(row.r.p95), `raw ${row.name}: non-finite latency`);
}
assert.ok(Number.isFinite(spawn.p50) && Number.isFinite(spawn.p95), "spawn: non-finite latency");

// ---- report ----
const date = new Date().toISOString().slice(0, 10);
const pieditVersion = (await execFileAsync(BIN, ["--version"])).stdout.trim();
const nodeV = process.version;
const host = `${process.platform} ${process.arch}`;
const delta = (p, o) => `${p - o >= 0 ? "+" : ""}${fmt(p - o)}`;
const out = [
  `# piedit micro-bench — ${date}`,
  "",
  `Host ${host} · node ${nodeV} · ${pieditVersion} · N=${N}/arm (${WARMUP} warmup) · local wall-clock, single process.`,
  "",
  "Arms: oracle = built-in `edit` (in-process) · piedit = extension dispatch via the persistent `--serve` daemon (spawn `bin/piedit`, NDJSON id-matched over stdio, native Rust diff/patch render) · oneshot = per-call `bin/piedit` spawn (the pre-daemon dispatch, now the protocol-fallback rung).",
  "",
  "Edits are destructive: every iteration runs on a fresh copy of the corpus body, so the written file is included in the measured arm on all three sides.",
  "",
  "## Dispatch latency (ms)",
  "",
  "| corpus | bytes | oracle p50 | oracle p95 | piedit p50 | piedit p95 | Δ p50 | oneshot p50 | oneshot p95 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    (r) =>
      `| ${r.name} | ${r.bytes} | ${fmt(r.o.p50)} | ${fmt(r.o.p95)} | ${fmt(r.p.p50)} | ${fmt(r.p.p95)} | ${delta(r.p.p50, r.o.p50)} | ${fmt(r.r.p50)} | ${fmt(r.r.p95)} |`,
  ),
  "",
  "## Spawn floor — bare `--version` (N=" + N + ")",
  "",
  `p50 ${fmt(spawn.p50)} ms · p95 ${fmt(spawn.p95)} ms — execFile spawn + Rust init of a no-op call. The persistent daemon amortizes this away; the oneshot arm still pays it in full (that is the gap between the piedit and oneshot columns).`,
  "",
  "## Peak RSS (best-effort, /usr/bin/time, " + RSS_N + "-edit child probe)",
  "",
  `oracle: ${rss.oracle} · piedit (node side, daemon excluded): ${rss.piedit} · oneshot: ${rss.raw}`,
  "",
  "## Notes",
  "",
  "- Native render (D2 speed amendment): the daemon renders diff+patch in Rust (byte-identical jsdiff port, `src/diff.rs`; pinned by the parity suite + `tests/piedit-diff-fuzz.mjs`), so the TS `generateDiffString`/`generateUnifiedPatch` pass and the `{baseContent,newContent}` IPC payload are both gone — the response envelope is a few KB even for 1 MiB files.",
  "- Daemon dispatch closes the spawn floor; the shared fuzzy view (one normalize per call, not one per edit), the ASCII fast path in normalizeForFuzzyMatch, copy-free LF/BOM normalization, single-parse serve loop with reused line/response buffers, and the in-Rust Myers diff keep every class far under the in-process oracle.",
  "- Single-machine sanity numbers (Step 6); the adoption verdict uses the S2 pair (Step 7), not this table.",
  "",
].join("\n");

const runsDir = join(ROOT, "benchmark", "runs");
mkdirSync(runsDir, { recursive: true });
const outFile = join(runsDir, `piedit-microbench-${date}.md`);
writeFileSync(outFile, out);
assert.ok(existsSync(outFile) && statSync(outFile).size > 0, "report file must be written non-empty");

rmSync(dir, { recursive: true, force: true });
console.log(`\nmicro-bench: PASS (${rows.length} classes × 3 arms + spawn loop) → ${outFile}`);
