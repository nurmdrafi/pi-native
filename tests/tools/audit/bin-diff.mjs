#!/usr/bin/env node
/**
 * Byte-for-byte differential between two builds of the same native tool.
 *
 * Why: every native-tool refactor (piread's scanner swap, pibash's compression
 * rework, piedit's diff port) carries the same risk — the output changes shape
 * somewhere no test looks. This harness takes the pre-change binary and the
 * post-change binary, drives both over a corpus x argument grid, and compares
 * stdout, stderr and exit status byte for byte. Any difference is a port bug,
 * found before the change lands rather than in a session log afterwards.
 *
 * Usage:
 *   node tests/tools/audit/bin-diff.mjs --old <bin> --new <bin> [--corpus <dir>]
 *                                      [--args <template> ...] [--json]
 *   node tests/tools/audit/bin-diff.mjs --old <bin> --new <bin> --serve <reqs>
 *
 *   --args "<template>"   Repeatable. `{file}` is substituted with a corpus
 *                         path and stays a single argv element. Defaults to
 *                         piread's offset/limit/line-cap grid; pass your own
 *                         for other tools (pibash: `--command cat {file}`).
 *   --serve <file>        Daemon mode: pipe the same NDJSON request stream to
 *                         `<bin> --serve` on both builds and compare the
 *                         response stream.
 *   --corpus <dir>        Use an existing corpus instead of the built-in shapes.
 *
 * Exit code: 0 = identical, 1 = differences, 2 = bad usage.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const many = (name) =>
  argv.reduce((acc, a, i) => (a === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const AS_JSON = argv.includes("--json");
const MAX_BUF = 64 * 1024 * 1024;

/** piread's argument grid: window starts, window widths, line cap. */
const DEFAULT_ARGS = [
  "--path {file}",
  "--path {file} --offset 2",
  "--path {file} --offset 33",
  "--path {file} --limit 40",
  "--path {file} --limit 210",
  "--path {file} --offset 12 --limit 90",
  "--path {file} --limit 2000",
  "--path {file} --line-cap 10",
];

/** Shape classes that have broken a native tool's accounting at least once. */
function defaultCorpus() {
  const dir = mkdtempSync(join(tmpdir(), "bin-diff-corpus-"));
  const w = (name, data) => writeFileSync(join(dir, name), data);
  const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("");
  w("01-empty", "");
  w("02-noeol", "a");
  w("03-oneline-eol", "a\n");
  w("04-lone-nl", "\n");
  w("05-three-nl", "\n\n\n");
  w("06-crlf", "a\r\nb\r\nc\r\n");
  w("07-unicode", lines(80, (i) => `line ${i} \u00e9 \u20ac \u{1f680}\n`));
  w("08-trailing-blanks", lines(30, (i) => `x${i}\n`) + "\n".repeat(20));
  w("09-lines2500", lines(2500, (i) => `const x${i} = ${i};\n`));
  w("10-huge-line", "q".repeat(200_000));
  w("11-lines100k", lines(100_000, (i) => `l${i}\n`));
  w("12-nul-early", Buffer.concat([Buffer.from("a".repeat(100)), Buffer.from([0]), Buffer.from("b".repeat(900))]));
  w("13-nul-late", Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0]), Buffer.from("b".repeat(900))]));
  w("14-longlines", lines(50, () => `${"z".repeat(300)}\n`));
  w("15-blank-head", "\n".repeat(5) + lines(60, (i) => `tail${i}\n`));
  return dir;
}

function runOne(bin, args, input) {
  return spawnSync(bin, args, { input, maxBuffer: MAX_BUF });
}

function compareCli(oldBin, newBin, dir, templates) {
  const files = readdirSync(dir).sort();
  let cases = 0;
  let diffs = 0;
  const first = [];
  for (const name of files) {
    const file = join(dir, name);
    for (const template of templates) {
      const args = template
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => (tok === "{file}" ? file : tok));
      const a = runOne(oldBin, args);
      const b = runOne(newBin, args);
      cases += 1;
      const same =
        a.status === b.status &&
        !a.error &&
        !b.error &&
        Buffer.compare(a.stdout, b.stdout) === 0 &&
        Buffer.compare(a.stderr, b.stderr) === 0;
      if (same) continue;
      diffs += 1;
      if (first.length < 5) first.push(`DIFF ${name} ${args.join(" ")}`);
    }
  }
  return { cases, diffs, first };
}

function compareServe(oldBin, newBin, reqFile) {
  const input = readFileSync(reqFile);
  const a = runOne(oldBin, ["--serve"], input);
  const b = runOne(newBin, ["--serve"], input);
  const identical =
    a.status === b.status &&
    !a.error &&
    !b.error &&
    Buffer.compare(a.stdout, b.stdout) === 0 &&
    Buffer.compare(a.stderr, b.stderr) === 0;
  const lines = b.stdout.toString().split("\n").filter(Boolean).length;
  return { identical, lines };
}

const oldBin = flag("--old");
const newBin = flag("--new");
if (!oldBin || !newBin) {
  console.error("usage: bin-diff.mjs --old <bin> --new <bin> [--corpus <dir>] [--args <t>] [--serve <reqs>]");
  process.exit(2);
}

const serveFile = flag("--serve");
let code = 0;
if (serveFile) {
  const r = compareServe(oldBin, newBin, serveFile);
  if (AS_JSON) console.log(JSON.stringify(r));
  else console.log(r.identical ? `serve: identical (${r.lines} response lines)` : "serve: DIFFERS");
  if (!r.identical) code = 1;
} else {
  const corpusArg = flag("--corpus");
  const dir = corpusArg ?? defaultCorpus();
  const given = many("--args");
  const templates = given.length > 0 ? given : DEFAULT_ARGS;
  const r = compareCli(oldBin, newBin, dir, templates);
  if (!corpusArg) rmSync(dir, { recursive: true, force: true });
  if (AS_JSON) console.log(JSON.stringify(r));
  else {
    for (const line of r.first) console.log(line);
    console.log(`cases=${r.cases} diffs=${r.diffs}`);
  }
  if (r.diffs > 0) code = 1;
}
process.exit(code);
