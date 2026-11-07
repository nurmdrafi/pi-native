#!/usr/bin/env node
// benchmark/rss-arm/bench.mjs — peak-RSS arm: measures whole-process peak
// resident set size (KiB) of the native Rust tools (bin/piread, bin/pibash,
// bin/piwrite) against the pi built-in equivalents driven in-process by node,
// on identical frozen deterministic workloads. This is the arm that answers
// image-only memory claims with reproducible numbers.
//
// Modes:
//   node bench.mjs --selftest   validate harness logic (parsers, math,
//                               generator determinism, aggregation) — no
//                               fixtures, no results written
//   node bench.mjs --smoke      2 measured runs per side, no warmup
//   node bench.mjs --full       1 unrecorded warmup run per side, then 5
//                               measured runs per side, interleaved
//                               native/builtin per round
//   Bench modes accept --tag <name>: results go to
//   results/results-<date>-<tag>.ndjson and summary-<date>-<tag>.md
//   (untagged: results-<date>.ndjson / summary-<date>.md). Every bench
//   invocation APPENDS with a fresh runid — reruns accumulate samples so
//   spread across reruns is measurable from one file.
//
// Measurement: each run spawns `/usr/bin/time -v <argv>` and parses
//   "Maximum resident set size (kbytes)" — GNU time reports getrusage
//   ru_maxrss, which on Linux equals the VmHWM high-water mark from
//   /proc/<pid>/status, in KiB. Whole-process peak RSS: for the native side
//   that is the binary process; for the builtin side it is the node process
//   running the real built-in tool module in-process (imported from the
//   installed pi-coding-agent dist, probed once untimed; if the module
//   cannot be driven, the driver falls back to an exact node-core replica
//   of its fs/spawn calls and the row is labelled "node-core-equivalent").
//   Runs are warm (page cache primed by the warmup run / earlier rounds).
//
// Workloads (frozen, deterministic):
//   read-window   150,000-line corpus (~13.9 MB, xorshift32 printable
//                 alphabet, content identical every run); native:
//                 `piread --path <corpus> --offset 60000 --limit 1500`;
//                 builtin: read tool execute({path,offset,limit}) — the
//                 built-in reads the whole file and splits all lines.
//   bash-seq      native: `pibash --command "seq 1 50000"` (both sides
//                 capture the full ~288 KB stdout stream); builtin: bash
//                 tool execute({command}) or node spawn replica.
//   write-100mb   deterministic 100 MB printable byte stream; native:
//                 `piwrite --path <f>` with the bytes on stdin; builtin:
//                 write tool execute({path, content}) with the same bytes
//                 as an in-process string (the driver loads them from the
//                 shared fixture file, mirroring how the built-in receives
//                 content).
//
// Results: one NDJSON line per measured run appended to the results file as
// it lands: {"ts","runid","mode","tag","workload","side","label","round",
// "rss_kib","wall_ms","ok":true} (failures get "ok":false,"error":...). At
// the end a per-workload table plus verdicts goes to summary-<date>[-<tag>.md
// and consolidated rows to /tmp/bench-rss.ndjson:
//   {"workload":...,"native_rss_kib":N,"builtin_rss_kib":N,"delta":"N.Nx"}
//   {"summary":true,"runs":N,"median_spread_pct":N}
// where delta = builtin_median / native_median (">1x" = native is that many
// times lighter) and median_spread_pct is the max, across (workload, side),
// of the spread between per-invocation medians recorded in the file.
//
// Plain node ESM, no dependencies. GNU time is required (/usr/bin/time -v).
// Fixtures land in tmp/<runid>/ (tmp/ wiped at run start).

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE)); // benchmark/rss-arm -> repo root
const TMP_ROOT = path.join(HERE, "tmp");
const RESULTS_DIR = path.join(HERE, "results");
const DRIVER = path.join(HERE, "drivers", "builtin-driver.mjs");
const DELIVERABLE = "/tmp/bench-rss.ndjson";

const GNU_TIME = "/usr/bin/time";
const DEFAULT_BIN = {
  read: path.join(REPO, "bin", "piread"),
  bash: path.join(REPO, "bin", "pibash"),
  write: path.join(REPO, "bin", "piwrite"),
};
const DIST_TOOLS =
  "/home/nurmdrafi/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools";

