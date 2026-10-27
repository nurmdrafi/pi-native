// piread huge-input lock-ins — feedback.md tool-table P1 pair:
//   "bounded memory contract; tests for huge files, UTF-8 boundaries, binary
//    detection, offset edge cases" and "compaction never rewrites truncation
//    metadata or weakens read-coverage certification".
// The parity suite pins byte-identity with PI_READ_COMPRESS=0; this file pins
// the SHAPED path a real session sees (compaction ON, the shipped default):
// bounded model-visible bytes, continuation pointers that actually continue,
// UTF-8 never split by a byte-budget cut, binary delegation on huge files,
// and R1 certifying only the rendered runs of an elided read (S9 interplay).
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

process.env.PI_NATIVE_READ = "1";
process.env.PI_READ_COMPRESS = "1"; // this suite's whole point: shaping ON

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}
const { createReadTool } = await import(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
const pireadModule = await import("../../extensions/piread/index.ts");
const resetDaemon = pireadModule.__resetDaemonForTest;

const BIN = join(process.cwd(), "bin", "piread");
if (!existsSync(BIN)) {
  console.error(`FATAL  missing ${BIN} — build the native binary first (cargo build -p piread)`);
  process.exit(1);
}

function makePi() {
  const tools = new Map();
  return { tools, registerTool: (def) => tools.set(def.name, def), on: () => () => {} };
}
const pi = makePi();
pireadModule.default(pi);
const wrapped = pi.tools.get("piread");
const oracle = createReadTool(process.cwd());

// ---- fixtures ----
const dir = mkdtempSync(join(tmpdir(), "piread-huge-"));
const MARKER = /^\[\.\.\. omitted \d+ chars \/ \d+ lines \.\.\.\]$/;
const NOTICE = /\[Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\]$/;

const hugePath = join(dir, "huge80k"); // 80k short lines ≈ 2.4 MB — line-cap path
writeFileSync(hugePath, Array.from({ length: 80000 }, (_, i) => `L${String(i + 1).padStart(6, "0")}`).join("\n") + "\n");
const emojiPath = join(dir, "emoji1line"); // one ~45 KB multi-byte line — fits the head cap, beats the compaction budget
writeFileSync(emojiPath, "é🎉€".repeat(5000) + "\n"); // 9 B/rep = 45 001 B ≤ MAX_BYTES(50 KB) > COMPRESS_MAX_BYTES(2 KB)
const emoji9mPath = join(dir, "emoji9m"); // one ~9 MB multi-byte line — head cap empties it before compaction
writeFileSync(emoji9mPath, "é🎉€".repeat(1_000_000) + "\n");
const nulPath = join(dir, "hugeNul"); // 2 MB of text with NULs — binary detection
const nulBuf = Buffer.alloc(2 * 1024 * 1024, 0x61);
nulBuf[100] = 0;
writeFileSync(nulPath, nulBuf);

// ---- cases ----
const cases = [];
const add = (name, fn) => cases.push([name, fn]);
const linesOf = (text) => text.split("\n").filter((l) => !MARKER.test(l.trim()) && !NOTICE.test(l.trim()) && l !== "");

add("huge: whole-file read is bounded, head-first, notice last, compaction reported", async () => {
  const r = await wrapped.execute("h1", { path: hugePath });
  assert.ok(!r.isError, `read failed: ${r.content?.[0]?.text?.slice(0, 120)}`);
  const text = r.content[0].text;
  assert.ok(text.length < 6000, `model-visible bytes must be bounded, got ${text.length}`);
  assert.ok(text.split("\n").some((l) => MARKER.test(l.trim())), `omission marker missing — head: ${JSON.stringify(text.slice(0, 140))} tail: ${JSON.stringify(text.slice(-260))}`);
  const notice = NOTICE.exec(text);
  assert.ok(notice, "continuation notice missing or malformed");
  assert.equal(notice[1], "1", "notice must start at the first rendered line");
  assert.equal(notice[3], "80001", "notice must keep the truncator's total (trailing-newline counting), unrewritten by compaction");
  assert.equal(notice[4], "2001", "notice continuation offset must be truncation-lines+1, unrewritten");
  assert.ok(text.trimEnd().endsWith(notice[0]), "notice must stay last (compaction may not reorder it)");
  assert.ok(text.startsWith("L000001\n"), "first rendered line must be the file's first line");
  const c = r.details?.compaction;
  assert.ok(c && c.omittedChars > 0 && c.originalChars > c.visibleChars, `compaction diagnostics missing: ${JSON.stringify(c)}`);
  return { ok: true, h: notice[2], len: text.length };
});

add("huge: notice continuation pointer actually continues (offset=2001 is seamless)", async () => {
  const r = await wrapped.execute("h2", { path: hugePath, offset: 2001, limit: 5 });
  const b = await oracle.execute("h2o", { path: hugePath, offset: 2001, limit: 5 });
  assert.deepEqual(r.content, b.content, "continuation window must be byte-identical to the built-in (incl. its more-lines note)");
  assert.ok(r.content[0].text.startsWith("L002001\n"), `notice's offset=2001 pointer must land on L002001, got: ${r.content[0].text.slice(0, 40)}`);
  assert.ok(!r.details?.compaction, "a 5-line window must not be compacted");
  return { ok: true };
});

add("huge: deep offset window is verbatim, unshaped, marker-free", async () => {
  const r = await wrapped.execute("h3", { path: hugePath, offset: 40000, limit: 3 });
  const b = await oracle.execute("h3o", { path: hugePath, offset: 40000, limit: 3 });
  assert.deepEqual(r.content, b.content, "deep window must be byte-identical to the built-in");
  assert.ok(r.content[0].text.startsWith("L040000\n"), `deep offset must land on the requested line, got: ${r.content[0].text.slice(0, 40)}`);
  return { ok: true };
});

add("huge: 45KB single multi-byte line — partial cut bounded, no U+FFFD, compaction flagged", async () => {
  const r = await wrapped.execute("h4", { path: emojiPath });
  const text = r.content[0].text;
  assert.ok(text.length < 6000, `byte-budget path must bound output, got ${text.length}`);
  assert.ok(!text.includes("\uFFFD"), "a byte-budget cut must never split a UTF-8 sequence");
  assert.ok(text.split("\n").some((l) => /^\[\.\.\. omitted \d+ chars( \/ \d+ lines)? \.\.\.\]$/.test(l.trim())), `partial-cut marker missing: ${JSON.stringify(text.slice(0, 160))}`);
  const c = r.details?.compaction;
  assert.ok(c && c.omittedChars > 0 && c.partial === true, `single-line cut must report partial compaction, got: ${JSON.stringify(c)}`);
  return { ok: true };
});

add("huge: 9MB single line matches the built-in (empty body + truncation metadata), daemon survives", async () => {
  const a = await wrapped.execute("h4b", { path: emoji9mPath });
  const b = await oracle.execute("h4bo", { path: emoji9mPath });
  assert.equal(a.isError, b.isError);
  assert.deepEqual(a.content, b.content, "over-cap single line must delegate to the built-in's empty-body truncation");
  assert.ok(a.details?.truncation?.firstLineExceedsLimit === true || a.details?.truncation?.truncated === true, `truncation metadata expected: ${JSON.stringify(a.details)}`);
  const next = await wrapped.execute("h4b2", { path: hugePath, offset: 1, limit: 1 });
  assert.ok(next.content[0].text.startsWith("L000001"), "daemon must still serve after the 9MB read");
  return { ok: true };
});

add("huge: 2MB NUL file matches the built-in's binary handling byte-for-byte", async () => {
  const a = await wrapped.execute("h5a", { path: nulPath });
  const b = await oracle.execute("h5b", { path: nulPath });
  assert.equal(a.isError, b.isError);
  assert.deepEqual(a.content, b.content, "huge binary must delegate to the built-in result");
  return { ok: true };
});

// ---- gate interplay: an elided huge read certifies only its rendered runs ----
const { freshGate } = await import("../gate/harness/stub.mjs");
const GATE_CTX = { hasUI: true, mode: "tui", ui: { confirm: async () => true } };
let gateSeq = 0;
async function gateReadFlow(g, path, offset, limit) {
  const toolCallId = `hg${++gateSeq}`;
  const input = offset === undefined ? { path } : { path, offset, limit };
  const block = await g.invoke("tool_call", { type: "tool_call", toolName: "piread", toolCallId, input }, GATE_CTX);
  if (block) return { blocked: true, reason: block.reason };
  const result = await wrapped.execute(toolCallId, input);
  await g.invoke("tool_result", { type: "tool_result", toolName: "piread", toolCallId, input, content: result.content, isError: false, details: result.details }, GATE_CTX);
  return { blocked: false, text: result.content?.[0]?.text ?? "" };
}

add("gate S9: elided huge read certifies rendered runs only — gap passes, rendered re-read blocks", async () => {
  const g = freshGate();
  const first = await gateReadFlow(g, hugePath);
  assert.ok(!first.blocked, first.reason ?? "whole-file read must not block");
  const body = first.text.split("\n");
  let h = 0;
  while (h < body.length && !MARKER.test(body[h].trim())) h++;
  assert.ok(h >= 2 && h < body.length - 1, `no omission marker found (h=${h} of ${body.length}) — gap probe would be meaningless`);
  // Elided gap: a few lines past the head run were never rendered.
  const gap = await gateReadFlow(g, hugePath, h + 5, 3);
  assert.ok(!gap.blocked, `re-read of never-rendered lines must pass, got: ${gap.reason}`);
  // Rendered head: fully-covered re-read must still be caught by R1.
  const dup = await gateReadFlow(g, hugePath, 2, 2);
  assert.ok(dup.blocked, "re-read of fully-rendered lines must still R1-block");
  assert.match(dup.reason, /^Token Economy \(Re-read\)/, `wrong rule fired: ${dup.reason}`);
  return { ok: true, renderedHead: h };
});

// ---- runner ----
let failed = 0;
for (const [name, fn] of cases) {
  let r;
  try { r = (await fn()) ?? { ok: true }; } catch (e) { r = { ok: false, diff: String(e?.message ?? e).slice(0, 500) }; }
  const bad = r && r.ok === false;
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "PASS"}  ${name}`);
  if (bad) console.log(`      ${r.diff.replaceAll("\n", "\n      ")}`);
}
try { resetDaemon?.(); } catch {}
console.log(failed === 0 ? `\n${cases.length}/${cases.length} PASS` : `\n${failed}/${cases.length} FAILED`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
