#!/usr/bin/env node
/**
 * pibash large-output bench — Step 8 of research/pibash-implementation-plan.md,
 * fixture spec research/pibash-large-output.md §4.
 *
 * Fixtures (deterministic generators, no checked-in files, no clocks):
 *   1 MB / 10 MB / 100 MB classes × three shapes —
 *     uniform   fixed-width numbered lines (awk BEGIN, exact byte math)
 *     giant     one huge line with no terminator (head -c /dev/zero | tr)
 *     stderr    half the bytes on stdout, half on stderr (single accumulator)
 *   plus the spec extras: `yes | head -c 104857600` (pure throughput),
 *   non-zero exit after 100 MB of chatter, and SIGTERM death mid-stream
 *   (the shell-portable stand-in for the panic-producer child).
 *
 * Two arms per fixture:
 *   daemon  — the production path: extension dispatch → persistent
 *             `bin/pibash --serve` daemon. Yields the model-visible metrics:
 *             envelope_bytes (content text), child_bytes (truncation.totalBytes),
 *             spill_bytes (stat of fullOutputPath), exit_code, wall ms.
 *   oneshot — `bin/pibash --command` under /usr/bin/time, isolated process:
 *             yields peak RSS (ru_maxrss; Linux -v reports KiB, macOS -l bytes,
 *             normalized by rssToBytes) and the wire JSON size.
 *
 * Assertions (default mode) pin CURRENT behavior, by design:
 *   - child_bytes is byte-exact against arithmetic expectations.
 *   - spill_bytes == child_bytes for every spilled fixture.
 *   - envelope_bytes <= ENVELOPE_CAP_BYTES — O(envelope), not O(child).
 *   - peak RSS <= RSS_CAP_BYTES[sizeClass] — the accumulator retains the raw
 *     stream while a spill file may still be needed, so RSS scales with output
 *     size by design; the caps record measured peaks + margin, they do NOT
 *     encode an O(1) goal. Fixing RSS is out of scope (docs/backlog.md §1).
 *
 * Constants are pinned from a `--measure` run (first green values + margin).
 *
 * Usage:
 *   node custom-tools/pibash/bench-large-output.mjs              # asserted
 *   node custom-tools/pibash/bench-large-output.mjs --measure    # print only
 *   node custom-tools/pibash/bench-large-output.mjs --sizes=1,10 # subset
 *
 * Writes benchmark/runs/pibash-large-output-<date>.md. Importable (the run
 * loop is behind a main-guard): tests/pibash-large-output.test.mjs reuses
 * FIXTURES + the measurement helpers for the 1 MB regression class.
 */
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin", "pibash");
const TIME_BIN = "/usr/bin/time";

/** Model-visible envelope budget (Tier-1 compression target, 40 lines / 2 KB).
 *  ENVELOPE_CAP_BYTES is the hard assertion cap. Derivation: compression-
 *  classified streams render at ≤ ~2.1 KB, but streams the classifier does
 *  not compress (e.g. `yes | head -c …`) fall through to the parity-locked
 *  legacy tail window — 2000 lines + truncation note ≈ 4.1 KB on 2-byte
 *  lines. 8 KB = 2× the measured maximum (yes-head-100mb). */
export const MODEL_BUDGET_BYTES = 2048;
export const ENVELOPE_CAP_BYTES = 8192;

/** Peak-RSS caps per size class (bytes), pinned from the first asserted run.
 *  These record current accumulator behavior (RSS ∝ output until spill),
 *  not a goal; regressions should raise them only with a measured report. */
export const RSS_CAP_BYTES = {
  1: 12 * 1024 * 1024,
  10: 64 * 1024 * 1024,
  100: 2 * 1024 * 1024 * 1024,
};

/** ru_maxrss unit normalization: Linux reports KiB, macOS reports bytes. */
export function rssToBytes(value, platform = process.platform) {
  return platform === "darwin" ? value : value * 1024;
}

// ---- fixture generators (deterministic, byte-exact) ----
const numbered = (lines) =>
  `awk 'BEGIN { for (i = 1; i <= ${lines}; i++) printf "%09d\\n", i }'`;
const giantLine = (bytes) => `head -c ${bytes} /dev/zero | tr '\\000' 'x'`;
const stderrMix = (linesEach) => `${numbered(linesEach)}; ${numbered(linesEach)} >&2`;

