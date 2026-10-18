#!/usr/bin/env node
/**
 * Parity oracle suite for the piread extension (S6 Step 3, spec §5.3).
 *
 * The built-in read tool (createReadTool) is the oracle: for a deterministic
 * fixture corpus and an offset/limit matrix, the registered `piread` tool
 * and the oracle must produce identical results — content arrays, details,
 * structuredContent — or identical rejection messages.
 *
 * Also locks in: env-off = zero registration; env-on = exactly one `piread`
 * tool with an individual name/label and a schema byte-equal to
 * createReadToolDefinition's (distinct registration, 2026-10-18); fail-open
 * fallback (missing binary, error envelope, garbage stdout) equals the
 * oracle plus one stderr line.
 *
 * Preflight: symlink the global pi package into the gitignored root
 * node_modules (same trick as tests/permission-gate.test.mjs).
 *
 * Run: node tests/piread-parity.test.mjs   (exit 0 = all pass)
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createReadTool, createReadToolDefinition } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
const pireadModule = await import("../extensions/piread/index.ts");
const piread = pireadModule.default;
const resetDaemon = pireadModule.__resetDaemonForTest;

const BIN = join(ROOT, "bin", "piread");

// This suite's whole contract is byte-identity with the built-in `read`, so it
// must run the pipeline WITHOUT the head-tail compaction that is on by default
// for real sessions (PI_READ_COMPRESS=0). Compaction has its own coverage in
// custom-tools/piread/src/compress.rs and tests/model-visible-baseline.mjs.
process.env.PI_READ_COMPRESS = "0";

// ---- stubbed ExtensionAPI capturing registered tools ----

function makePi() {
  const tools = new Map();
  return {
    tools,
    registerTool: (def) => tools.set(def.name, def),
    on: () => () => {},
  };
}

function loadExtension(envValue) {
  const before = process.env.PI_NATIVE_READ;
  if (envValue === undefined) delete process.env.PI_NATIVE_READ;
  else process.env.PI_NATIVE_READ = envValue;
  try {
    const pi = makePi();
    piread(pi);
    return pi;
  } finally {
    if (before === undefined) delete process.env.PI_NATIVE_READ;
    else process.env.PI_NATIVE_READ = before;
  }
}

// ---- oracle + wrapped tool ----

const oracle = createReadTool(process.cwd());
const sdkDefinition = createReadToolDefinition(process.cwd());
const activePi = loadExtension("1");
if (activePi.tools.size !== 1 || !activePi.tools.has("piread")) {
  console.error("FATAL  env-on extension must register exactly one tool named 'piread'");
  process.exit(1);
}
const wrapped = activePi.tools.get("piread");

// ---- deterministic corpus (spec §5.3) ----

const dir = mkdtempSync(join(tmpdir(), "piread-parity-"));
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//9k=",
  "base64",
);

const textFixtures = [
  ["empty", ""],
  ["one-line", "solo\n"],
  ["crlf", "one\r\ntwo\r\nthree\r\n"],
  ["no-eol", "alpha\nbeta\ngamma"],
  ["unicode", "héllo\n🎉emoji\n€€€€€€€€\n"],
  ["long-lines", Array.from({ length: 20 }, (_, i) => `${String(i).padStart(3, "0")}:${"x".repeat(296)}`).join("\n") + "\n"],
  ["t2500", Array.from({ length: 2500 }, (_, i) => `line${String(i).padStart(4, "0")}`).join("\n") + "\n"],
  ["b600", Array.from({ length: 600 }, () => "x".repeat(100)).join("\n")],
  ["big1st", "y".repeat(60000) + "\nsmall\n"],
  ["bad-utf8", Buffer.from([0x61, 0xff, 0x62, 0x0a, 0x63, 0xfe, 0x0a])],
  ["nul-text", "ab\0cd\0ef\n"],
  ["mid30", Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n")],
];

for (const [name, body] of textFixtures) {
  writeFileSync(join(dir, name), body);
}
writeFileSync(join(dir, "img.png"), PNG_1X1);
writeFileSync(join(dir, "img.jpg"), JPG_1X1);
mkdirSync(join(dir, "a-directory"));
const missingPath = join(dir, "does-not-exist");

// ---- comparison helpers ----

let seq = 0;
async function armResult(tool, params, ctx) {
  try {
    return { rejected: false, value: await tool.execute(`t${++seq}`, params, undefined, undefined, ctx) };
  } catch (e) {
    return { rejected: true, error: String(e?.message ?? e) };
  }
}

async function parityCase(params, ctx) {
  const a = await armResult(wrapped, params, ctx);
  const b = await armResult(oracle, params, ctx);
  // The rung is carried on details.via (TUI/observability) instead of a
  // "[piread native]" content marker; a real fallback also carries
  // details.fallbackReason. Assert the rung, then drop both before the
  // byte-parity compare (the oracle has neither field).
  if (!a.rejected && !b.rejected) {
    assert.ok(
      a.value?.details?.via === "daemon" || a.value?.details?.via === "oneshot" || a.value?.details?.via === "builtin",
      `piread result missing details.via (got ${a.value?.details?.via})`,
    );
  }
  if (!a.rejected && a.value?.details) {
    delete a.value.details.via;
    delete a.value.details.fallbackReason;
    // Match the oracle's own-property `details: undefined` (deepStrictEqual
    // distinguishes an absent key from one explicitly set to undefined).
    if (Object.keys(a.value.details).length === 0) a.value.details = undefined;
  }
  try {
    assert.deepStrictEqual(a, b);
    return { ok: true };
  } catch (e) {
    const norm = (s) => s.replaceAll(dir, "<dir>").slice(0, 300);
    return { ok: false, diff: `${norm(e.message)}\n  piread: ${JSON.stringify(a).slice(0, 260)}\n  oracle: ${JSON.stringify(b).slice(0, 260)}` };
  }
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return { run: async () => fn(), done: () => { process.stderr.write = orig; return chunks; } };
}

// ---- cases ----

const cases = [];
const add = (name, fn) => cases.push([name, fn]);

// env gating + registration lock-in (R2)
add("env gate: default-on registers piread unless PI_NATIVE_READ=0", () => {
  // Default-on (D5 flip): unset registers; explicit 0 opts out.
  const unsetPi = loadExtension(undefined);
  assert.equal(unsetPi.tools.size, 1);
  assert.ok(unsetPi.tools.has("piread"), "unset must register 'piread' (default on)");
  assert.equal(loadExtension("0").tools.size, 0);
});
add("env gate: PI_NATIVE_READ=1 registers exactly one 'piread' tool", () => {
  const pi = loadExtension("1");
  assert.equal(pi.tools.size, 1);
  assert.ok(pi.tools.has("piread"), "registered tool must be named 'piread'");
});
add("registration: individual name/label, schema byte-equal to createReadToolDefinition", () => {
  assert.equal(wrapped.name, "piread");
  assert.equal(wrapped.label, "piread");
  assert.notEqual(wrapped.description, sdkDefinition.description);
  assert.match(wrapped.description, /piread/);
  assert.equal(wrapped.promptSnippet, sdkDefinition.promptSnippet);
  assert.deepStrictEqual(wrapped.parameters, sdkDefinition.parameters);
  assert.deepStrictEqual(wrapped.outputSchema, sdkDefinition.outputSchema);
  assert.deepStrictEqual(wrapped.constrainedSampling, sdkDefinition.constrainedSampling);
});

// corpus × offset/limit matrix (pathological params delegate → trivially equal)
const variants = [
  {}, { offset: 1 }, { offset: 2, limit: 3 }, { offset: 5, limit: 2 },
  { offset: 29, limit: 5 }, { offset: 2001 }, { offset: 999999 },
  { limit: 1 }, { offset: 1, limit: 0 }, { offset: 0 }, { offset: 2.5, limit: 1 },
];
for (const [name] of textFixtures) {
  for (const v of variants) {
    add(`parity: ${name} ${JSON.stringify(v)}`, () => parityCase({ path: join(dir, name), ...v }));
  }
}

// images (delegated to the built-in instance on both arms)
add("parity: png image delegates to built-in", () => parityCase({ path: join(dir, "img.png") }));
add("parity: jpg image delegates to built-in", () => parityCase({ path: join(dir, "img.jpg") }));

// errors
add("parity: missing file rejects identically", () => parityCase({ path: missingPath }));
add("parity: missing file with offset rejects identically", () => parityCase({ path: missingPath, offset: 3 }));
add("parity: directory rejects identically", () => parityCase({ path: join(dir, "a-directory") }));
add("parity: undefined path rejects identically", () => parityCase({ path: undefined }));
// NBSP in the path must normalize to a space (built-in resolveToCwd), not open
// a literal-NBSP sibling — the extension pre-resolves with the same rules.
add("parity: NBSP path normalizes to the space variant (no wrong-file read)", async () => {
  writeFileSync(join(dir, "nbsp space.txt"), "SPACE\n");
  writeFileSync(join(dir, "nbsp\u00a0space.txt"), "NBSP\n");
  return parityCase({ path: join(dir, "nbsp\u00a0space.txt") });
});

// relative path resolves against ctx.cwd on both arms
add("parity: relative path via ctx.cwd", () => {
  const ctx = { cwd: dir };
  return parityCase({ path: "mid30", offset: 10, limit: 5 }, ctx);
});

// fallback: fail-open to the oracle plus one stderr line
// (resetDaemon kills any live daemon first: the cold-start paths under test
// are "binary missing/garbage before first daemon start" — a live daemon
// would keep serving from the renamed inode, which is correct production
// behavior but not what these two cases pin.)
add("fallback: missing binary → oracle result + one stderr line", async () => {
  const bak = `${BIN}.parity-bak`;
  renameSync(BIN, bak);
  resetDaemon();
  try {
    const cap = captureStderr(() => parityCase({ path: join(dir, "no-eol") }));
    const r = await cap.run();
    const lines = cap.done();
    if (!r.ok) return r;
    const fb = lines.filter((l) => l.startsWith("piread: fallback"));
    assert.equal(fb.length, 1, `expected exactly one fallback line, got: ${JSON.stringify(lines)}`);
  } finally {
    renameSync(bak, BIN);
  }
});
add("fallback: error envelope (exit 3) → oracle rejection + stderr line", async () => {
  const cap = captureStderr(() => parityCase({ path: missingPath }));
  const r = await cap.run();
  const lines = cap.done();
  if (!r.ok) return r;
  assert.ok(lines.some((l) => l.startsWith("piread: fallback (exit 3)")), JSON.stringify(lines));
});
add("fallback: garbage stdout → oracle result + stderr line", async () => {
  const bak = `${BIN}.parity-bak`;
  renameSync(BIN, bak);
  writeFileSync(BIN, "#!/bin/sh\necho 'not-json at all'\n");
  chmodSync(BIN, 0o755);
  resetDaemon();
  try {
    const cap = captureStderr(() => parityCase({ path: join(dir, "no-eol") }));
    const r = await cap.run();
    const lines = cap.done();
    if (!r.ok) return r;
    assert.ok(lines.some((l) => l.startsWith("piread: fallback (unparseable stdout)")), JSON.stringify(lines));
  } finally {
    unlinkSync(BIN);
    renameSync(bak, BIN);
  }
});

// ---- cross-rung parity: daemon vs one-shot vs built-in ----
// piread is idempotent, so it may always fall through; the CONTENT must be
// byte-identical no matter which rung served the call, and every rung must
// tag details.via (the terminal rung also tags details.fallbackReason).
// Inputs cover the shapes that differ per rung: a plain read, an
// offset/limit window, a missing file, a directory, a binary (NUL) file, an
// offset beyond EOF, and CRLF text.

/** Standalone child script for the cross-rung check. Runs in its own process
 * so no daemon state leaks between rungs; prints one JSON array of
 * `{label, d, o, b}` where each arm is `{rej, text, via, fr}`. */
