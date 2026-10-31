// Wave-metrics extractor (plan §11 measurement protocol): joins
// .pi/subagent-results.jsonl (completion records: id, ts, name, agent,
// parentSessionId, exitCode, elapsed[sec], stats) with .pi/subagent-history.jsonl
// (durable enrichment: files_changed, files_read, diff, summary) by id, emits
// one NDJSON child line each plus one summary line per wave. Waves group by
// parentSessionId when present; leftovers cluster by ts gaps (> 30 min starts
// a new wave). Real stats shape (extensions/subagents/session.ts SessionStats)
// is flat inputTokens/outputTokens/.../cost — there is no stats.tokens field
// in production data, so tokens prefers the usage fields and falls back to
// stats.tokens; absent means null, never a fabricated 0.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "wave-metrics.mjs");

/** Fresh repo dir with .pi/ plus the given NDJSON contents (or nothing). */
function mkRepo({ results, history } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wave-metrics-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (results !== undefined) writeFileSync(join(dir, ".pi", "subagent-results.jsonl"), results);
  if (history !== undefined) writeFileSync(join(dir, ".pi", "subagent-history.jsonl"), history);
  return dir;
}

function run(...args) {
  const p = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr };
}

function lines(jsonOut) {
  return jsonOut.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("missing --help only: usage, exit 0", () => {
  const p = run("--help");
  assert.equal(p.status, 0);
  assert.match(p.stdout, /wave-metrics/i);
  assert.match(p.stdout, /--repo/);
});

test("missing both inputs: exit 0, no output", () => {
  const dir = mkRepo(); // .pi/ exists, neither file does
  const p = run("--repo", dir);
  assert.equal(p.status, 0);
  assert.equal(p.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("empty input files: exit 0, no output", () => {
  const dir = mkRepo({ results: "\n", history: "" });
  const p = run("--repo", dir);
  assert.equal(p.status, 0);
  assert.equal(p.stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("corrupt and partial lines are skipped, never fatal", () => {
  const dir = mkRepo({
    results: [
      "{not json",
      '{"id":"r1","ts"',
      "",
      JSON.stringify({ id: "r1", ts: 1000000, name: "scout", exitCode: 0, elapsed: 10 }),
    ].join("\n"),
    history: [
      "garbage line",
      JSON.stringify({ id: "r1", ts: 1000000, name: "scout", files_changed: ["a.ts"] }),
    ].join("\n"),
  });
  const p = run("--repo", dir);
  assert.equal(p.status, 0);
  const kids = lines(p.stdout).filter((l) => l.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].id, "r1");
  assert.equal(kids[0].filesChangedCount, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("join by id with either side missing", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({
        id: "r1", ts: 1000000, name: "scout", agent: "scout", parentSessionId: "p1",
        exitCode: 0, elapsed: 65,
        stats: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5, cost: 0.12 },
      }),
      JSON.stringify({ id: "r2", ts: 1000000, name: "fixer", agent: "fixer", exitCode: 0, elapsed: 5 }),
    ].join("\n"),
    history: [
      JSON.stringify({
        id: "r1", ts: 1000000, name: "scout",
        files_changed: ["a.ts"], files_read: ["a.ts", "c.ts"], summary: "s",
      }),
      JSON.stringify({ id: "h1", ts: 3000000, name: "worker", files_changed: ["d.ts", "e.ts"], files_read: ["f.ts"] }),
    ].join("\n"),
  });
  const kids = lines(run("--repo", dir).stdout).filter((l) => l.id);
  assert.equal(kids.length, 3);

  const r1 = kids.find((k) => k.id === "r1");
  assert.equal(r1.agent, "scout");
  assert.equal(r1.elapsedSec, 65);
  assert.equal(r1.costUsd, 0.12);
  assert.equal(r1.tokens, 140); // inputTokens + outputTokens (real shape)
  assert.equal(r1.filesChangedCount, 1);
  assert.equal(r1.filesReadCount, 2);

  const r2 = kids.find((k) => k.id === "r2"); // results only
  assert.equal(r2.agent, "fixer");
  assert.equal(r2.costUsd, null);
  assert.equal(r2.tokens, null);
  assert.equal(r2.filesChangedCount, null);
  assert.equal(r2.filesReadCount, null);

  const h1 = kids.find((k) => k.id === "h1"); // history only (durable side)
  assert.equal(h1.agent, null);
  assert.equal(h1.elapsedSec, null);
  assert.equal(h1.tokens, null);
  assert.equal(h1.filesChangedCount, 2);
  assert.equal(h1.filesReadCount, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("tokens falls back to stats.tokens, null when absent", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({ id: "t1", ts: 1000000, name: "a", exitCode: 0, elapsed: 1, stats: { tokens: 77 } }),
      JSON.stringify({ id: "t2", ts: 1000000, name: "b", exitCode: 0, elapsed: 1, stats: {} }),
    ].join("\n"),
  });
  const kids = lines(run("--repo", dir).stdout).filter((l) => l.id);
  assert.equal(kids.find((k) => k.id === "t1").tokens, 77);
  assert.equal(kids.find((k) => k.id === "t2").tokens, null);
  rmSync(dir, { recursive: true, force: true });
});

test("waves group by parentSessionId; orphans cluster by ts gap", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({ id: "a", ts: 1000000000, name: "a", agent: "scout", parentSessionId: "p1", exitCode: 0, elapsed: 10 }),
      JSON.stringify({ id: "b", ts: 1000060000, name: "b", agent: "scout", parentSessionId: "p1", exitCode: 0, elapsed: 10 }),
      JSON.stringify({ id: "c", ts: 2000000000, name: "c", exitCode: 0, elapsed: 10 }),
    ].join("\n"),
  });
  const waves = lines(run("--repo", dir).stdout).filter((l) => l.wave !== undefined);
  assert.equal(waves.length, 2);
  assert.equal(waves[0].children, 2); // p1 wave first (earlier min ts)
  assert.equal(waves[0].wallClockSec, 60); // max ts - min ts: 60000 ms in seconds
  assert.equal(waves[1].children, 1);
  assert.equal(waves[1].wallClockSec, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("30-min gap boundary: exactly 1800s stays in-wave, 1801s splits", () => {
  const t0 = 1000000000;
  const dir = mkRepo({
    results: [
      // Pair A: d1 → d2 exactly 1800s (boundary, stays one wave). Pair B
      // starts 8200s after d2 so it clusters apart; e1 → e2 is 1801s (splits).
      JSON.stringify({ id: "d1", ts: t0, name: "d1", exitCode: 0, elapsed: 1 }),
      JSON.stringify({ id: "d2", ts: t0 + 1800_000, name: "d2", exitCode: 0, elapsed: 1 }),
      JSON.stringify({ id: "e1", ts: t0 + 10_000_000, name: "e1", exitCode: 0, elapsed: 1 }),
      JSON.stringify({ id: "e2", ts: t0 + 10_000_000 + 1801_000, name: "e2", exitCode: 0, elapsed: 1 }),
    ].join("\n"),
  });
  const waves = lines(run("--repo", dir).stdout).filter((l) => l.wave !== undefined);
  assert.equal(waves.length, 3);
  assert.deepEqual(waves.map((w) => w.children), [2, 1, 1]);
  rmSync(dir, { recursive: true, force: true });
});

test("duplicateReads lists only paths read by 2+ children in a wave, sorted", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({ id: "w1", ts: 1000000000, name: "w1", exitCode: 0, elapsed: 1 }),
      JSON.stringify({ id: "w2", ts: 1000060000, name: "w2", exitCode: 0, elapsed: 1 }),
    ].join("\n"),
    history: [
      JSON.stringify({ id: "w1", ts: 1000000000, name: "w1", files_changed: [], files_read: ["z.ts", "shared.ts"] }),
      JSON.stringify({ id: "w2", ts: 1000060000, name: "w2", files_changed: [], files_read: ["shared.ts", "a.ts"] }),
    ].join("\n"),
  });
  const waves = lines(run("--repo", dir).stdout).filter((l) => l.wave !== undefined);
  assert.equal(waves.length, 1);
  assert.deepEqual(waves[0].duplicateReads, ["shared.ts"]);
  rmSync(dir, { recursive: true, force: true });
});