/** name · sizeClass (MB) · command · expectedChildBytes · expectedExit (null = just non-zero) */
export const FIXTURES = [
  { name: "uniform-1mb", sizeClass: 1, command: numbered(100_000), expectedChildBytes: 100_000 * 10, expectedExit: 0 },
  { name: "giant-1mb", sizeClass: 1, command: giantLine(1_048_576), expectedChildBytes: 1_048_576, expectedExit: 0 },
  { name: "stderr-mix-1mb", sizeClass: 1, command: stderrMix(50_000), expectedChildBytes: 1_000_000, expectedExit: 0 },
  { name: "uniform-10mb", sizeClass: 10, command: numbered(1_000_000), expectedChildBytes: 10_000_000, expectedExit: 0 },
  { name: "giant-10mb", sizeClass: 10, command: giantLine(10_485_760), expectedChildBytes: 10_485_760, expectedExit: 0 },
  { name: "stderr-mix-10mb", sizeClass: 10, command: stderrMix(500_000), expectedChildBytes: 10_000_000, expectedExit: 0 },
  {
    name: "signal-death-10mb",
    sizeClass: 10,
    command: `${numbered(1_000_000)}; kill -TERM $$`,
    expectedChildBytes: 10_000_000,
    expectedExit: null,
  },
  {
    name: "uniform-100mb",
    sizeClass: 100,
    command: numbered(10_000_000),
    expectedChildBytes: 100_000_000,
    expectedExit: 0,
  },
  {
    name: "giant-100mb",
    sizeClass: 100,
    command: giantLine(104_857_600),
    expectedChildBytes: 104_857_600,
    expectedExit: 0,
  },
  {
    name: "stderr-mix-100mb",
    sizeClass: 100,
    command: stderrMix(5_000_000),
    expectedChildBytes: 100_000_000,
    expectedExit: 0,
  },
  {
    name: "yes-head-100mb",
    sizeClass: 100,
    command: "yes | head -c 104857600",
    expectedChildBytes: 104_857_600,
    expectedExit: 0,
  },
  {
    name: "nonzero-exit-100mb",
    sizeClass: 100,
    command: `${numbered(10_000_000)}; exit 7`,
    expectedChildBytes: 100_000_000,
    expectedExit: 7,
  },
];

// ---- package link preflight + extension load (same pattern as the parity suite) ----
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execFileSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}
const pibash = (await import(join(ROOT, "extensions", "pibash", "index.ts"))).default;

if (!existsSync(BIN)) {
  console.error(`FATAL  ${BIN} missing — run scripts/bootstrap.sh first`);
  process.exit(1);
}

function loadWrappedTool() {
  const tools = new Map();
  const pi = { registerTool: (def) => tools.set(def.name, def), on: () => () => {} };
  process.env.PI_NATIVE_BASH = "1";
  try {
    pibash(pi);
  } finally {
    delete process.env.PI_NATIVE_BASH;
  }
  const tool = tools.get("pibash");
  assert.ok(tool, "PI_NATIVE_BASH=1 must register the 'pibash' tool");
  return tool;
}

const wrapped = loadWrappedTool();
const ctx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "bench", getSessionFile: () => undefined },
  model: undefined,
  thinkingLevel: undefined,
};

// ---- daemon arm: model-visible metrics through the production path ----
export async function runDaemonFixture(fixture) {
  const t0 = performance.now();
  const result = await wrapped.execute(`bench-${fixture.name}`, { command: fixture.command }, undefined, undefined, ctx);
  const wallMs = performance.now() - t0;

  const text = result?.content?.[0]?.text ?? "";
  const details = result?.details ?? {};
  const spillPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
  const metrics = {
    name: fixture.name,
    sizeClass: fixture.sizeClass,
    envelopeBytes: Buffer.byteLength(text),
    childBytes: details.truncation?.totalBytes,
    spillPath,
    spillBytes: spillPath ? statSync(spillPath).size : 0,
    truncated: details.truncation?.truncated === true,
    exitCode: result?.structuredContent?.exit_code,
    isError: result?.isError === true,
    wallMs,
  };
  if (spillPath) unlinkSync(spillPath); // the only cleanup: files this run created
  return metrics;
}