const CROSS_RUNG_CHILD_SRC = String.raw`
import { writeFileSync, chmodSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [ROOT, REAL_BIN] = process.argv.slice(2);
const m = await import(join(ROOT, "extensions/piread/index.ts"));
const pi = { tools: new Map(), registerTool: (d) => pi.tools.set(d.name, d), on: () => () => {} };
process.env.PI_NATIVE_READ = "1"; m.default(pi);
const t = pi.tools.get("piread"); const reset = m.__resetDaemonForTest;
const dir = mkdtempSync(join(tmpdir(), "cr-"));
mkdirSync(join(dir, "a-directory"));
writeFileSync(join(dir, "mid30"), Array.from({ length: 30 }, (_, i) => "L" + i).join("\n"));
writeFileSync(join(dir, "nul-text"), "ab\u0000cd\u0000ef\n");
writeFileSync(join(dir, "crlf"), "one\r\ntwo\r\nthree\r\n");
const WRAP = join(dir, "wrap");
writeFileSync(WRAP, "#!/bin/sh\ncase \"$1\" in\n  --serve) exit 1 ;;\nesac\nexec \"" + REAL_BIN + "\" \"$@\"\n");
chmodSync(WRAP, 0o755);
const MISSING = join(dir, "no-such-bin");
const ctx = { cwd: dir };
async function arm(p) {
  try {
    const v = await t.execute("x", p, undefined, undefined, ctx);
    return { rej: false, text: (v.content ?? []).map((c) => c.text ?? "").join(""), via: v.details?.via, fr: v.details?.fallbackReason };
  } catch (e) {
    return { rej: true, text: "REJECT: " + String(e.message), via: undefined, fr: undefined };
  }
}
async function withBin(bin, p) { reset(); process.env.PI_READ_BIN = bin; return arm(p); }
const inputs = [
  ["plain", { path: join(dir, "mid30") }],
  ["offset/limit", { path: join(dir, "mid30"), offset: 5, limit: 4 }],
  ["crlf", { path: join(dir, "crlf") }],
  ["missing", { path: join(dir, "nope") }],
  ["directory", { path: join(dir, "a-directory") }],
  ["binary", { path: join(dir, "nul-text") }],
  ["offset beyond EOF", { path: join(dir, "mid30"), offset: 10000 }],
];
const out = [];
for (const [label, p] of inputs) {
  const d = await withBin(REAL_BIN, p);
  const o = await withBin(WRAP, p);
  const b = await withBin(MISSING, p);
  out.push({ label, d, o, b });
}
console.log(JSON.stringify(out));
`;

