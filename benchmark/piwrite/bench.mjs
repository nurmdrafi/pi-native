#!/usr/bin/env node
// benchmark/piwrite/bench.mjs — harness comparing the pi built-in write tool
// (in-process node) against the native Rust `piwrite` binary.
//
// Modes:
//   node bench.mjs --selftest   validate harness logic against shim/piwrite-shim.mjs
//   node bench.mjs --smoke      quick run: 4KB only, 2 measured rounds, all arms
//   node bench.mjs --full       all sizes; 3 warmup + 10 measured rounds per
//                               (arm, size); 100MB units run 1 warmup + 2 measured
//   Bench modes also accept --tag <name>: results go to
//   results/results-<date>-<tag>.ndjson and summary-<date>-<tag>.md, every row
//   gains a "tag" field, and resume skips on mode+arm+size+tag (untagged runs
//   keep the original untagged file names).
//
// Arms:
//   A1 node-builtin        real built-in write tool, imported in-process from
//                          PI_WRITE_BUILTIN (default: pi-coding-agent dist
//                          write.js). If the module cannot be driven in-process,
//                          falls back to an exact replica of its fs calls
//                          (mkdir recursive, then writeFile utf-8) and is
//                          labelled "node-core-equivalent" in all results.
//   A2 piwrite-oneshot     spawn `piwrite --path <p>` per op, content as raw
//                          bytes on stdin
//   A3 piwrite-serve       one persistent `piwrite --serve` child per unit,
//                          length-prefixed frames (header line + raw bytes) fed
//                          asynchronously in bounded batches, every
//                          {"ok":true} response verified
//
// Frozen piwrite contract (do not deviate):
//   one-shot: `piwrite --path <p>`; content = raw bytes on stdin; success =
//             exit 0 + one NDJSON line {"ok":true,"path":...,"bytes":N}; failure
//             = exit !=0 + {"ok":false,"error":...}
//   daemon:   `piwrite --serve` (v2, length-prefixed framing): request = one
//             header line {"path":"...","bytes":<u64>}\n followed immediately by
//             exactly `bytes` raw body bytes (binary-safe, no trailing newline);
//             response {"ok":true,"path":...,"bytes":N}\n per request; malformed
//             header -> {"ok":false,...} + exit 1; EOF mid-body ->
//             {"ok":false,"error":"truncated body"} + exit 0; EOF at a request
//             boundary -> exit 0
//   binary:   env PI_WRITE_BIN, default <repo>/bin/piwrite
//
// Sizing: 4KB / 1MB / 16MB / 100MB of deterministic pseudorandom printable
// content (JSON-safe alphabet, no '"' or '\'). For sizes < 16MB, ops/round is
// chosen adaptively (5 timed probe ops, then enough ops that a round takes
// >= ~75ms, so comfortably over the 50ms floor). Any op or child exceeding
// 120s is killed and recorded as {"aborted":true,...}; the run continues.
//
// Results: one NDJSON line per completed (arm, size, round) appended to
// results/results-<YYYY-MM-DD>[-<tag>].ndjson as it lands (a rerun skips units
// whose measured rounds are already recorded — never restart blind). At the end
// a per-(arm, size) table plus speedup verdicts is written to
// results/summary-<YYYY-MM-DD>[-<tag>].md.
//
// Plain node ESM, no dependencies. Fixture writes land in tmp/<runid>/ (the
// tmp/ tree is wiped at run start).

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------- constants ----------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const RESULTS_DIR = path.join(HERE, "results");
const TMP_ROOT = path.join(HERE, "tmp");
const SHIM_PATH = path.join(HERE, "shim", "piwrite-shim.mjs");
const DEFAULT_BIN = path.join(REPO, "bin", "piwrite");
const BUILTIN_DEFAULT =
  "/home/nurmdrafi/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";

const KB = 1024;
const MB = 1024 * 1024;
const ALL_SIZES = [4 * KB, 1 * MB, 16 * MB, 100 * MB];
const BIG_SIZE = 100 * MB;
const ADAPTIVE_MAX_SIZE = 16 * MB; // adaptive batching only below this
const OP_TIMEOUT_MS = 120_000;
const ROUND_TARGET_MS = 75; // round floor is 50ms; target 75ms for margin
const PROBE_OPS = 5;
const MAX_OPS_PER_ROUND = 5000;
const MAX_FILES = 8; // rotating fixture paths per unit
const MAX_ABORTED_ROUNDS = 3;

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (x) => Math.round(x * 1000) / 1000;
const abortErr = (msg) => Object.assign(new Error(msg), { aborted: true });

