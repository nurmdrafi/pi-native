// Step 0 (S8 piedit): measure the built-in `edit` hot path on a deterministic
// corpus, splitting match+apply from diff/patch rendering and file write.
// Read-only measurement: writes to a temp dir, never to repo fixtures.
//
// Usage: node tests/s8-hotpath.mjs [iterations]
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { access, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}
const {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
} = await import(join(pkgLink, "dist", "core", "tools", "edit-diff.js"));
const { splitBom } = await import(join(pkgLink, "dist", "utils", "text.js"));

const ITER = Number(process.argv[2] ?? 200);

function makeLines(n, prefix = "line") {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${prefix} ${i}: the quick brown fox jumps over the lazy dog ${i}`);
  return out.join("\n") + "\n";
}

// Deterministic corpus: representative edit shapes seen in the session corpus.
const corpus = [
  {
    name: "small-exact",
    build: () => "alpha\nbeta\ngamma\ndelta\n",
    edits: [{ oldText: "beta", newText: "BETA-amended" }],
  },
  {
    name: "mid-exact-1of200",
    build: () => makeLines(200),
    edits: [{ oldText: "line 100: the quick brown fox jumps over the lazy dog 100", newText: "REPLACED 100" }],
  },
  {
    name: "mid-multi-3of200",
    build: () => makeLines(200),
    edits: [
      { oldText: "line 20: the quick brown fox jumps over the lazy dog 20", newText: "R20" },
      { oldText: "line 120: the quick brown fox jumps over the lazy dog 120", newText: "R120" },
      { oldText: "line 199: the quick brown fox jumps over the lazy dog 199", newText: "R199" },
    ],
  },
  {
    name: "large-1MiB-exact",
    build: () => makeLines(12000, "softwere engineering practice number"),
    edits: [{ oldText: "softwere engineering practice number 6000: the quick brown fox jumps over the lazy dog 6000", newText: "REPLACED-LARGE" }],
  },
  {
    name: "fuzzy-trailing-ws",
    build: () => "one\ntwo   \nthree\n",
    edits: [{ oldText: "two", newText: "TWO" }],
  },
  {
    name: "multiline-block",
    build: () => makeLines(300),
    edits: [
      {
        oldText: makeLines(300).split("\n").slice(50, 75).join("\n"),
        newText: "BLOCK REPLACEMENT\nsecond line\nthird line",
      },
    ],
  },
];

// One measured pass replicating edit.js's pipeline exactly.
async function runOne(dir, c, iter) {
  const file = path.join(dir, `${c.name}-${iter}.txt`);
  await writeFile(file, c.build(), "utf-8");
  const edits = c.edits;

  const t = {};
  let mark = performance.now();

  // access
  await access(file);
  t.access = performance.now() - mark; mark = performance.now();

  // read
  const buffer = await fsReadFile(file);
  t.read = performance.now() - mark; mark = performance.now();

  const rawContent = buffer.toString("utf-8");
  const { bom, text: content } = splitBom(rawContent);
  const originalEnding = detectLineEnding(content);
  const normalizedContent = normalizeToLF(content);
  t.prepare = performance.now() - mark; mark = performance.now();

  // match + apply
  const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, file);
  t.matchApply = performance.now() - mark; mark = performance.now();

  const finalContent = bom + restoreLineEndings(newContent, originalEnding);
  await fsWriteFile(file, finalContent, "utf-8");
  t.write = performance.now() - mark; mark = performance.now();

  // diff + patch rendering
  const diffResult = generateDiffString(baseContent, newContent);
  const patch = generateUnifiedPatch(file, baseContent, newContent);
  t.diffPatch = performance.now() - mark;

  t.total = t.access + t.read + t.prepare + t.matchApply + t.write + t.diffPatch;
  t.bytes = Buffer.byteLength(finalContent, "utf-8");
  return t;
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function median(arr) { return pct(arr, 50); }

const dir = await mkdtemp(path.join(tmpdir(), "s8-hotpath-"));
const results = [];
try {
  // Warmup
  for (const c of corpus) for (let i = 0; i < 5; i++) await runOne(dir, c, -1 - i);

  for (const c of corpus) {
    const acc = { access: [], read: [], prepare: [], matchApply: [], write: [], diffPatch: [], total: [], bytes: 0 };
    for (let i = 0; i < ITER; i++) {
      const t = await runOne(dir, c, i);
      for (const k of ["access", "read", "prepare", "matchApply", "write", "diffPatch", "total"]) acc[k].push(t[k]);
      acc.bytes = t.bytes;
    }
    const sum = (k) => acc[k].reduce((a, b) => a + b, 0);
    const row = { name: c.name, bytes: acc.bytes };
    for (const k of ["access", "read", "prepare", "matchApply", "write", "diffPatch", "total"]) {
      row[k] = median(acc[k]);
      row[`${k}_share`] = sum(k) / sum("total");
    }
    row.p50 = median(acc.total);
    row.p95 = pct(acc.total, 95);
    results.push(row);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

const fmt = (x) => x.toFixed(3);
const pctf = (x) => (x * 100).toFixed(1) + "%";

console.log(`# S8 Step 0 hot-path split — ${ITER} iters/class (medians, ms)\n`);
console.log("| class | bytes | access | read | prepare | matchApply | write | diffPatch | total p50 | total p95 | match% | diff% | write% |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.bytes} | ${fmt(r.access)} | ${fmt(r.read)} | ${fmt(r.prepare)} | ${fmt(r.matchApply)} | ${fmt(r.write)} | ${fmt(r.diffPatch)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${pctf(r.matchApply_share)} | ${pctf(r.diffPatch_share)} | ${pctf(r.write_share)} |`,
  );
}

// Aggregate shares across corpus (sum of medians weighted by nothing — informational).
const tot = (k) => results.reduce((a, r) => a + r[k], 0);
const T = tot("total");
console.log(`\nAggregate (sum of class medians): match+apply ${pctf(tot("matchApply") / T)}, diff+patch ${pctf(tot("diffPatch") / T)}, write ${pctf(tot("write") / T)}, read+prepare ${pctf((tot("read") + tot("prepare") + tot("access")) / T)}`);

if (process.env.S8_JSON) {
  console.log("\n" + JSON.stringify(results));
}