// Content parity across the three rungs. Each rung is forced through the
// `PI_READ_BIN` override (resolved per call) rather than by swapping the
// checked-in `bin/piread`:
//   daemon/one-shot  -> a copy of the real binary (one-shot: a wrapper whose
//                       `--serve` fails so dispatch falls to the one-shot spawn)
//   built-in         -> a path that does not exist (daemon + one-shot fail)
// The check runs in a CHILD process: rapidly switching PI_READ_BIN and
// resetting the daemon inside one long-lived process wedges on the failed
// child's inherited stdio (observed reliably), whereas a fresh process with a
// clean daemon lifecycle is deterministic. The child prints one JSON blob;
// this test asserts on it. This is the only place the one-shot rung is
// exercised end to end.
add("cross-rung: content is byte-identical across daemon/one-shot/built-in", () => {
  if (!existsSync(BIN)) return { ok: false, diff: `missing binary ${BIN}` };
  const childSrc = join(dir, "cross-rung-child.mjs");
  writeFileSync(childSrc, CROSS_RUNG_CHILD_SRC);
  const res = spawnSync(process.execPath, [childSrc, ROOT, BIN], { encoding: "utf8" });
  if (res.status !== 0) {
    return { ok: false, diff: `child exited ${res.status}\n${(res.stderr ?? "").slice(-400)}` };
  }
  let rows;
  try {
    rows = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, diff: `child stdout not JSON: ${e.message}\n${res.stdout.slice(0, 200)}` };
  }
  const validVia = (v) => v === "daemon" || v === "oneshot" || v === "builtin";
  for (const { label, d, o, b } of rows) {
    // Byte-identical content/errors no matter which rung served the call.
    if (o.text !== d.text) return { ok: false, diff: `one-shot content differs from daemon for ${label}` };
    if (b.text !== d.text) return { ok: false, diff: `built-in content differs from daemon for ${label}` };
    for (const [name, r] of [["daemon", d], ["one-shot", o], ["built-in", b]]) {
      if (!r.rej && !validVia(r.via)) return { ok: false, diff: `${name} via for ${label} (got ${r.via})` };
    }
    // A successful envelope is served by its own rung: daemon and one-shot
    // carry no fallbackReason; built-in is itself a fallback.
    if (!d.rej && d.via === "daemon") {
      if (d.fr !== undefined) return { ok: false, diff: `daemon fallbackReason for ${label}` };
      if (o.via !== "oneshot") return { ok: false, diff: `one-shot via for ${label} (got ${o.via})` };
      if (o.fr !== undefined) return { ok: false, diff: `one-shot fallbackReason for ${label}` };
      if (b.via !== "builtin") return { ok: false, diff: `built-in via for ${label} (got ${b.via})` };
      if (typeof b.fr !== "string") return { ok: false, diff: `built-in fallbackReason for ${label}` };
    }
  }
  return { ok: true };
});