function sizeLabel(n) {
  if (n % MB === 0) return `${n / MB}MB`;
  if (n % KB === 0) return `${n / KB}KB`;
  return `${n}B`;
}

function usage() {
  process.stderr.write(
    [
      "usage: node bench.mjs --selftest | --smoke | --full [--tag <name>]",
      "  --selftest  validate harness against shim/piwrite-shim.mjs (no piwrite binary needed)",
      "  --smoke     quick run: 4KB only, 2 measured rounds, all arms",
      "  --full      4KB/1MB/16MB/100MB; 3 warmup + 10 measured rounds (100MB: 1 + 2)",
      "  --tag NAME  suffix results/summary files with -NAME; rows gain a tag field",
      "              (resume skips on mode+arm+size+tag; default: untagged file names)",
      "env: PI_WRITE_BIN (default <repo>/bin/piwrite), PI_WRITE_BUILTIN (baseline write.js)",
      "",
    ].join("\n"),
  );
}

// ---------- deterministic content ----------
// Printable ASCII minus '"' (34) and '\' (92): the content passes through every
// arm unchanged — a JS string for the in-process builtin (A1), raw buffers for
// one-shot and daemon (A2/A3) — so all arms write identical bytes.
const PRINTABLE = [];
for (let b = 32; b <= 126; b++) if (b !== 34 && b !== 92) PRINTABLE.push(b);

function genBytes(n) {
  const out = Buffer.allocUnsafe(n);
  let x = 0x12345678;
  for (let i = 0; i < n; i++) {
    // xorshift32; `>>>= 0` keeps the state an unsigned uint32 (JS `^` returns
    // a signed int32, and a negative state would index PRINTABLE out of range)
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = PRINTABLE[x % PRINTABLE.length];
  }
  return out;
}

let _big = null;
function contentBytes(size) {
  if (!_big) _big = genBytes(BIG_SIZE);
  return _big.subarray(0, size);
}

const _strCache = new Map();
function contentStr(size) {
  let s = _strCache.get(size);
  if (s === undefined) {
    s = contentBytes(size).toString("utf8");
    _strCache.set(size, s);
  }
  return s;
}

// v2 serve framing: (file) -> header line {"path":...,"bytes":N}\n as a Buffer
// (cached per file; units rotate a handful of fixture paths); the body follows
// as exactly N raw buffer bytes, so content is never JSON-stringified.
function headerFor(size) {
  const cache = new Map();
  return (file) => {
    let b = cache.get(file);
    if (b === undefined) {
      b = Buffer.from(`{"path":${JSON.stringify(file)},"bytes":${size}}\n`, "utf8");
      cache.set(file, b);
    }
    return b;
  };
}

// ---------- metrics ----------
function metricsFromSamples(samples, sizeBytes) {
  const ops = samples.length;
  if (!ops) return { ops: 0, totalMs: 0, minMs: 0, p50Ms: 0, maxMs: 0, mbps: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = samples.reduce((a, b) => a + b, 0);
  const mid = sorted.length >> 1;
  const p50 = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mbps = totalMs > 0 ? (ops * sizeBytes) / 1e6 / (totalMs / 1000) : 0;
  return {
    ops,
    totalMs: r3(totalMs),
    minMs: r3(sorted[0]),
    p50Ms: r3(p50),
    maxMs: r3(sorted[sorted.length - 1]),
    mbps: r3(mbps),
  };
}

function opsFor(avgMs) {
  return Math.max(1, Math.min(MAX_OPS_PER_ROUND, Math.ceil(ROUND_TARGET_MS / Math.max(avgMs, 0.001))));
}

function withTimeout(promise, ms, makeErr) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(makeErr()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const timeIt = async (fn) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

// ---------- binary resolution ----------
function resolveBin() {
  const fromEnv = process.env.PI_WRITE_BIN;
  const p = fromEnv ? path.resolve(fromEnv) : DEFAULT_BIN;
  if (/\.(mjs|cjs|js)$/i.test(p)) return { cmd: process.execPath, args: [p], path: p };
  return { cmd: p, args: [], path: p };
}

// ---------- arm A2: one-shot child per op ----------
function runOneShot(bin, file, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, [...bin.args, "--path", file], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errTxt = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(reject, abortErr(`oneshot timeout >${OP_TIMEOUT_MS}ms`));
    }, OP_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      errTxt += d;
    });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => {
      const lines = out.split("\n").filter((l) => l.trim());
      const last = lines[lines.length - 1];
      let resp = null;
      try {
        resp = last ? JSON.parse(last) : null;
      } catch {
        resp = null;
      }
      if (
        code === 0 &&
        resp &&
        resp.ok === true &&
        resp.bytes === bytes.length &&
        (resp.path === undefined || resp.path === file)
      ) {
        finish(resolve, resp);
      } else {
        finish(
          reject,
          new Error(
            `oneshot failed code=${code} stdout=${out.trim().slice(0, 160)} stderr=${errTxt.trim().slice(0, 160)}`,
          ),
        );
      }
    });
    child.stdin.on("error", () => {}); // EPIPE if the child dies before consuming stdin
    child.stdin.end(bytes);
  });
}