const CORPUS_LINES = 150_000;
const READ_OFFSET = 60_000; // 1-based
const READ_LIMIT = 1_500;
const SEQ_LAST = 50_000;
const WRITE_BYTES = 100 * 1024 * 1024;
const SPAWN_TIMEOUT_MS = 120_000;

// ---------- deterministic content (xorshift32 over a printable alphabet) ----------
const PRINTABLE =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.:;+*-_()[]{}<>?!@#$%^&=/|~`'";
const SEED = 0x9e3779b9;

function xorstep(x) {
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x;
}

function genBytes(size) {
  const out = Buffer.allocUnsafe(size);
  let x = SEED;
  for (let i = 0; i < size; i++) {
    x = xorstep(x);
    out[i] = PRINTABLE[x % PRINTABLE.length].charCodeAt(0);
  }
  return out;
}

// Corpus line i (0-based): length 80..95, content seeded by line index, so
// any window is recomputable without regenerating the file.
function corpusLine(i) {
  let x = (SEED ^ Math.imul(i + 1, 2654435761)) >>> 0;
  const len = 80 + (xorstep(x) % 16);
  x = xorstep(x);
  const chars = Buffer.allocUnsafe(len);
  for (let j = 0; j < len; j++) {
    x = xorstep(x);
    chars[j] = PRINTABLE[x % PRINTABLE.length].charCodeAt(0);
  }
  return chars.toString("latin1");
}

async function buildCorpus(file) {
  const parts = [];
  for (let i = 0; i < CORPUS_LINES; i++) parts.push(corpusLine(i));
  parts.push(""); // trailing newline
  await writeFile(file, parts.join("\n"), "latin1");
}

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  if (values.length === 0) throw new Error("median of empty");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// GNU time -v stderr parsing. ru_maxrss on Linux is KiB and equals VmHWM.
function parseTimeVer(stderr) {
  const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  if (!m) throw new Error("no max-RSS line in time -v output");
  const rssKib = Number(m[1]);
  const w = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*(\S+)/.exec(stderr);
  let wallMs = null;
  if (w) {
    const parts = w[1].split(":").map(Number);
    if (parts.every((n) => Number.isFinite(n))) {
      wallMs = parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
    }
  }
  return { rss_kib: rssKib, wall_ms: wallMs };
}