// ---- oneshot arm: peak RSS (ru_maxrss) + wire JSON size, isolated process ----
export async function measureRssOneshot(fixture) {
  if (!existsSync(TIME_BIN)) return null;
  const flag = process.platform === "darwin" ? "-l" : "-v";
  const wirePath = join(tmpdir(), `pib-bench-wire-${process.pid}-${fixture.name}.json`);
  const out = openSync(wirePath, "w");
  let timeStderr = "";
  const t0 = performance.now();
  await new Promise((resolveRun, reject) => {
    const proc = spawnChild(TIME_BIN, [flag, BIN, "--command", fixture.command], {
      stdio: ["ignore", out, "pipe"],
    });
    proc.stderr.on("data", (d) => (timeStderr += d));
    proc.on("error", reject);
    proc.on("exit", () => resolveRun());
  });
  const wallMs = performance.now() - t0;
  closeSync(out);
  const wireBytes = statSync(wirePath).size;
  unlinkSync(wirePath);

  const line =
    process.platform === "darwin"
      ? timeStderr.match(/^\s*(\d+)\s+maximum resident set size/m)
      : timeStderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
  if (!line) return { name: fixture.name, sizeClass: fixture.sizeClass, peakRssBytes: null, wireBytes, wallMs };
  return {
    name: fixture.name,
    sizeClass: fixture.sizeClass,
    peakRssBytes: rssToBytes(Number(line[1])),
    wireBytes,
    wallMs,
  };
}