// ---------- arm A3: persistent daemon ----------
const DAEMONS = new Set();

class Daemon {
  constructor(bin) {
    this.bin = bin;
    this.child = null;
    this.dead = null;
    this.eof = false;
    this.buf = "";
    this.queue = [];
    this.waiters = [];
    this.exitPromise = null;
  }

  async start() {
    const child = spawn(this.bin.cmd, [...this.bin.args, "--serve"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exitPromise = new Promise((resolve) => child.once("exit", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this.onData(d));
    child.stdout.on("end", () => {
      this.eof = true;
      this.release();
    });
    child.stdout.on("error", () => {
      this.eof = true;
      this.release();
    });
    child.stdin.on("error", () => {}); // EPIPE tolerance; dead-checks surface the real error
    child.on("error", (e) => {
      this.dead = this.dead || { code: null, signal: null, error: String(e) };
      this.eof = true;
      this.release();
    });
    child.on("exit", (code, signal) => {
      this.dead = { code, signal };
      this.eof = true;
      this.release();
    });
    DAEMONS.add(this);
    return this;
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = { ok: false, error: "unparseable response line" };
      }
      const w = this.waiters.shift();
      if (w) w({ value: obj });
      else this.queue.push(obj);
    }
  }

  release() {
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined, eof: true });
  }

  nextResponse(timeoutMs = OP_TIMEOUT_MS) {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift() });
    if (this.eof || this.dead) return Promise.resolve({ value: undefined, eof: true });
    return new Promise((resolve) => {
      let w;
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ value: undefined, timeout: true });
      }, timeoutMs);
      w = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push(w);
    });
  }

  async send(header, body) {
    if (this.dead || this.eof) throw abortErr(`daemon not writable (dead=${JSON.stringify(this.dead)})`);
    if (!this.child.stdin.write(header)) await this.drain();
    if (!this.child.stdin.write(body)) await this.drain();
  }

  drain() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        reject(abortErr("daemon stdin drain timeout"));
      }, OP_TIMEOUT_MS);
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onErr = (err) => {
        cleanup();
        reject(abortErr("daemon stdin error: " + err.message));
      };
      const onExit = () => {
        cleanup();
        reject(abortErr("daemon exited during send"));
      };
      const cleanup = () => {
        clearTimeout(t);
        this.child.stdin.off("drain", onDrain);
        this.child.stdin.off("error", onErr);
        this.child.off("exit", onExit);
      };
      this.child.stdin.on("drain", onDrain);
      this.child.stdin.on("error", onErr);
      this.child.on("exit", onExit);
    });
  }

  kill() {
    DAEMONS.delete(this);
    if (this.child && !this.dead) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }
  }

  // Graceful stop: end stdin (EOF), expect the contract's "exits at EOF".
  async stop() {
    if (!this.child) return;
    if (!this.dead) {
      try {
        this.child.stdin.end();
      } catch {}
      await Promise.race([this.exitPromise, sleep(5000)]);
      if (!this.dead) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
        await this.exitPromise;
      }
    }
    DAEMONS.delete(this);
  }
}

function killAllDaemons() {
  for (const d of [...DAEMONS]) d.kill();
}

async function killAllDaemonsAsync() {
  await Promise.allSettled([...DAEMONS].map((d) => d.stop()));
}

// One round against the daemon: requests are sent asynchronously (libuv
// backpressure; the event loop — and with it the 120s op timeouts — stays
// alive) in batches of at most SEND_BATCH in-flight frames, awaiting each
// batch's responses before the next batch is sent. The batch bound caps how
// many response lines (~80B each) can pile up unread in the daemon's stdout
// pipe. Per-op latency is not individually observable within a batch, so each
// op gets the batch's amortized per-op time; min/p50/max then reflect
// batch-to-batch variation.
const SEND_BATCH = 256;