// ---------- measured spawn ----------
// Runs `time -v <argv>`; stdin is either "ignore" or a file descriptor.
async function measure({ argv, stdinFile }) {
  return new Promise((resolve) => {
    let stdinFd = "ignore";
    let fh = null;
    const launch = async () => {
      if (stdinFile) {
        fh = await open(stdinFile, "r");
        stdinFd = fh.fd;
      }
      const child = spawn(GNU_TIME, ["-v", ...argv], {
        stdio: [stdinFd, "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", async (code, signal) => {
        clearTimeout(timer);
        if (fh) await fh.close().catch(() => {});
        resolve({ code, signal, stdout: out, stderr: err });
      });
      child.on("error", async (e) => {
        clearTimeout(timer);
        if (fh) await fh.close().catch(() => {});
        resolve({ code: -1, signal: null, stdout: out, stderr: String(e) });
      });
    };
    launch().catch(async (e) => {
      if (fh) await fh.close().catch(() => {});
      resolve({ code: -1, signal: null, stdout: "", stderr: String(e) });
    });
  });
}

async function runMeasured(argv, stdinFile) {
  const res = await measure({ argv, stdinFile });
  if (res.signal === "SIGKILL") {
    return { ok: false, error: `timeout after ${SPAWN_TIMEOUT_MS}ms`, stdout: res.stdout };
  }
  if (res.code !== 0) {
    return { ok: false, error: `exit ${res.code}`, stdout: res.stdout };
  }
  try {
    const { rss_kib, wall_ms } = parseTimeVer(res.stderr);
    if (!Number.isFinite(rss_kib) || rss_kib <= 0) throw new Error(`bad rss_kib ${rss_kib}`);
    return { ok: true, rss_kib, wall_ms, stdout: res.stdout };
  } catch (e) {
    return { ok: false, error: `time -v parse: ${e.message}`, stdout: res.stdout };
  }
}

// ---------- aggregation ----------
function aggregate(rows) {
  // rows: parsed NDJSON rows from one results file (all invocations)
  const byKey = new Map(); // workload|side -> [{runid, rss_kib}]
  for (const r of rows) {
    if (!r.ok || !Number.isFinite(r.rss_kib)) continue;
    const k = `${r.workload}|${r.side}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const workloads = [...new Set(rows.map((r) => r.workload))];
  const perWorkload = {};
  for (const w of workloads) {
    perWorkload[w] = {};
    for (const side of ["native", "builtin"]) {
      const runs = byKey.get(`${w}|${side}`) || [];
      if (runs.length === 0) continue;
      const vals = runs.map((r) => r.rss_kib).sort((a, b) => a - b);
      const perRunid = new Map();
      for (const r of runs) {
        if (!perRunid.has(r.runid)) perRunid.set(r.runid, []);
        perRunid.get(r.runid).push(r.rss_kib);
      }
      const runidMedians = [...perRunid.values()].map((v) => median(v));
      const spreadPct =
        runidMedians.length > 1
          ? ((Math.max(...runidMedians) - Math.min(...runidMedians)) / Math.min(...runidMedians)) * 100
          : 0;
      perWorkload[w][side] = {
        runs: runs.length,
        invocations: runidMedians.length,
        min: vals[0],
        p50: median(vals),
        max: vals[vals.length - 1],
        runidMedians,
        spreadPct,
        labels: [...new Set(runs.map((r) => r.label))].join(","),
      };
    }
  }
  const deliverableRows = [];
  let maxSpread = 0;
  let runsPerSide = Infinity; // min sample count across (workload, side)
  for (const w of workloads) {
    const n = perWorkload[w].native;
    const b = perWorkload[w].builtin;
    for (const s of [n, b]) if (s) { maxSpread = Math.max(maxSpread, s.spreadPct); runsPerSide = Math.min(runsPerSide, s.runs); }
    if (n && b) {
      deliverableRows.push({
        workload: w,
        native_rss_kib: Math.round(n.p50),
        builtin_rss_kib: Math.round(b.p50),
        delta: `${(b.p50 / n.p50).toFixed(1)}x`,
      });
    }
  }
  return {
    perWorkload,
    workloads,
    deliverableRows,
    summary: { summary: true, runs: Number.isFinite(runsPerSide) ? runsPerSide : 0, median_spread_pct: r1(maxSpread) },
  };
}

// ---------- summary markdown ----------
function writeSummaryMd(agg, meta) {
  const L = [];
  L.push(`# rss-arm benchmark summary — ${meta.date}`);
  L.push("");
  L.push(`- generated: ${nowIso()}`);
  L.push(`- node: ${process.version}`);
  L.push(`- /usr/bin/time: ${meta.gnuTimeVersion}`);
  L.push(`- binaries: piread=${meta.bins.read} pibash=${meta.bins.bash} piwrite=${meta.bins.write}`);
  L.push(`- mode: ${meta.mode}${meta.tag ? ` tag: ${meta.tag}` : ""}`);
  L.push("");
  for (const w of agg.workloads) {
    const n = agg.perWorkload[w].native;
    const b = agg.perWorkload[w].builtin;
    L.push(`## workload=${w}`);
    L.push("");
    L.push("| side | label | runs | min KiB | p50 KiB | max KiB | rerun spread % |");
    L.push("|---|---|---|---|---|---|---|");
    for (const [side, s] of [["native", n], ["builtin", b]]) {
      if (!s) continue;
      L.push(
        `| ${side} | ${s.labels} | ${s.runs} | ${s.min} | ${s.p50} | ${s.max} | ${r1(s.spreadPct)} |`
      );
    }
    L.push("");
    if (n && b) {
      L.push(
        `verdict ${w}: native vs builtin — p50 peak RSS ${n.p50} KiB vs ${b.p50} KiB → builtin uses ${(b.p50 / n.p50).toFixed(1)}x more peak RSS`
      );
      L.push("");
    }
  }
  L.push("## Methodology");
  L.push("");
  L.push("- Peak RSS sampled per run by `/usr/bin/time -v` (GNU time reports getrusage `ru_maxrss` = Linux VmHWM high-water mark, in KiB); whole-process measurement, no /proc polling needed.");
  L.push("- Each side runs the identical frozen workload; native side = the Rust binary process, builtin side = a node process driving the real built-in tool module in-process (probe first; exact node-core replica fallback, labelled `node-core-equivalent`).");
  L.push(`- Runs are warm: ${meta.warmup} unrecorded warmup run(s) per side prime the page cache; ${meta.measured} measured runs per side, interleaved native/builtin per round.`);
  L.push("- Compared statistic: median (p50) of measured runs. Rerun spread % = (max−min)/min over per-invocation medians recorded in this results file.");
  L.push("- Fixtures are deterministic (xorshift32, fixed seed): every invocation regenerates byte-identical corpus/content.");
  L.push("");
  return L.join("\n");
}

// ---------- selftest ----------
async function selftest() {
  let fails = 0;
  const t = (name, cond) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
    if (!cond) fails++;
  };

  const canned =
    "\tCommand being timed: true\n" +
    "\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:00.12\n" +
    "\tMaximum resident set size (kbytes): 1116\n";
  const p = parseTimeVer(canned);
  t("parseTimeVer rss", p.rss_kib === 1116);
  t("parseTimeVer wall ms", p.wall_ms === 120);
  t("parseTimeVer h:mm:ss", parseTimeVer("Elapsed (wall clock) time (h:mm:ss or m:ss): 1:01.05\nMaximum resident set size (kbytes): 5").wall_ms === 61050);
  t("parseTimeVer missing rss throws", (() => { try { parseTimeVer("x"); return false; } catch { return true; } })());

  t("median odd", median([3, 1, 2]) === 2);
  t("median even", median([4, 1, 3, 2]) === 2.5);

  t("genBytes deterministic", genBytes(65536).equals(genBytes(65536)));
  t("corpusLine deterministic", corpusLine(59999) === corpusLine(59999));
  t("corpusLine line-length bounds", corpusLine(0).length >= 80 && corpusLine(0).length <= 95);
  t("corpusLine distinct lines", corpusLine(1) !== corpusLine(2));

  const rows = [
    { workload: "w", side: "native", runid: "r1", label: "piread", ok: true, rss_kib: 100 },
    { workload: "w", side: "native", runid: "r1", label: "piread", ok: true, rss_kib: 200 },
    { workload: "w", side: "native", runid: "r2", label: "piread", ok: true, rss_kib: 300 },
    { workload: "w", side: "builtin", runid: "r1", label: "node-builtin", ok: true, rss_kib: 1000 },
    { workload: "w", side: "builtin", runid: "r1", label: "node-builtin", ok: true, rss_kib: 1000 },
    { workload: "w", side: "builtin", runid: "r2", label: "node-builtin", ok: true, rss_kib: 1100 },
    { workload: "w", side: "native", runid: "rX", label: "piread", ok: false, error: "x" },
  ];
  const agg = aggregate(rows);
  t("aggregate native p50", agg.perWorkload.w.native.p50 === 200);
  t("aggregate native min/max", agg.perWorkload.w.native.min === 100 && agg.perWorkload.w.native.max === 300);
  // runid medians: r1 -> 150, r2 -> 300 → spread (300-150)/150 = 100%
  t("aggregate rerun spread", r1(agg.perWorkload.w.native.spreadPct) === 100);
  // builtin p50 = 1000 (r1: 1000, r2: 1100 → all-run median of [1000,1000,1100] = 1000)
  t("aggregate delta", agg.deliverableRows[0].delta === "5.0x"); // 1000/200
  t("aggregate summary runs", agg.summary.runs === 3);
  t("aggregate skips failed rows", agg.perWorkload.w.native.runs === 3);

  if (!existsSync(GNU_TIME)) {
    t("GNU time available", false);
  } else {
    const live = await runMeasured([process.execPath, "-e", "process.exit(0)"], null);
    t("live time -v nonzero rss", live.ok && live.rss_kib > 0);
  }

  console.log(fails === 0 ? "selftest OK" : `selftest FAILED (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

// ---------- bench ----------
function parseArgs(argv) {
  const mode = argv.includes("--selftest")
    ? "selftest"
    : argv.includes("--smoke")
      ? "smoke"
      : argv.includes("--full")
        ? "full"
        : null;
  let tag = null;
  const ti = argv.indexOf("--tag");
  if (ti !== -1 && argv[ti + 1]) tag = argv[ti + 1];
  return { mode, tag };
}

async function main() {
  const { mode, tag } = parseArgs(process.argv.slice(2));
  if (!mode) {
    console.error("usage: bench.mjs --selftest | (--smoke|--full) [--tag <name>]");
    process.exit(2);
  }
  if (mode === "selftest") return selftest();

  // GNU time must exist and work — this arm's whole method depends on it.
  if (!existsSync(GNU_TIME)) {
    console.error(`fatal: ${GNU_TIME} not found (GNU time -v is required)`);
    process.exit(1);
  }
  const probe = await runMeasured([process.execPath, "-e", "process.exit(0)"], null);
  if (!probe.ok) {
    console.error(`fatal: /usr/bin/time -v probe failed: ${probe.error}`);
    process.exit(1);
  }
  const verRes = await measure({ argv: [GNU_TIME, "--version"] });
  const gnuTimeVersion = verRes.stderr.split("\n")[0]?.trim() || "GNU time";

  const bins = {
    read: process.env.PI_READ_BIN || DEFAULT_BIN.read,
    bash: process.env.PI_BASH_BIN || DEFAULT_BIN.bash,
    write: process.env.PI_WRITE_BIN || DEFAULT_BIN.write,
  };
  for (const [k, b] of Object.entries(bins)) {
    if (!existsSync(b)) {
      console.error(`fatal: native binary for ${k} not found: ${b}`);
      process.exit(1);
    }
  }
  if (!existsSync(process.env.PI_DIST_TOOLS || DIST_TOOLS)) {
    console.error(`[warn] builtin dist tools dir not found — drivers will use node-core replicas`);
  }

  const cfg =
    mode === "smoke"
      ? { warmup: 0, measured: 2 }
      : { warmup: 1, measured: 5 };

  const date = todayStr();
  const runid = `${date}${new Date().toISOString().slice(11, 19).replace(/:/g, "")}-${randomBytes(4).toString("hex")}`;
  const suffix = tag ? `-${tag}` : "";
  const resultsPath = path.join(RESULTS_DIR, `results-${date}${suffix}.ndjson`);
  const summaryPath = path.join(RESULTS_DIR, `summary-${date}${suffix}.md`);

  await rm(TMP_ROOT, { recursive: true, force: true });
  const tmpRun = path.join(TMP_ROOT, runid);
  await mkdir(tmpRun, { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });
  const append = async (obj) => appendFile(resultsPath, JSON.stringify(obj) + "\n", "utf8");

  console.log(`[rss-arm] mode=${mode} tag=${tag ?? "-"} runid=${runid}`);
  console.log(`[rss-arm] fixtures…`);
  const corpusPath = path.join(tmpRun, "corpus.txt");
  await buildCorpus(corpusPath);
  const contentPath = path.join(tmpRun, "content-100mb.bin");
  await writeFile(contentPath, genBytes(WRITE_BYTES));
  const corpusStat = await stat(corpusPath);
  const expectLine = corpusLine(READ_OFFSET - 1);
  console.log(
    `[rss-arm] corpus ${r1(corpusStat.size / 1024 / 1024)} MB (${CORPUS_LINES} lines), write payload ${r1(WRITE_BYTES / 1024 / 1024)} MB`
  );

  const driverArg = (op, extra) =>
    JSON.stringify({ op, distTools: process.env.PI_DIST_TOOLS || DIST_TOOLS, cwd: REPO, ...extra });

  // workloads: [name, native argv builder, native stdin file, builtin driver arg]
  const WORKLOADS = [
    {
      id: "read-window",
      native: () => ({
        argv: [bins.read, "--path", corpusPath, "--offset", String(READ_OFFSET), "--limit", String(READ_LIMIT)],
        stdinFile: null,
        verify: (s) => s.includes(`"ok":true`) && s.includes(expectLine.slice(0, 40)),
      }),
      builtin: () => ({
        argv: [process.execPath, DRIVER, driverArg("read-window", { path: corpusPath, offset: READ_OFFSET, limit: READ_LIMIT, expect: expectLine.slice(0, 40) })],
        stdinFile: null,
        verify: (s) => s.includes(`"ok":true`),
      }),
    },
    {
      id: "bash-seq",
      native: () => ({
        argv: [bins.bash, "--command", `seq 1 ${SEQ_LAST}`],
        stdinFile: null,
        verify: (s) => s.includes(`"ok":true`) && s.includes(`${SEQ_LAST}"`),
      }),
      builtin: () => ({
        argv: [process.execPath, DRIVER, driverArg("bash-seq", { last: SEQ_LAST })],
        stdinFile: null,
        verify: (s) => s.includes(`"ok":true`),
      }),
    },
    {
      id: "write-100mb",
      native: () => {
        const f = path.join(tmpRun, "native-out.bin");
        return {
          argv: [bins.write, "--path", f],
          stdinFile: contentPath,
          verify: (s) => s.includes(`"ok":true`),
          cleanup: f,
        };
      },
      builtin: () => {
        const f = path.join(tmpRun, "builtin-out.bin");
        return {
          argv: [process.execPath, DRIVER, driverArg("write-big", { path: f, contentPath, bytes: WRITE_BYTES })],
          stdinFile: null,
          verify: (s) => s.includes(`"ok":true`),
          cleanup: f,
        };
      },
    },
  ];

  for (const w of WORKLOADS) {
    console.log(`[rss-arm] workload=${w.id} warmup=${cfg.warmup} measured=${cfg.measured}`);
    for (let i = 0; i < cfg.warmup; i++) {
      for (const side of ["native", "builtin"]) {
        const spec = w[side]();
        const r = await runMeasured(spec.argv, spec.stdinFile);
        if (!r.ok || !spec.verify(r.stdout)) {
          console.error(`[warn] ${w.id} ${side} warmup failed: ${r.ok ? r.error || "verify" : r.error}`);
        }
      }
    }
    for (let round = 0; round < cfg.measured; round++) {
      for (const side of ["native", "builtin"]) {
        const spec = w[side]();
        const r = await runMeasured(spec.argv, spec.stdinFile);
        let ok = r.ok;
        let error = r.ok ? null : r.error;
        if (ok && !spec.verify(r.stdout)) {
          ok = false;
          error = "output verification failed";
        }
        if (ok && spec.cleanup) {
          const st = await stat(spec.cleanup).catch(() => null);
          if (!st || st.size !== WRITE_BYTES) {
            ok = false;
            error = `output file size ${st ? st.size : "missing"} != ${WRITE_BYTES}`;
          }
          await rm(spec.cleanup, { force: true }).catch(() => {});
        }
        let label = side === "native" ? path.basename(w.native().argv[0]) : null;
        if (side === "builtin" && ok) {
          try {
            const line = r.stdout.trim().split("\n").pop();
            label = JSON.parse(line).label || "node-builtin";
          } catch {
            label = "node-unknown";
          }
        }
        if (side === "builtin" && !ok) label = label || "node-builtin";
        await append({
          ts: nowIso(),
          runid,
          mode,
          tag,
          workload: w.id,
          side,
          label,
          round,
          warmup: false,
          ok,
          ...(ok ? { rss_kib: r.rss_kib, wall_ms: r.wall_ms } : { error }),
        });
        console.log(
          `  ${side.padEnd(7)} round=${round} ${ok ? `rss=${r.rss_kib} KiB wall=${r3((r.wall_ms ?? 0) / 1000)}s` : `FAILED (${error})`}`
        );
      }
    }
  }

  // aggregate over the whole results file (all invocations, incl. earlier ones)
  const raw = await readFile(resultsPath, "utf8");
  const rows = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const agg = aggregate(rows);

  await writeFile(
    summaryPath,
    writeSummaryMd(agg, {
      date,
      mode,
      tag,
      gnuTimeVersion,
      bins,
      warmup: cfg.warmup,
      measured: cfg.measured,
    }),
    "utf8"
  );
  const deliverable = [...agg.deliverableRows.map(JSON.stringify), JSON.stringify(agg.summary)].join("\n") + "\n";
  await writeFile(DELIVERABLE, deliverable, "utf8");

  console.log(`[rss-arm] results: ${resultsPath} (${rows.length} rows total)`);
  console.log(`[rss-arm] summary: ${summaryPath}`);
  console.log(`[rss-arm] deliverable: ${DELIVERABLE}`);
  for (const d of agg.deliverableRows) {
    console.log(`  ${d.workload}: native ${d.native_rss_kib} KiB vs builtin ${d.builtin_rss_kib} KiB → ${d.delta}`);
  }
  console.log(`  summary: runs=${agg.summary.runs} median_spread_pct=${agg.summary.median_spread_pct}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