// ---- PI_READ_LINE_CAP (default OFF) ----
// Off by default the native read must stay byte-identical to the built-in
// (edit's exact matching depends on line fidelity). When set, only lines OVER
// the cap are truncated, with a `...[+N chars]` marker; shorter lines are
// untouched.

add("line-cap: default OFF keeps long lines byte-identical to the oracle", async () => {
  const path = join(dir, "long-lines");
  const before = process.env.PI_READ_LINE_CAP;
  delete process.env.PI_READ_LINE_CAP;
  try {
    const a = await armResult(wrapped, { path });
    const b = await armResult(oracle, { path });
    assert.ok(!a.rejected && !b.rejected, "both arms should succeed");
    assert.equal(a.value.content[0].text, b.value.content[0].text, "default OFF must be byte-identical");
    assert.ok(!a.value.content[0].text.includes("...[+"), "no marker when the cap is off");
  } finally {
    if (before === undefined) delete process.env.PI_READ_LINE_CAP;
    else process.env.PI_READ_LINE_CAP = before;
  }
  return { ok: true };
});

add("line-cap: set caps only lines over the limit, tagging the dropped count", async () => {
  const path = join(dir, "long-lines"); // 20 lines of 300 chars each
  const before = process.env.PI_READ_LINE_CAP;
  process.env.PI_READ_LINE_CAP = "50";
  try {
    const r = await armResult(wrapped, { path });
    assert.ok(!r.rejected, `capped read should succeed: ${r.error}`);
    const text = r.value.content[0].text;
    const lines = text.split("\n");
    // Each fixture line is 300 chars; capped at 50 → 50 + "...[+250 chars]".
    assert.match(lines[0], /^\d{3}:x{46}\.\.\.\[\+250 chars\]$/, `first line: ${lines[0]}`);
    assert.ok(text.includes("...[+250 chars]"), "dropped count marker missing");
    assert.ok(!lines[0].includes("x".repeat(47)), "line not actually cut at the cap");
  } finally {
    if (before === undefined) delete process.env.PI_READ_LINE_CAP;
    else process.env.PI_READ_LINE_CAP = before;
  }
  return { ok: true };
});