async function serveRound(d, files, ops, mkHeader, contentBuf, sizeBytes) {
  const t0 = performance.now();
  const batch = Math.max(1, Math.min(ops, SEND_BATCH));
  const samples = [];
  let sent = 0;
  while (sent < ops) {
    const n = Math.min(batch, ops - sent);
    const bt0 = performance.now();
    try {
      for (let i = 0; i < n; i++) await d.send(mkHeader(files[(sent + i) % files.length]), contentBuf);
    } catch (e) {
      d.kill();
      throw e;
    }
    for (let i = 0; i < n; i++) {
      const r = await d.nextResponse();
      if (r.timeout) {
        d.kill();
        throw abortErr(`response timeout in batch at ${sent + i}/${ops}`);
      }
      if (r.eof) {
        d.kill();
        throw abortErr(`daemon exited after ${sent + i}/${ops} responses (dead=${JSON.stringify(d.dead)})`);
      }
      const v = r.value;
      if (!v || v.ok !== true || (v.bytes !== undefined && v.bytes !== sizeBytes)) {
        d.kill();
        throw abortErr(`bad response at ${sent + i}/${ops}: ${JSON.stringify(v).slice(0, 160)}`);
      }
    }
    const per = (performance.now() - bt0) / n;
    for (let i = 0; i < n; i++) samples.push(per);
    sent += n;
  }
  const totalMs = performance.now() - t0;
  return { samples, totalMs };
}

// ---------- arm A1: built-in write tool in-process ----------
async function loadBuiltin() {
  const src = process.env.PI_WRITE_BUILTIN || BUILTIN_DEFAULT;
  // Exact replica of the built-in's fs calls and ordering, used only if the
  // real module cannot be driven in-process.
  const replicate = async (file, content) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  };
  try {
    if (!existsSync(src)) throw new Error(`builtin source not found: ${src}`);
    const mod = await import(pathToFileURL(src).href);
    const factory = mod.createWriteToolDefinition;
    if (typeof factory !== "function") throw new Error("export createWriteToolDefinition not found");
    const tool = factory(REPO, undefined);
    const execute = tool && tool.execute;
    if (typeof execute !== "function") throw new Error("tool definition has no execute()");
    // Probe once (untimed) to prove the call shape works end-to-end.
    const probeFile = path.join(TMP_ROOT, `builtin-probe-${randomUUID().slice(0, 8)}.txt`);
    const res = await execute("piwrite-bench-probe", { path: probeFile, content: "piwrite-bench-probe" }, undefined, undefined, { cwd: REPO });
    const written = await readFile(probeFile, "utf8").catch(() => null);
    if (written !== "piwrite-bench-probe") {
      throw new Error(`probe mismatch (res=${JSON.stringify(res).slice(0, 140)})`);
    }
    return {
      label: "node-builtin",
      write: async (file, content) => {
        await execute("piwrite-bench", { path: file, content }, undefined, undefined, { cwd: REPO });
      },
    };
  } catch (e) {
    console.error(`[warn] A1 falling back to node-core-equivalent: ${String((e && e.message) || e).slice(0, 200)}`);
    return { label: "node-core-equivalent", write: replicate };
  }
}

// ---------- unit runner ----------
function roundsFor(cfg, size) {
  return size >= BIG_SIZE ? { warmup: cfg.bigWarmup, measured: cfg.bigMeasured } : { warmup: cfg.warmup, measured: cfg.measured };
}

