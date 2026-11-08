#!/usr/bin/env node
/**
 * Daemon-arm RSS probe for the frozen pibash release binary.
 *
 * Spawns `pibash --serve` (the NDJSON daemon; one JSON request per stdin
 * line, framing per rust-tools/pibash/src/serve.rs ServeRequest:
 * {id, command, cwd?, timeout?, env?, stream?}; response echoes id, ok),
 * dispatches `yes | head -c 104857600` with a large timeout and a temp
 * cwd, and polls /proc/<daemon-pid>/status VmRSS every 50 ms from dispatch
 * until the response line arrives plus 5 more seconds. Records
 * baseline/peak/rss_after_5s/elapsed, appends one NDJSON line to
 * /tmp/w1t3-rss.ndjson, kills the daemon explicitly, and exits 0.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "rust-tools", "target", "release", "pibash");
const OUT = "/tmp/w1t3-rss.ndjson";
const BYTES = 104857600;
const POLL_MS = 50;
const HOLD_S = 5;
const DEADLINE_MS = 300_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vmRssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

const tempDir = mkdtempSync(join(tmpdir(), "w1t3-rss-"));
const daemon = spawn(BIN, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
daemon.on("error", (err) => {
  console.error(`spawn failed: ${err.message}`);
  process.exit(1);
});

let stdoutBuf = "";
let responded = null;
daemon.stdout.setEncoding("utf8");
daemon.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) responded = msg;
    } catch {
      /* skip non-JSON noise */
    }
  }
});

try {
  await sleep(300); // let the daemon settle after exec before baseline
  const baseline = vmRssBytes(daemon.pid);
  const t0 = performance.now();

  // Request framing copied from serve.rs ServeRequest: id, command, cwd, timeout.
  daemon.stdin.write(
    JSON.stringify({ id: 1, command: "yes | head -c 104857600", cwd: tempDir, timeout: 600 }) + "\n",
  );

  let peak = baseline ?? 0;
  const deadline = Date.now() + DEADLINE_MS;
  while (!responded && Date.now() < deadline) {
    await sleep(POLL_MS);
    const rss = vmRssBytes(daemon.pid);
    if (rss != null && rss > peak) peak = rss;
  }
  if (!responded) throw new Error(`no response line within ${DEADLINE_MS / 1000} s`);
  const elapsed = (performance.now() - t0) / 1000;

  // Retention window: keep polling 5 s past the response line.
  for (let i = 0; i < (HOLD_S * 1000) / POLL_MS; i++) {
    await sleep(POLL_MS);
    const rss = vmRssBytes(daemon.pid);
    if (rss != null && rss > peak) peak = rss;
  }
  const after5 = vmRssBytes(daemon.pid);

  const row = {
    arm: "daemon",
    bytes: BYTES,
    rss_peak_bytes: peak,
    rss_after_5s_bytes: after5,
    elapsed_s: Number(elapsed.toFixed(3)),
  };
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  console.log(
    `daemon baseline=${baseline} B peak=${peak} B (${(peak / 1048576).toFixed(1)} MiB) ` +
      `after5s=${after5} B (${(after5 / 1048576).toFixed(1)} MiB) elapsed=${elapsed.toFixed(3)} s ok=${responded.ok}`,
  );
  console.log(`appended ${OUT}`);
} finally {
  daemon.kill("SIGKILL");
  await new Promise((r) => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) r();
    else daemon.once("exit", r);
  });
  rmSync(tempDir, { recursive: true, force: true });
}
process.exit(0);