// ---- daemon (persistent dispatch) lock-ins ----
// The wrapped tool now dispatches through a lazy-started `piread --serve`
// daemon (spawn-floor fix). These pin the client behaviors parity does not:
// id matching under concurrency, lazy restart after death, abort semantics.

add("daemon: concurrent dispatches keep responses matched", async () => {
  const paths = ["one-line", "crlf", "unicode", "mid30", "no-eol"].map((n) => join(dir, n));
  const wrappedResults = await Promise.all(
    paths.map((path, i) => armResult(wrapped, { path, offset: i === 3 ? 3 : undefined, limit: i === 3 ? 2 : undefined }))
  );
  for (let i = 0; i < paths.length; i++) {
    const b = await armResult(oracle, {
      path: paths[i],
      offset: i === 3 ? 3 : undefined,
      limit: i === 3 ? 2 : undefined,
    });
    try {
      // Drop details.via/fallbackReason before the structural compare (the
      // oracle has neither field); the rung itself is asserted by the primary
      // parity cases.
      const a = wrappedResults[i];
      if (!a.rejected && a.value?.details) {
        delete a.value.details.via;
        delete a.value.details.fallbackReason;
        if (Object.keys(a.value.details).length === 0) a.value.details = undefined;
      }
      assert.deepStrictEqual(a, b);
    } catch (e) {
      return { ok: false, diff: `concurrent dispatch ${paths[i]}: ${e.message}` };
    }
  }
  return { ok: true };
});

add("daemon: lazy restart after death (no fallback line)", async () => {
  const path = join(dir, "one-line");
  const warm = await armResult(wrapped, { path }); // ensures a daemon exists
  resetDaemon(); // kills it — next dispatch must lazily restart
  const cap = captureStderr(() => armResult(wrapped, { path }));
  const r = await cap.run();
  const lines = cap.done();
  if (!r.ok) return r;
  const fb = lines.filter((l) => l.startsWith("piread: fallback"));
  if (fb.length > 0) return { ok: false, diff: `restart must not fall back: ${JSON.stringify(fb)}` };
  try {
    assert.deepStrictEqual(r.value, warm);
  } catch (e) {
    return { ok: false, diff: `post-restart result differs: ${e.message}` };
  }
  return { ok: true };
});

add("daemon: pre-aborted signal rejects like the one-shot path", async () => {
  const path = join(dir, "one-line");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    wrapped.execute("abort-1", { path }, controller.signal),
    (e) => /abort/i.test(String(e?.message ?? e)),
  );
});

