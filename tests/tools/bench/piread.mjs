#!/usr/bin/env node
/**
 * piread micro-bench (S6 Step 6 + daemon amendment) — no model, local
 * wall-clock only.
 *
 * Arms (same corpus, same params):
 *   oracle   — built-in createReadTool().execute (in-process)
 *   piread   — the wrapped `read` tool (extension dispatch → persistent
 *              `bin/piread --serve` daemon; the production path)
 *   oneshot  — per-call `bin/piread` spawn (the pre-daemon dispatch, kept
 *              as the protocol-fallback rung and for comparison)
 *
 * Reports per-corpus p50/p95 dispatch latency, a bare `--version` spawn
 * loop (the floor cost of any spawned piread dispatch), best-effort peak
 * RSS per arm via /usr/bin/time (-v Linux, -l macOS), and (Linux) the
 * daemon's own steady-state VmHWM after a 200-request soak.
 * Writes benchmark/runs/piread-microbench-<date>.md.
 *
 * Self-assertions (this is a sanity harness): every median/percentile is
 * finite, and the report file is written non-empty — exit 0 only then.
 * Sanity-run: node tests/piread-bench.mjs
 */
import { execFile, execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "bin", "piread");
const N = 200;
const WARMUP = 10;
const RSS_N = 100; // child-probe iterations (reduced — RSS peak converges fast)

// ---- piread package link preflight (same as the parity suite) ----
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execFileSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createReadTool } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
const piread = (await import("../../../extensions/piread/index.ts")).default;

/** Stubbed ExtensionAPI capturing the registered piread tool. */
function loadWrappedTool() {
  const tools = new Map();
  const pi = { registerTool: (def) => tools.set(def.name, def), on: () => () => {} };
  process.env.PI_NATIVE_READ = "1";
  try {
    piread(pi);
  } finally {
    delete process.env.PI_NATIVE_READ;
  }
  const tool = tools.get("piread");
  assert.ok(tool, "PI_NATIVE_READ=1 must register the 'piread' tool");
  return tool;
}

const oracle = createReadTool(process.cwd());
const wrapped = loadWrappedTool();