// ---- run + assertions (guarded so tests can import this module) ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const measureOnly = process.argv.includes("--measure");
  const sizeArg = process.argv.find((a) => a.startsWith("--sizes="))?.slice("--sizes=".length);
  const wanted = sizeArg ? new Set(sizeArg.split(",").map(Number)) : null;
  const fixtures = wanted ? FIXTURES.filter((f) => wanted.has(f.sizeClass)) : FIXTURES;
  assert.ok(fixtures.length > 0, "--sizes= selected nothing");

  const fmtBytes = (n) => (n == null ? "?" : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const rows = [];
  for (const fixture of fixtures) {
    const d = await runDaemonFixture(fixture);
    const r = await measureRssOneshot(fixture);
    rows.push({ daemon: d, rss: r });
    console.log(
      `${fixture.name.padEnd(20)} child ${fmtBytes(d.childBytes)} : spill ${fmtBytes(d.spillBytes)} : ` +
        `envelope ${d.envelopeBytes} B : rss ${r?.peakRssBytes == null ? "?" : `${(r.peakRssBytes / 1024 / 1024).toFixed(0)} MB`} : ` +
        `exit ${d.exitCode} : daemon ${d.wallMs.toFixed(0)} ms : oneshot ${(r?.wallMs ?? 0).toFixed(0)} ms`,
    );
  }

  const failures = [];
  const check = (ok, label) => {
    if (!ok) failures.push(label);
  };

  if (!measureOnly) {
    const byName = new Map(FIXTURES.map((f) => [f.name, f]));
    for (const { daemon: d, rss } of rows) {
      const f = byName.get(d.name);
      check(d.childBytes === f.expectedChildBytes, `${d.name}: child_bytes ${d.childBytes} != expected ${f.expectedChildBytes}`);
      check(d.truncated === true, `${d.name}: expected a truncated/spilled result`);
      check(d.spillBytes === d.childBytes, `${d.name}: spill_bytes ${d.spillBytes} != child_bytes ${d.childBytes}`);
      check(d.envelopeBytes <= ENVELOPE_CAP_BYTES, `${d.name}: envelope_bytes ${d.envelopeBytes} > cap ${ENVELOPE_CAP_BYTES}`);
      if (f.expectedExit === 0) check(d.exitCode === 0 && d.isError === false, `${d.name}: expected exit 0, got ${d.exitCode}`);
      else if (f.expectedExit != null) check(d.exitCode === f.expectedExit, `${d.name}: expected exit ${f.expectedExit}, got ${d.exitCode}`);
      else check(d.exitCode !== 0 && d.isError === true, `${d.name}: expected non-zero signal death, got ${d.exitCode}`);
      if (rss?.peakRssBytes != null) {
        const cap = RSS_CAP_BYTES[d.sizeClass];
        check(rss.peakRssBytes <= cap, `${d.name}: peak rss ${rss.peakRssBytes} > cap ${cap}`);
      }
    }
    // Envelope must be O(envelope), not O(child): within a shape, the 100 MB
    // render may exceed the 1 MB render only by note text, never by content.
    for (const shape of ["uniform", "giant", "stderr-mix"]) {
      const small = rows.find((r) => r.daemon.name === `${shape}-1mb`)?.daemon;
      const large = rows.find((r) => r.daemon.name === `${shape}-100mb`)?.daemon;
      if (small && large) {
        check(
          large.envelopeBytes <= small.envelopeBytes + 1024,
          `${shape}: envelope grew with output size (${small.envelopeBytes} B at 1 MB -> ${large.envelopeBytes} B at 100 MB)`,
        );
      }
    }
  }

  if (measureOnly) {
    console.log("\nmeasure mode — assertions skipped; values above pin the constants");
    process.exit(0);
  }

  // ---- report ----
  const date = new Date().toISOString().slice(0, 10);
  const pibashVersion = (await import("node:child_process")).execFileSync(BIN, ["--version"]).toString().trim();
  const platformNote =
    process.platform === "darwin"
      ? "Run on macOS (ru_maxrss parsed from `/usr/bin/time -l`, reported in bytes)."
      : "Run on Linux (ru_maxrss parsed from `/usr/bin/time -v`, reported in KiB, normalized ×1024). The macOS arm parses `-l` byte values through the same `rssToBytes` helper but was not exercised on this host.";
  const out = [
    `# pibash large-output bench — ${date}`,
    "",
    `Host ${process.platform} ${process.arch} · node ${process.version} · ${pibashVersion} · single pass per fixture, wall-clock.`,
    "",
    `Arms: daemon = extension dispatch via the persistent \`--serve\` daemon (production path, model-visible metrics) · oneshot = \`bin/pibash --command\` under \`/usr/bin/time\` (isolated peak RSS + wire JSON size).`,
    "",
    `Platform: ${platformNote}`,
    "",
    "Assertions pinned by this run (current behavior, see docs/backlog.md §1): child_bytes byte-exact · spill_bytes == child_bytes · envelope_bytes <= " + ENVELOPE_CAP_BYTES + " (O(envelope), not O(child)) · peak RSS <= per-class cap — RSS scales with output size **by design** until the accumulator spills; the caps record measured peaks, they are not an O(1) goal.",
    "",
    "## Metrics",
    "",
    "| fixture | child_bytes | spill_bytes | envelope_bytes | peak_rss | wire_bytes | exit | daemon wall | oneshot wall |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ({ daemon: d, rss }) =>
        `| ${d.name} | ${d.childBytes ?? "?"} | ${d.spillBytes} | ${d.envelopeBytes} | ` +
        `${rss?.peakRssBytes == null ? "n/a" : rss.peakRssBytes} | ${rss?.wireBytes ?? "?"} | ${d.exitCode} | ` +
        `${d.wallMs.toFixed(0)} ms | ${(rss?.wallMs ?? 0).toFixed(0)} ms |`,
    ),
    "",
    "## Constants",
    "",
    `- ENVELOPE_CAP_BYTES = ${ENVELOPE_CAP_BYTES} (2× the measured max: uncompressed streams render the legacy 2000-line tail window; classified streams ≈ model budget ${MODEL_BUDGET_BYTES})`,
    ...Object.entries(RSS_CAP_BYTES).map(([cls, cap]) => `- RSS_CAP_BYTES[${cls} MB] = ${cap}`),
    "",
    "---",
    "",
    "Generated by `custom-tools/pibash/bench-large-output.mjs` (fixtures per research/pibash-large-output.md §4).",
    "",
  ].join("\n");

  const outDir = join(ROOT, "benchmark", "runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `pibash-large-output-${date}.md`);
  writeFileSync(outPath, out);
  assert.ok(readFileSync(outPath, "utf8").length > 0, "report must be non-empty");
  console.log(`\nwrote ${outPath}`);

  if (failures.length) {
    console.error(`\nASSERTION FAILURES (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`all assertions green (${rows.length} fixtures)`);
}