async function runUnit({ mode, tag, runid, arm, size, cfg, bin, builtin, append }) {
  const rounds = roundsFor(cfg, size);
  const dir = path.join(TMP_ROOT, runid, arm.id, sizeLabel(size));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = Array.from({ length: MAX_FILES }, (_, i) => path.join(dir, `f${i}.bin`));
  const bytes = contentBytes(size);
  const str = arm.id === "A1" ? contentStr(size) : null; // only the builtin arm takes a string
  const mkHeader = headerFor(size);
  let opSeq = 0;
  let daemon = null;
  const aborted = { n: 0 };
  const ensureDaemon = async () => {
    if (!daemon || daemon.dead) {
      daemon = new Daemon(bin);
      await daemon.start();
    }
    return daemon;
  };

  try {
    const doOp = () => {
      const file = files[opSeq++ % MAX_FILES];
      const p =
        arm.id === "A1"
          ? timeIt(() => builtin.write(file, str))
          : timeIt(() => runOneShot(bin, file, bytes));
      return withTimeout(p, OP_TIMEOUT_MS, () => abortErr(`op timeout >${OP_TIMEOUT_MS}ms`));
    };

    const runRound = async (ops) => {
      if (arm.id === "A3") {
        const d = await ensureDaemon();
        return serveRound(d, files, ops, mkHeader, bytes, size);
      }
      const samples = [];
      for (let i = 0; i < ops; i++) samples.push(await doOp());
      return { samples, totalMs: samples.reduce((a, b) => a + b, 0) };
    };

    // Adaptive ops/round: time 5 probe ops, then batch so a round clears the
    // 50ms floor (target 75ms). Sizes >= 16MB run 1 op per round.
    let opsPerRound = 1;
    if (size < ADAPTIVE_MAX_SIZE) {
      if (arm.id === "A3") {
        const d = await ensureDaemon();
        const pr = await serveRound(d, files, PROBE_OPS, mkHeader, bytes, size);
        opsPerRound = opsFor(pr.totalMs / PROBE_OPS);
      } else {
        const t = [];
        for (let i = 0; i < PROBE_OPS; i++) t.push(await doOp());
        opsPerRound = opsFor(t.reduce((a, b) => a + b, 0) / PROBE_OPS);
      }
    }

    for (let r = 0; r < rounds.warmup; r++) {
      try {
        await runRound(opsPerRound);
      } catch (e) {
        if (!e.aborted) throw e;
        aborted.n++;
        if (aborted.n >= MAX_ABORTED_ROUNDS) throw e;
      }
    }

    const unitSamples = [];
    let done = 0;
    for (let r = 0; r < rounds.measured; r++) {
      try {
        const rr = await runRound(opsPerRound);
        const m = metricsFromSamples(rr.samples, size);
        unitSamples.push(...rr.samples);
        done = r + 1;
        await append({
          ts: nowIso(),
          runid,
          mode,
          tag: tag ?? null,
          arm: arm.id,
          label: arm.label,
          size,
          sizeLabel: sizeLabel(size),
          round: r,
          ops: rr.samples.length,
          opsPerRound,
          warmup: false,
          ...m,
          samples: rr.samples.map(r3),
        });
      } catch (e) {
        if (!e.aborted) throw e;
        aborted.n++;
        await append({
          ts: nowIso(),
          runid,
          mode,
          tag: tag ?? null,
          arm: arm.id,
          label: arm.label,
          size,
          round: r,
          aborted: true,
          reason: String((e && e.message) || e).slice(0, 200),
          opsPerRound,
        });
        if (aborted.n >= MAX_ABORTED_ROUNDS) break;
      }
    }

    let verify = "ok";
    try {
      const st = await stat(files[0]);
      if (st.size !== size) verify = `size-mismatch(${st.size})`;
    } catch {
      verify = "stat-failed";
    }

    if (unitSamples.length) {
      const m = metricsFromSamples(unitSamples, size);
      console.log(
        `[unit] mode=${mode} arm=${arm.id}(${arm.label}) size=${sizeLabel(size)} rounds=${done}/${rounds.measured} ops=${m.ops} p50=${m.p50Ms}ms min=${m.minMs}ms max=${m.maxMs}ms total=${m.totalMs}ms mbps=${m.mbps} opsPerRound=${opsPerRound} abortedRounds=${aborted.n} verify=${verify}`,
      );
    } else {
      console.log(
        `[unit] mode=${mode} arm=${arm.id}(${arm.label}) size=${sizeLabel(size)} ABORTED rounds=0/${rounds.measured} opsPerRound=${opsPerRound}`,
      );
    }
  } finally {
    if (daemon) await daemon.stop().catch(() => {});
  }
}

// ---------- results ----------
function makeAppender(file) {
  return async (obj) => {
    await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
  };
}