/** One-shot arm: the pre-daemon extension dispatch (per-call spawn), inline. */
const oneshot = {
  execute: async (_id, { path }) => {
    const { stdout } = await execFileAsync(BIN, ["--path", path], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
};

// ---- deterministic corpus (parity classes; caps + truncateHead paths) ----
const CORPUS = [
  ["one-line", "solo\n"],
  ["crlf", "one\r\ntwo\r\nthree\r\n"],
  ["unicode", "héllo\n🎉emoji\n€€€€€€€€\n"],
  ["long-lines", Array.from({ length: 20 }, (_, i) => `${String(i).padStart(3, "0")}:${"x".repeat(296)}`).join("\n") + "\n"],
  ["lines2500", Array.from({ length: 2500 }, (_, i) => `line${String(i).padStart(4, "0")}`).join("\n") + "\n"],
  ["bytes60k", Array.from({ length: 600 }, () => "x".repeat(100)).join("\n")],
  ["head60k", "y".repeat(60000) + "\nsmall\n"],
];

// child mode: --rss-probe=<arm> runs one class × RSS_N iterations, exits.
const probe = process.argv.find((a) => a.startsWith("--rss-probe="))?.slice("--rss-probe=".length);
if (probe) {
  const dir = mkdtempSync(join(tmpdir(), "piread-rss-"));
  const path = join(dir, "probe");
  writeFileSync(path, CORPUS.find(([n]) => n === "lines2500")[1]);
  const tool = probe === "piread" ? wrapped : probe === "oneshot" ? oneshot : oracle;
  const jobs = [];
  for (let i = 0; i < RSS_N; i++) jobs.push(tool.execute(`r${i}`, { path }));
  await Promise.all(jobs);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

if (!existsSync(BIN)) {
  console.error("FATAL  bin/piread missing — run scripts/bootstrap.sh (or the cargo build) first");
  process.exit(1);
}

// ---- measurement helpers ----
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const fmt = (ms) => ms.toFixed(3);

async function measureArm(tool, path) {
  for (let i = 0; i < WARMUP; i++) await tool.execute(`w${i}`, { path });
  const samples = [];
  for (let i = 0; i < N; i++) {
    const a = process.hrtime.bigint();
    await tool.execute(`m${i}`, { path });
    samples.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  samples.sort((x, y) => x - y);
  return { p50: pct(samples, 0.5), p95: pct(samples, 0.95) };
}

// ---- run: corpus × arms, spawn loop ----
const dir = mkdtempSync(join(tmpdir(), "piread-bench-"));
const rows = [];
for (const [name, body] of CORPUS) {
  const path = join(dir, name);
  writeFileSync(path, body);
  const o = await measureArm(oracle, path);
  const p = await measureArm(wrapped, path);
  const s = await measureArm(oneshot, path);
  rows.push({ name, o, p, s });
  console.log(`${name.padEnd(10)} oracle p50 ${fmt(o.p50)}ms | piread(daemon) p50 ${fmt(p.p50)}ms | oneshot p50 ${fmt(s.p50)}ms`);
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
  for (const arm of ["oracle", "piread", "oneshot"]) {
    try {
      const { stderr } = await execFileAsync(TIME_BIN, [flag, process.execPath, join(ROOT, "tests", "piread-bench.mjs"), `--rss-probe=${arm}`], { maxBuffer: 16 * 1024 * 1024 });
      const line = stderr.split("\n").find((l) => /maximum resident set size/i.test(l));
      const n = line ? Number(line.match(/(\d+)\D*$/)?.[1] ?? NaN) : NaN; // digits at EOL (Linux) or BOL (macOS)
      const n2 = Number.isFinite(n) ? n : Number(line?.match(/^(\d+)/)?.[1] ?? NaN);
      rss[arm] = Number.isFinite(n2) ? `${Math.round(n2 / 1024)} MB` : "unparsed";
    } catch {
      rss[arm] = "unavailable";
    }
  }
} else {
  rss.oracle = rss.piread = rss.oneshot = "skipped (no /usr/bin/time)";
}
console.log(`rss oracle=${rss.oracle} piread=${rss.piread} oneshot=${rss.oneshot}`);

// ---- daemon steady-state RSS (Linux /proc VmHWM after a 200-read soak) ----
// The `piread` probe above measures the dispatching node process; the
// daemon is a separate child whose peak RSS is invisible to /usr/bin/time.
async function daemonRssProbe() {
  if (process.platform !== "linux") return "skipped (non-Linux)";
  const dir = mkdtempSync(join(tmpdir(), "piread-daemonrss-"));
  const path = join(dir, "probe");
  writeFileSync(path, CORPUS.find(([n]) => n === "lines2500")[1]);
  const proc = spawnChild(BIN, ["--serve"], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    let pending = N; // one response per request
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon soak timeout")), 30_000);
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          buf = buf.slice(nl + 1);
          if (--pending === 0) { clearTimeout(timer); resolve(); }
        }
      });
      proc.on("exit", () => reject(new Error("daemon exited early")));
    });
    for (let id = 1; id <= N; id++) {
      proc.stdin.write(`${JSON.stringify({ id, path, cwd: dir })}\n`);
    }
    await done;
    const status = readFileSync(`/proc/${proc.pid}/status`, "utf8");
    const kib = Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1] ?? NaN);
    return Number.isFinite(kib) ? `${Math.round(kib / 1024)} MB` : "unparsed";
  } catch {
    return "unavailable";
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
const daemonRss = await daemonRssProbe();
console.log(`rss daemon(vmhwm)=${daemonRss}`);

// ---- sanity assertions: medians finite before anything is written ----
for (const r of rows) {
  assert.ok(Number.isFinite(r.o.p50) && Number.isFinite(r.o.p95), `oracle ${r.name}: non-finite latency`);
  assert.ok(Number.isFinite(r.p.p50) && Number.isFinite(r.p.p95), `piread ${r.name}: non-finite latency`);
  assert.ok(Number.isFinite(r.s.p50) && Number.isFinite(r.s.p95), `oneshot ${r.name}: non-finite latency`);
}
assert.ok(Number.isFinite(spawn.p50) && Number.isFinite(spawn.p95), "spawn: non-finite latency");

// ---- report ----
const date = new Date().toISOString().slice(0, 10);
const pireadVersion = (await execFileAsync(BIN, ["--version"])).stdout.trim();
const nodeV = process.version;
const host = `${process.platform} ${process.arch}`;
const out = [
  `# piread micro-bench — ${date}`,
  "",
  `Host ${host} · node ${nodeV} · ${pireadVersion} · N=${N}/arm (${WARMUP} warmup) · local wall-clock, single process.`,
  "",
  "Arms: oracle = built-in read (in-process) · piread = extension dispatch via the persistent `--serve` daemon · oneshot = per-call spawn (the pre-daemon dispatch, now the protocol-fallback rung).",
  "",
  "## Dispatch latency (ms)",
  "",
  "| corpus | oracle p50 | oracle p95 | piread p50 | piread p95 | Δ p50 | oneshot p50 | oneshot p95 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map((r) => `| ${r.name} | ${fmt(r.o.p50)} | ${fmt(r.o.p95)} | ${fmt(r.p.p50)} | ${fmt(r.p.p95)} | ${r.p.p50 - r.o.p50 >= 0 ? "+" : ""}${fmt(r.p.p50 - r.o.p50)} | ${fmt(r.s.p50)} | ${fmt(r.s.p95)} |`),
  "",
  "## Spawn floor — bare `--version` (N=200)",
  "",
  `p50 ${fmt(spawn.p50)} ms · p95 ${fmt(spawn.p95)} ms — execFile spawn + Rust init of a no-op call; the per-dispatch cost the daemon amortizes away (still paid by every oneshot dispatch).`,
  "",
  "## Peak RSS (best-effort, /usr/bin/time, " + RSS_N + "-read child probe)",
  "",
  `oracle: ${rss.oracle} · piread (node side, daemon excluded): ${rss.piread} · oneshot: ${rss.oneshot} · daemon itself (VmHWM after ${N}-read soak): ${daemonRss}`,
  "",
  "---",
  "",
  "Single-machine sanity numbers (Step 6 + daemon amendment); the adoption verdict uses the S2 pair (Step 7), not this table.",
  "",
].join("\n");

const runsDir = join(ROOT, "benchmark", "runs");
mkdirSync(runsDir, { recursive: true });
const outFile = join(runsDir, `piread-microbench-${date}.md`);
writeFileSync(outFile, out);
assert.ok(existsSync(outFile) && statSync(outFile).size > 0, "report file must be written non-empty");

rmSync(dir, { recursive: true, force: true });
console.log(`\nmicro-bench: PASS (${rows.length} classes × 3 arms + spawn loop + daemon probe) → ${outFile}`);