// ---- gate compatibility (Step 4): real permission-gate through stubbed events ----
// The gate intercepts by tool NAME (read/edit) and event type — it must stay
// agnostic to who executes. Lock-ins: R1 coverage certification from a
// piread-wrapped result, S5 M2 region-read requirement satisfied by piread
// output, and a protected-path (node_modules) read blocked at tool_call
// before any execution.

const { freshGate } = await import("./lib/gate-stub.mjs");
const GATE_CTX = { hasUI: true, mode: "tui", ui: { confirm: async () => true } };

let gateSeq = 0;
/** tool_call → wrapped execute → tool_result, feeding the wrapped result's
 * content/details to the gate exactly as the harness would. */
async function gateReadFlow(pi, tool, path, offset, limit, name = "piread") {
  const toolCallId = `g${++gateSeq}`;
  const input = offset === undefined ? { path } : { path, offset, limit };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: name, toolCallId, input }, GATE_CTX);
  if (block) return { blocked: true, reason: block.reason };
  const result = await tool.execute(toolCallId, input);
  await pi.invoke("tool_result", { type: "tool_result", toolName: name, toolCallId, input, content: result.content, isError: false, details: result.details }, GATE_CTX);
  return { blocked: false };
}
async function gateReadProbe(pi, path, offset, limit, name = "piread") {
  const input = offset === undefined ? { path } : { path, offset, limit };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: name, toolCallId: `g${++gateSeq}`, input }, GATE_CTX);
  return block ? { blocked: true, reason: block.reason } : { blocked: false };
}
async function gateEditProbe(pi, path, edits) {
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "edit", toolCallId: `g${++gateSeq}`, input: { path, edits } }, GATE_CTX);
  return block ? { blocked: true, reason: block.reason } : { blocked: false };
}

add("gate R1: piread-wrapped read result certifies coverage (dup read blocked)", async () => {
  const pi = freshGate();
  const path = join(dir, "mid30");
  const first = await gateReadFlow(pi, wrapped, path, 10, 5);
  assert.ok(!first.blocked, first.reason ?? "first read must not block");
  const dup = await gateReadProbe(pi, path, 12, 2); // sub-window of certified lines 10–14
  assert.ok(dup.blocked, "re-read of a piread-certified window must block");
  assert.match(dup.reason, /^Token Economy \(Re-read\)/, `reason was: ${dup.reason}`);
});
add("gate S5 M2: edit-after-piread-read passes region requirement", async () => {
  const path = join(dir, "mid30");
  // negative control: the same edit with no prior read must block (proves the
  // gate is armed — the pass below is not vacuous)
  const control = freshGate();
  const unread = await gateEditProbe(control, path, [{ oldText: "L11", newText: "L11-edited" }]);
  assert.ok(unread.blocked, "negative control: unread edit must block");
  assert.match(unread.reason, /^Anchor Guard \(Unread\)/, `reason was: ${unread.reason}`);
  const pi = freshGate();
  const first = await gateReadFlow(pi, wrapped, path, 10, 5);
  assert.ok(!first.blocked, first.reason ?? "read must not block");
  const edit = await gateEditProbe(pi, path, [{ oldText: "L11", newText: "L11-edited" }]);
  assert.ok(!edit.blocked, edit.reason ?? "edit within the piread-certified region must pass");
});
add("gate: node_modules read passes through to execution (NM1 removed 2026-10-18)", async () => {
  const nmDir = join(dir, "node_modules", "left-pad");
  mkdirSync(nmDir, { recursive: true });
  const nmPath = join(nmDir, "index.js");
  writeFileSync(nmPath, "module.exports = 42;\n");
  const pi = freshGate();
  const pireadPi = loadExtension("1");
  const tool = pireadPi.tools.get("piread");
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "piread", toolCallId: "g-nm", input: { path: nmPath } }, GATE_CTX);
  assert.ok(!block, `node_modules read must pass (got: ${block?.reason})`);
  const result = await tool.execute("g-nm", { path: nmPath });
  assert.ok(result, "read must execute after the gate passes it");
});

// ---- runner ----

let failed = 0;
for (const [name, fn] of cases) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, diff: String(e?.message ?? e).slice(0, 400) };
  }
  const bad = r && r.ok === false;
  if (bad) failed++;
  console.log(`${bad ? "FAIL" : "PASS"}  ${name}`);
  if (bad) console.log(`      ${r.diff.replaceAll("\n", "\n      ")}`);
}

console.log(failed === 0 ? `\n${cases.length}/${cases.length} PASS` : `\n${failed}/${cases.length} FAILED`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