test("wave totals sum known values; all-unknown stays null", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({ id: "s1", ts: 1000000000, name: "s1", exitCode: 0, elapsed: 1, stats: { inputTokens: 10, outputTokens: 5, cost: 0.5 } }),
      JSON.stringify({ id: "s2", ts: 1000060000, name: "s2", exitCode: 0, elapsed: 1, stats: { inputTokens: 1, outputTokens: 1, cost: 0.25 } }),
      JSON.stringify({ id: "s3", ts: 5000000000, name: "s3", exitCode: 0, elapsed: 1 }),
    ].join("\n"),
  });
  const waves = lines(run("--repo", dir).stdout).filter((l) => l.wave !== undefined);
  assert.equal(waves.length, 2); // s1+s2 same wave, s3 alone (huge gap)
  assert.equal(waves[0].totalCostUsd, 0.75);
  assert.equal(waves[0].totalTokens, 17);
  assert.equal(waves[1].totalCostUsd, null); // no child contributed a value
  assert.equal(waves[1].totalTokens, null);
  rmSync(dir, { recursive: true, force: true });
});

test("--out writes NDJSON to the file", () => {
  const dir = mkRepo({
    results: JSON.stringify({ id: "o1", ts: 1000000000, name: "o1", exitCode: 0, elapsed: 3 }) + "\n",
  });
  const out = join(dir, "out", "waves.ndjson");
  const p = run("--repo", dir, "--out", out);
  assert.equal(p.status, 0);
  const emitted = lines(readFileSync(out, "utf8"));
  assert.equal(emitted.filter((l) => l.id).length, 1);
  assert.equal(emitted.filter((l) => l.wave !== undefined).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("caps sanity: 250 files_changed counted fully; 400 corrupt lines among 50 valid", () => {
  const big = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
  const results = [
    ...Array.from({ length: 400 }, () => "{broken"),
    ...Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ id: `v${i}`, ts: 1000000000 + i * 1000, name: `v${i}`, exitCode: 0, elapsed: 1 })),
  ].join("\n");
  const dir = mkRepo({
    results,
    history: JSON.stringify({ id: "v0", ts: 1000000000, name: "v0", files_changed: big }) + "\n",
  });
  const kids = lines(run("--repo", dir).stdout).filter((l) => l.id);
  assert.equal(kids.length, 50);
  assert.equal(kids.find((k) => k.id === "v0").filesChangedCount, 250);
  rmSync(dir, { recursive: true, force: true });
});

test("duplicate id lines: last valid record per id wins", () => {
  const dir = mkRepo({
    results: [
      JSON.stringify({ id: "x1", ts: 1000000000, name: "old", exitCode: 0, elapsed: 1 }),
      JSON.stringify({ id: "x1", ts: 1000000000, name: "new", exitCode: 0, elapsed: 2 }),
    ].join("\n"),
  });
  const kids = lines(run("--repo", dir).stdout).filter((l) => l.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].name, "new");
  rmSync(dir, { recursive: true, force: true });
});