async function loadCompleted(mode, tag, resultsFile) {
  const counts = new Map();
  let txt = "";
  try {
    txt = await readFile(resultsFile, "utf8");
  } catch {
    return counts;
  }
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.mode !== mode || (o.tag ?? null) !== (tag ?? null) || o.aborted || o.warmup !== false) continue;
    const k = `${o.mode}|${o.arm}|${o.size}|${o.tag ?? ""}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

async function writeSummary(dateStr, tag) {
  const resultsFile = path.join(RESULTS_DIR, `results-${dateStr}${tag ? `-${tag}` : ""}.ndjson`);
  const recs = [];
  try {
    for (const l of (await readFile(resultsFile, "utf8")).split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o && !o.aborted && o.warmup === false) recs.push(o);
      } catch {}
    }
  } catch {}

  const groups = new Map();
  for (const o of recs) {
    const k = `${o.mode}|${o.arm}|${o.size}`;
    if (!groups.has(k)) groups.set(k, { mode: o.mode, arm: o.arm, size: o.size, label: o.label, rounds: 0, ops: 0, samples: [] });
    const g = groups.get(k);
    g.rounds++;
    g.ops += o.ops ?? 0;
    if (o.label) g.label = o.label;
    if (Array.isArray(o.samples)) g.samples.push(...o.samples);
  }

  const md = [];
  md.push(`# piwrite benchmark summary — ${dateStr}`, "");
  md.push(`- generated: ${nowIso()}`);
  md.push(`- node: ${process.version}`);
  md.push(`- PI_WRITE_BIN: ${process.env.PI_WRITE_BIN ?? `<unset; default ${DEFAULT_BIN}>`}`);
  md.push(`- tag: ${tag ?? "none"}`);
  md.push("");

  const verdicts = [];
  for (const mode of [...new Set(recs.map((r) => r.mode))].sort()) {
    md.push(`## mode=${mode}`, "");
    for (const size of ALL_SIZES) {
      const rows = ["A1", "A2", "A3"].map((a) => groups.get(`${mode}|${a}|${size}`)).filter(Boolean);
      if (!rows.length) continue;
      md.push(`### ${sizeLabel(size)}`, "");
      md.push("| arm | label | rounds | ops | min ms/op | p50 ms/op | max ms/op | MB/s |");
      md.push("|---|---|---|---|---|---|---|---|");
      const byArm = {};
      for (const g of rows) {
        const m = metricsFromSamples(g.samples, g.size);
        byArm[g.arm] = { m, g };
        md.push(`| ${g.arm} | ${g.label} | ${g.rounds} | ${g.ops} | ${m.minMs} | ${m.p50Ms} | ${m.maxMs} | ${m.mbps} |`);
      }
      md.push("");
      const a1 = byArm.A1;
      const a3 = byArm.A3;
      if (a1 && a3 && a1.m.p50Ms > 0 && a3.m.p50Ms > 0) {
        const p50x = r3(a1.m.p50Ms / a3.m.p50Ms);
        const mbx = a1.m.mbps > 0 && a3.m.mbps > 0 ? `${r3(a3.m.mbps / a1.m.mbps)}x` : "n/a";
        const v = `verdict ${sizeLabel(size)} [mode=${mode}${tag ? ` tag=${tag}` : ""}]: piwrite-serve vs ${a1.g.label} — p50 ${a3.m.p50Ms}ms vs ${a1.m.p50Ms}ms → ${p50x}x faster; throughput ${a3.m.mbps} vs ${a1.m.mbps} MB/s → ${mbx}`;
        md.push(v, "");
        verdicts.push(v);
      }
    }
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const summaryPath = path.join(RESULTS_DIR, `summary-${dateStr}${tag ? `-${tag}` : ""}.md`);
  await writeFile(summaryPath, md.join("\n") + "\n", "utf8");
  return { summaryPath, verdicts };
}

