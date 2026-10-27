#!/usr/bin/env node
/**
 * piedit diff differential fuzz — Rust native render vs TS oracle.
 *
 * Isolates the diff/patch port (rust-tools/piedit/src/diff.rs) from the
 * edit pipeline: for randomized content pairs, drive `bin/piedit --path`
 * once WITHOUT renderDiff (legacy envelope → {baseContent,newContent}) and
 * once WITH renderDiff (native {diff,patch,firstChangedLine}), then compare
 * the native fields against `generateDiffString`/`generateUnifiedPatch`
 * computed in-process from the legacy pair. Any byte mismatch is a port bug.
 *
 * Deterministic (fixed LCG seed). Exit 0 = all iterations byte-identical.
 * Run: node tests/piedit-diff-fuzz.mjs [iterations]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "bin", "piedit");
const { generateDiffString, generateUnifiedPatch } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);

const ITER = Number(process.argv[2] ?? 2000);

// ---- deterministic LCG ----
let seed = 0x5eed1234;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const int = (n) => Math.floor(rnd() * n);

const WORDS = [
  "", " ", "  ", "a", "b", "foo", "bar", "baz qux", "dup", "dup", "dup2",
  "🎉emoji", "€€€", "café", "x".repeat(25), "tab\there", "  indent",
  "trail   ", "CR-like\r", "nul-free", "0", "1", "2",
];

function randomLine() {
  const parts = [];
  const n = int(3);
  for (let i = 0; i <= n; i++) parts.push(WORDS[int(WORDS.length)]);
  return parts.join(" ").slice(0, 40);
}

function randomContent() {
  const lines = [];
  const n = 1 + int(50);
  for (let i = 0; i < n; i++) lines.push(randomLine());
  // Bias toward short runs of repeated lines (Myers tie-break stress).
  if (rnd() < 0.4) {
    const dup = randomLine();
    const start = int(lines.length);
    const cnt = 1 + int(4);
    lines.splice(start, 0, ...Array.from({ length: cnt }, () => dup));
  }
  let s = lines.join("\n");
  if (rnd() < 0.8) s += "\n"; // usually trailing newline, sometimes not
  return s;
}

/** One random mutation of the content: replace/delete/insert line-ish spans. */
function mutate(content) {
  const lines = content.split("\n");
  const op = int(3);
  const i = int(Math.max(1, lines.length - 1));
  const repl = Array.from({ length: 1 + int(3) }, () => randomLine());
  if (op === 0) lines.splice(i, 1 + int(2), ...repl); // replace 1-2 lines
  else if (op === 1) lines.splice(i, 1 + int(3)); // delete
  else lines.splice(i, 0, ...repl); // insert
  return lines.join("\n");
}

function runOnce(path, body, edits, renderDiff) {
  const request = JSON.stringify({ edits, ...(renderDiff ? { renderDiff: true } : {}) });
  return new Promise((res, rej) => {
    const child = spawn(BIN, ["--path", path], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      try { res(JSON.parse(out)); } catch (e) { rej(e); }
    });
    child.on("error", rej);
    child.stdin.end(request);
  });
}

/** Pick a unique full-line oldText from content (retry until unique). */
function uniqueAnchor(content) {
  const lines = content.split("\n");
  for (let attempt = 0; attempt < 60; attempt++) {
    const i = int(Math.max(1, lines.length - 1));
    const anchor = lines[i];
    if (!anchor) continue;
    if (content.indexOf(anchor) === content.lastIndexOf(anchor)) return anchor;
  }
  // deterministic fallback: a marker line unique by construction
  return `unique-anchor-${seed.toString(16)}`;
}

const dir = mkdtempSync(join(tmpdir(), "piedit-fuzz-"));
let failures = 0;
const shown = [];
try {
  for (let iter = 0; iter < ITER; iter++) {
    const base = randomContent();
    // Produce the "new" side via an edit the pipeline accepts, but with the
    // mutation chosen for diff richness rather than edit realism.
    const anchor = uniqueAnchor(base);
    const newText = mutate(base);
    const edits = [{ oldText: anchor, newText }];
    const path = join(dir, `f${iter % 8}.txt`);

    writeFileSync(path, base);
    const legacy = await runOnce(path, base, edits, false);
    if (legacy.ok !== true) continue; // anchor uniqueness etc. — skip
    const { baseContent, newContent } = legacy;

    writeFileSync(path, base);
    const native = await runOnce(path, base, edits, true);
    if (native.ok !== true) {
      failures++;
      if (shown.length < 5) shown.push([iter, "rendered run failed", native]);
      continue;
    }

    const oracleDiff = generateDiffString(baseContent, newContent);
    const oraclePatch = generateUnifiedPatch(path, baseContent, newContent);
    const bad = [];
    if (native.diff !== oracleDiff.diff) bad.push("diff");
    if (native.patch !== oraclePatch) bad.push("patch");
    if (native.firstChangedLine !== oracleDiff.firstChangedLine) bad.push("firstChangedLine");
    if (bad.length) {
      failures++;
      if (shown.length < 5) {
        shown.push([
          iter,
          bad.join(","),
          { base: baseContent.slice(0, 200), nativeDiff: native.diff?.slice(0, 200), oracleDiff: oracleDiff.diff?.slice(0, 200), nativePatch: native.patch?.slice(0, 200), oraclePatch: oraclePatch.slice(0, 200), fcl: [native.firstChangedLine, oracleDiff.firstChangedLine] },
        ]);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`diff fuzz: ${ITER} iterations, ${failures} failures`);
for (const f of shown) console.log(JSON.stringify(f, null, 2).slice(0, 1500));
process.exit(failures === 0 ? 0 : 1);