// ---------- selftest ----------
async function selftest() {
  const results = [];
  const check = (name, cond, extra) => {
    const ok = !!cond;
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined ? ` — ${String(extra).slice(0, 160)}` : ""}`);
  };
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      check(name, false, String((e && e.message) || e));
    }
  };
  const bin = { cmd: process.execPath, args: [SHIM_PATH], path: SHIM_PATH };

  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(path.join(TMP_ROOT, "selftest"), { recursive: true });
  const dir = path.join(TMP_ROOT, "selftest");

  await section("shim exists", async () => {
    check("shim exists", existsSync(SHIM_PATH), SHIM_PATH);
  });

  await section("content generator", async () => {
    const a = genBytes(2048);
    const b = genBytes(2048);
    check("deterministic", a.equals(b));
    let bad = 0;
    for (const x of a) if (x < 32 || x > 126 || x === 34 || x === 92) bad++;
    check("printable JSON-safe alphabet", bad === 0, `${bad} bad bytes`);
  });

  await section("oneshot ok path", async () => {
    const f = path.join(dir, "one.bin");
    const buf = genBytes(4096);
    const resp = await runOneShot(bin, f, buf);
    check("response shape", resp.ok === true && resp.bytes === 4096 && resp.path === f, JSON.stringify(resp).slice(0, 120));
    const back = await readFile(f);
    check("file bytes match", back.equals(buf));
  });

  await section("oneshot failure path", async () => {
    const d = path.join(dir, "adir");
    await mkdir(d, { recursive: true });
    let rejected = false;
    let msg = "";
    try {
      await runOneShot(bin, d, genBytes(64));
    } catch (e) {
      rejected = true;
      msg = String((e && e.message) || e);
    }
    check("nonzero exit + ok:false rejects", rejected, msg);
  });

  let daemon = null;
  await section("daemon basics", async () => {
    daemon = await new Daemon(bin).start();
    const f1 = path.join(dir, "s1.txt");
    await daemon.send(Buffer.from(`{"path":${JSON.stringify(f1)},"bytes":5}\n`), Buffer.from("hello"));
    const r1 = await daemon.nextResponse(10_000);
    check("single response ok", r1.value && r1.value.ok === true && r1.value.bytes === 5, JSON.stringify(r1.value));
    check("file written", (await readFile(f1, "utf8")) === "hello");
    const paths = [0, 1, 2].map((i) => path.join(dir, `p${i}.txt`));
    const bodies = paths.map((_, i) => Buffer.from("x".repeat(10 + i), "utf8"));
    const headers = paths.map((p, i) => Buffer.from(`{"path":${JSON.stringify(p)},"bytes":${bodies[i].length}}\n`));
    for (let i = 0; i < 3; i++) await daemon.send(headers[i], bodies[i]);
    const got = [];
    for (let i = 0; i < 3; i++) {
      const r = await daemon.nextResponse(10_000);
      got.push(r.value);
    }
    check("pipelined 3 responses ok", got.every((g) => g && g.ok === true));
    check("response order preserved", JSON.stringify(got.map((g) => g && g.path)) === JSON.stringify(paths));
    check("pipelined file contents", (await readFile(paths[2], "utf8")) === "x".repeat(12));
  });

  await section("daemon EOF at boundary", async () => {
    if (!daemon) return check("exited at boundary", false, "no daemon from previous section");
    await daemon.stop();
    check("exited at boundary with code 0", !!daemon.dead && daemon.dead.code === 0, JSON.stringify(daemon.dead));
  });

  await section("daemon truncated body", async () => {
    const d2 = await new Daemon(bin).start();
    const f2 = path.join(dir, "trunc.txt");
    await d2.send(Buffer.from(`{"path":${JSON.stringify(f2)},"bytes":10}\n`), Buffer.from("abc"));
    d2.child.stdin.end();
    const r = await d2.nextResponse(10_000);
    check("truncated body answered ok:false", r.value && r.value.ok === false && r.value.error === "truncated body", JSON.stringify(r.value));
    await d2.exitPromise;
    check("truncated body exits 0", !!d2.dead && d2.dead.code === 0, JSON.stringify(d2.dead));
    d2.kill();
  });

  await section("daemon malformed header", async () => {
    const d3 = await new Daemon(bin).start();
    await d3.send(Buffer.from("not-json\n"), Buffer.alloc(0));
    const rv = await d3.nextResponse(10_000);
    check("malformed header answered ok:false", rv.value && rv.value.ok === false, JSON.stringify(rv.value));
    await d3.exitPromise;
    check("malformed header exits 1", !!d3.dead && d3.dead.code === 1, JSON.stringify(d3.dead));
    d3.kill();
  });

  await section("metrics math", async () => {
    const m = metricsFromSamples([2, 1, 3, 4], 4096);
    check("min/p50/max", m.minMs === 1 && m.p50Ms === 2.5 && m.maxMs === 4, JSON.stringify(m));
    const expectMbps = r3((4 * 4096) / 1e6 / (10 / 1000));
    check("mbps", m.mbps === expectMbps, `${m.mbps} vs ${expectMbps}`);
    const z = metricsFromSamples([], 4096);
    check("empty samples guarded", z.ops === 0 && z.p50Ms === 0, JSON.stringify(z));
  });

  await section("adaptive ops", async () => {
    check("floor 1", opsFor(80) === 1, opsFor(80));
    check("target scaling", opsFor(0.75) === 100, opsFor(0.75));
    check("cap", opsFor(0.001) === MAX_OPS_PER_ROUND, opsFor(0.001));
  });

  await section("withTimeout aborts", async () => {
    let aborted = false;
    try {
      await withTimeout(sleep(400), 50, () => abortErr("timeout"));
    } catch (e) {
      aborted = !!e.aborted;
    }
    check("timeout rejects aborted", aborted);
  });

  await section("ndjson appender round trip", async () => {
    const f = path.join(dir, "rt.ndjson");
    const append = makeAppender(f);
    await append({ a: 1 });
    await append({ b: "x" });
    const lines = (await readFile(f, "utf8")).split("\n").filter(Boolean);
    check("two lines parse", lines.length === 2 && JSON.parse(lines[0]).a === 1 && JSON.parse(lines[1]).b === "x");
  });

  await section("daemon frame headers", async () => {
    const mk = headerFor(64);
    const b = mk("/tmp/f");
    check("header cached as Buffer", Buffer.isBuffer(b) && b === mk("/tmp/f"));
    const o = JSON.parse(b.toString("utf8"));
    check("header shape", o.path === "/tmp/f" && o.bytes === 64 && b.toString("utf8").endsWith("\n"), JSON.stringify(b.toString("utf8")));
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`selftest: ${results.length - failed}/${results.length} checks passed`);
  return failed ? 1 : 0;
}

// ---------- bench modes ----------
async function runBench(mode, tag) {
  const cfg =
    mode === "--smoke"
      ? { sizes: [4 * KB], warmup: 1, measured: 2, bigWarmup: 1, bigMeasured: 2 }
      : { sizes: ALL_SIZES, warmup: 3, measured: 10, bigWarmup: 1, bigMeasured: 2 };
  const bin = resolveBin();
  if (!existsSync(bin.path)) {
    console.error(`piwrite binary not found: ${bin.path} (PI_WRITE_BIN=${process.env.PI_WRITE_BIN ?? "<unset>"}); arms A2/A3 cannot run`);
    return 2;
  }
  const dateStr = todayStr();
  const suffix = tag ? `-${tag}` : "";
  const resultsFile = path.join(RESULTS_DIR, `results-${dateStr}${suffix}.ndjson`);
  const runid = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}-${randomUUID().slice(0, 8)}`;
  await rm(TMP_ROOT, { recursive: true, force: true }); // wipe fixtures at run start
  await mkdir(path.join(TMP_ROOT, runid), { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });
  const append = makeAppender(resultsFile);
  const completed = await loadCompleted(mode, tag, resultsFile);
  const builtin = await loadBuiltin();
  const arms = [
    { id: "A1", label: builtin.label },
    { id: "A2", label: "piwrite-oneshot" },
    { id: "A3", label: "piwrite-serve" },
  ];
  console.log(`[run] mode=${mode} tag=${tag ?? "none"} runid=${runid} bin=${bin.path} builtin=${builtin.label} results=${resultsFile}`);

  try {
    for (const size of cfg.sizes) {
      for (const arm of arms) {
        const need = roundsFor(cfg, size).measured;
        const have = completed.get(`${mode}|${arm.id}|${size}|${tag ?? ""}`) ?? 0;
        if (have >= need) {
          console.log(`[skip] mode=${mode} arm=${arm.id} size=${sizeLabel(size)} — ${have}/${need} measured rounds already recorded`);
          continue;
        }
        try {
          await runUnit({ mode, tag, runid, arm, size, cfg, bin, builtin, append });
        } catch (e) {
          const reason = String((e && e.message) || e).slice(0, 200);
          console.error(`[unit] mode=${mode} arm=${arm.id} size=${sizeLabel(size)} ERROR ${reason}`);
          await append({ ts: nowIso(), runid, mode, tag: tag ?? null, arm: arm.id, label: arm.label, size, round: null, aborted: true, reason }).catch(() => {});
        }
      }
    }
  } finally {
    await killAllDaemonsAsync();
  }

  const { summaryPath, verdicts } = await writeSummary(dateStr, tag);
  console.log(`[summary] ${summaryPath}`);
  for (const v of verdicts) console.log(v);
  return 0;
}

function parseArgs(argv) {
  let mode = null;
  let tag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest" || a === "--smoke" || a === "--full") {
      if (mode) throw new Error("multiple mode flags given");
      mode = a;
    } else if (a === "--tag") {
      const v = argv[++i];
      if (v === undefined || !/^[A-Za-z0-9._-]+$/.test(v)) throw new Error("--tag needs a value matching [A-Za-z0-9._-]+");
      if (tag !== null) throw new Error("--tag given twice");
      tag = v;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!mode) throw new Error("missing mode flag (--selftest | --smoke | --full)");
  return { mode, tag };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    usage();
    return 2;
  }
  if (args.mode === "--selftest") return await selftest();
  return await runBench(args.mode, args.tag);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAllDaemons();
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
process.on("exit", killAllDaemons);

main().then(
  (rc) => process.exit(rc ?? 0),
  (e) => {
    console.error("fatal:", e);
    killAllDaemons();
    process.exit(1);
  },
);
