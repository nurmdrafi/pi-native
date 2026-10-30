#!/usr/bin/env node
/**
 * Parity oracle suite for the piedit extension (S8 Step 3, spec §5.4).
 *
 * The built-in edit tool (createEditTool) is the oracle: for a deterministic
 * fixture corpus, the registered `piedit` tool and the oracle must produce
 * identical results — final file bytes, thrown error message, `content` text,
 * and `details.{diff,patch,firstChangedLine}` — or identical rejections.
 *
 * Also locks in: registration is unconditional (no env opt-out); exactly one `piedit`
 * tool with an individual name/label and a schema byte-equal to
 * createEditToolDefinition's; fail-open fallback (missing binary, garbage
 * stdout, non-zero exit) equals the oracle plus one stderr line.
 *
 * Preflight: symlink the global pi package into the gitignored root
 * node_modules (same trick as tests/piread-parity.test.mjs).
 *
 * Run: node tests/piedit-parity.test.mjs   (exit 0 = all pass)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createEditTool, createEditToolDefinition } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
const pieditModule = await import("../../extensions/piedit/index.ts");
const piedit = pieditModule.default;
const resetDaemon = pieditModule.__resetDaemonForTest;

const BIN = join(ROOT, "bin", "piedit");

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
  const before = process.env.PI_NATIVE_EDIT;
  if (envValue === undefined) delete process.env.PI_NATIVE_EDIT;
  else process.env.PI_NATIVE_EDIT = envValue;
  try {
    const pi = makePi();
    piedit(pi);
    return pi;
  } finally {
    if (before === undefined) delete process.env.PI_NATIVE_EDIT;
    else process.env.PI_NATIVE_EDIT = before;
  }
}

// ---- oracle + wrapped tool ----

const oracle = createEditTool(process.cwd());
const sdkDefinition = createEditToolDefinition(process.cwd());
const activePi = loadExtension("1");
if (activePi.tools.size !== 1 || !activePi.tools.has("piedit")) {
  console.error("FATAL  env-on extension must register exactly one tool named 'piedit'");
  process.exit(1);
}
const wrapped = activePi.tools.get("piedit");

// ---- deterministic corpus ----

const dir = mkdtempSync(join(tmpdir(), "piedit-parity-"));
const F = (name) => join(dir, name);

/** Write a fixture body and return its path. */
function fixture(name, body) {
  const p = F(name);
  writeFileSync(p, body);
  return p;
}

// ---- comparison helpers ----

let seq = 0;
async function armResult(tool, params, ctx) {
  try {
    return { rejected: false, value: await tool.execute(`t${++seq}`, params, undefined, undefined, ctx) };
  } catch (e) {
    return { rejected: true, error: String(e?.message ?? e) };
  }
}

/** Run both arms on fresh copies of the same body; compare bytes + result. */
async function parityBody(name, body, edits, ctx) {
  const mineName = `${name}.piedit`;
  const oracleName = `${name}.oracle`;
  const minePath = fixture(mineName, body);
  const oraclePath = fixture(oracleName, body);
  const mapPath = (p) => p.replaceAll(mineName, "<F>").replaceAll(oracleName, "<F>");
  const a = await armResult(wrapped, { path: minePath, edits }, ctx);
  const b = await armResult(oracle, { path: oraclePath, edits }, ctx);
  const norm = (r, path) => {
    // Normalize the two distinct fixture names to a placeholder everywhere a
    // path can appear (content text, patch header, rejection message), then
    // attach the on-disk bytes produced by this arm.
    const map = (v) =>
      JSON.parse(JSON.stringify(v ?? null), (_k, val) =>
        typeof val === "string" ? mapPath(val) : val,
      );
    if (r.rejected) return { rejected: true, error: mapPath(r.error) };
    return {
      rejected: false,
      content: map(r.value.content),
      details: map(r.value.details),
      bytes: readFileSafe(path),
    };
  };
  // Compare result shape (path-normalized) AND final bytes on disk.
  const na = norm(a, minePath);
  const nb = norm(b, oraclePath);
  try {
    assert.deepStrictEqual(na, nb);
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `${name}: ${e.message.slice(0, 400)}` };
  }
}

function readFileSafe(p) {
  try {
    return p === undefined ? undefined : readFileSync(p, "utf8");
  } catch {
    return "<<unreadable>>";
  }
}

/** Single-path case (error paths, missing file, directory): no fresh copies —
 * both arms hit the same target, so neither should mutate it. */
async function paritySamePath(name, path, edits, ctx) {
  const a = await armResult(wrapped, { path, edits }, ctx);
  const b = await armResult(oracle, { path, edits }, ctx);
  const norm = (r) => (r.rejected ? { rejected: true, error: r.error } : { rejected: false, value: r.value });
  try {
    assert.deepStrictEqual(norm(a), norm(b));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `${name}: ${e.message.slice(0, 400)}` };
  }
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    run: async () => fn(),
    done: () => {
      process.stderr.write = orig;
      return chunks;
    },
  };
}

// ---- cases ----

const cases = [];
const add = (name, fn) => cases.push([name, fn]);

// registration lock-in: unconditional — no env arm decides whether the tool
// exists; choosing the built-in edit is a configuration decision.
add("env gate: registers piedit with PI_NATIVE_EDIT unset, 0, or 1", () => {
  for (const value of [undefined, "0", "1"]) {
    const pi = loadExtension(value);
    assert.equal(pi.tools.size, 1, `PI_NATIVE_EDIT=${String(value)} must still register`);
    assert.ok(pi.tools.has("piedit"), "registered tool must be named 'piedit'");
  }
});
add("registration: individual name/label, schema byte-equal to createEditToolDefinition", () => {
  assert.equal(wrapped.name, "piedit");
  assert.equal(wrapped.label, "piedit");
  assert.notEqual(wrapped.description, sdkDefinition.description);
  assert.match(wrapped.description, /piedit/);
  assert.equal(wrapped.promptSnippet, sdkDefinition.promptSnippet);
  assert.deepStrictEqual(wrapped.parameters, sdkDefinition.parameters);
  assert.deepStrictEqual(wrapped.outputSchema, sdkDefinition.outputSchema);
  assert.deepStrictEqual(wrapped.constrainedSampling, sdkDefinition.constrainedSampling);
  assert.equal(wrapped.renderShell, sdkDefinition.renderShell);
});

// parity corpus (spec §5.4) — fresh copies per arm
const corpus = [
  ["single-exact", "alpha\nbeta\ngamma\n", [{ oldText: "beta", newText: "BETA" }]],
  ["multi-disjoint", "a\nb\nc\nd\n", [{ oldText: "a", newText: "A" }, { oldText: "d", newText: "D" }]],
  ["fuzzy-trailing-ws", "keep\ntarget   \nkeep\n", [{ oldText: "target\n", newText: "TARGET\n" }]],
  ["fuzzy-smart-quotes", "say \u201Chi\u201D \u2013 done\n", [{ oldText: 'say "hi" - done', newText: "said hi" }]],
  ["fuzzy-nbsp", "a\u00A0b\n", [{ oldText: "a b", newText: "a-b" }]],
  ["fuzzy-nfkc", "caf\u00E9\n", [{ oldText: "cafe\u0301", newText: "coffee" }]],
  ["crlf-file", "one\r\ntwo\r\nthree\r\n", [{ oldText: "two", newText: "TWO" }]],
  ["crlf-fuzzy", "one  \r\ntwo  \r\nthree  \r\n", [{ oldText: "two", newText: "TWO" }]],
  ["bom-file", "\uFEFFone\ntwo\n", [{ oldText: "two", newText: "TWO" }]],
  ["bom-crlf", "\uFEFFone\r\ntwo\r\n", [{ oldText: "two", newText: "TWO" }]],
  ["no-trailing-eol", "alpha\nbeta\ngamma", [{ oldText: "gamma", newText: "GAMMA" }]],
  ["unicode-emoji", "héllo\n🎉emoji\n€€€\n", [{ oldText: "🎉emoji", newText: "🎊EMOJI" }]],
  ["replace-with-multiline", "x\n", [{ oldText: "x", newText: "a\nb\nc" }]],
  ["replace-with-empty", "a\nb\nc\n", [{ oldText: "b", newText: "" }]],
  ["multi-same-line", "one two three\n", [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }]],
  ["large-1mib", Array.from({ length: 60000 }, (_, i) => `line${i}`).join("\n") + "\n", [{ oldText: "line59999", newText: "LAST" }]],
  // ---- diff/patch render adversarial corpus (native render parity) ----
  // multi-hunk: two changes 26 lines apart → two @@ hunks + display elision
  ["multi-hunk", Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n", [{ oldText: "l1", newText: "X" }, { oldText: "l28", newText: "Z" }]],
  // gap of exactly 2×context between changes (display shows whole, patch closes one hunk)
  ["gap-8-lines", Array.from({ length: 14 }, (_, i) => `g${i}`).join("\n") + "\n", [{ oldText: "g0", newText: "A" }, { oldText: "g9", newText: "B" }]],
  // change at the very top: leading-context-only hunk
  ["change-at-top", Array.from({ length: 12 }, (_, i) => `t${i}`).join("\n") + "\n", [{ oldText: "t0", newText: "TOP" }]],
  // pure insertion (adds only, no removed line)
  ["pure-insertion", "a\nb\nc\n", [{ oldText: "b", newText: "b1\nb2\nb3" }]],
  // pure deletion (newText empty)
  ["pure-deletion", "a\nb\nc\n", [{ oldText: "b", newText: "" }]],
  // change that removes the trailing newline (old has none) → no-newline markers
  ["no-eof-newline", "alpha\nbeta\ngamma", [{ oldText: "gamma", newText: "GAMMA" }]],
  // replacement introduces no trailing newline where the file had one
  ["eof-newline-dropped", "a\nb\n", [{ oldText: "b\n", newText: "B" }]],
  // repeated identical lines around the change (Myers tie-break)
  ["repeated-lines", "x\nx\nx\ny\nx\nx\nx\n", [{ oldText: "y", newText: "z" }]],
  // blank + whitespace-only lines
  ["blank-lines", "a\n\n \n  \nb\n", [{ oldText: " ", newText: "SP" }]],
  // large-block multi-line replacement (multiline-block class from the bench)
  ["multiline-block", `${Array.from({ length: 2000 }, (_, i) => `block${i}`).join("\n")}\n`, [{ oldText: "block1000\nblock1001\nblock1002", newText: "BLOCKS" }]],
  // same-line multi-edit (two edits, one line)
  ["two-edits-one-line", "one two three four\n", [{ oldText: "one", newText: "1" }, { oldText: "three four", newText: "3 4" }]],
];
for (const [name, body, edits] of corpus) {
  add(`parity: ${name}`, () => parityBody(name, body, edits));
}

// error paths — missing / no-change / duplicate / overlap / empty / not-found
add("parity: duplicate anchor rejects identically", () =>
  parityBody("dup", "x\nx\n", [{ oldText: "x", newText: "y" }]));
add("parity: duplicate (multi-edit) rejects identically", () =>
  parityBody("dup-multi", "x\nx\n", [{ oldText: "x\nx", newText: "y" }, { oldText: "x", newText: "z" }]));
add("parity: overlap rejects identically", () =>
  parityBody("overlap", "abcdef\n", [{ oldText: "abc", newText: "X" }, { oldText: "bcd", newText: "Y" }]));
add("parity: empty oldText rejects identically", () =>
  parityBody("empty", "x\n", [{ oldText: "", newText: "y" }]));
add("parity: empty oldText (multi) rejects identically", () =>
  parityBody("empty-multi", "x\n", [{ oldText: "x", newText: "y" }, { oldText: "", newText: "z" }]));
add("parity: no-change rejects identically", () =>
  parityBody("nochange", "x\n", [{ oldText: "x", newText: "x" }]));
add("parity: no-change (multi) rejects identically", () =>
  parityBody("nochange-multi", "x\ny\n", [{ oldText: "x", newText: "x" }, { oldText: "y", newText: "y" }]));
add("parity: not-found rejects identically", () =>
  parityBody("notfound", "x\n", [{ oldText: "zzz", newText: "y" }]));
add("parity: missing file rejects identically", () =>
  paritySamePath("missing", join(dir, "does-not-exist"), [{ oldText: "a", newText: "b" }]));
add("parity: directory path rejects identically", async () => {
  const d = join(dir, "a-directory");
  mkdirSync(d, { recursive: true });
  return paritySamePath("directory", d, [{ oldText: "a", newText: "b" }]);
});

// relative path resolves against ctx.cwd on both arms
add("parity: relative path via ctx.cwd", async () => {
  const body = "alpha\nbeta\ngamma\n";
  const mine = fixture("rel.piedit", body);
  const orc = fixture("rel.oracle", body);
  const ctx = { cwd: dir };
  const a = await armResult(wrapped, { path: "rel.piedit", edits: [{ oldText: "beta", newText: "BETA" }] }, ctx);
  const b = await armResult(oracle, { path: "rel.oracle", edits: [{ oldText: "beta", newText: "BETA" }] }, ctx);
  try {
    const map = (v) =>
      JSON.parse(JSON.stringify(v ?? null), (_k, val) =>
        typeof val === "string" ? val.replaceAll("rel.piedit", "<F>").replaceAll("rel.oracle", "<F>") : val,
      );
    assert.equal(a.rejected, b.rejected);
    assert.deepStrictEqual(readFileSafe(mine), readFileSafe(orc));
    assert.deepStrictEqual(map(a.value?.content), map(b.value?.content));
    assert.deepStrictEqual(map(a.value?.details), map(b.value?.details));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `relative: ${e.message.slice(0, 400)}` };
  }
});

// user-path resolution parity (the SDK's resolveToCwd: @ strip, ~ expand,
// file:// URLs, unicode-space normalize). The extension pre-resolves with a
// mirror of resolveToCwd, so the native rung acts on the same file.
add("parity: @-prefixed path resolves like the built-in", async () => {
  const body = "alpha\nbeta\n";
  const mine = fixture("at.piedit", body);
  const orc = fixture("at.oracle", body);
  const a = await armResult(wrapped, { path: `@${mine}`, edits: [{ oldText: "beta", newText: "BETA" }] });
  const b = await armResult(oracle, { path: `@${orc}`, edits: [{ oldText: "beta", newText: "BETA" }] });
  try {
    assert.equal(a.rejected, b.rejected);
    assert.deepStrictEqual(readFileSafe(mine), readFileSafe(orc));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `@-prefix: ${e.message.slice(0, 400)}` };
  }
});
add("parity: file:// URL resolves like the built-in", async () => {
  const body = "alpha\nbeta\n";
  const mine = fixture("url.piedit", body);
  const orc = fixture("url.oracle", body);
  const a = await armResult(wrapped, { path: `file://${mine}`, edits: [{ oldText: "beta", newText: "BETA" }] });
  const b = await armResult(oracle, { path: `file://${orc}`, edits: [{ oldText: "beta", newText: "BETA" }] });
  try {
    assert.equal(a.rejected, b.rejected);
    assert.deepStrictEqual(readFileSafe(mine), readFileSafe(orc));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `file-url: ${e.message.slice(0, 400)}` };
  }
});
add("parity: ~ path resolves like the built-in", async () => {
  const body = "alpha\nbeta\n";
  const mine = join(homedir(), `.piedit-parity-tilde-${process.pid}-a`);
  const orc = join(homedir(), `.piedit-parity-tilde-${process.pid}-b`);
  writeFileSync(mine, body);
  writeFileSync(orc, body);
  try {
    const a = await armResult(wrapped, { path: `~/${basename(mine)}`, edits: [{ oldText: "beta", newText: "BETA" }] });
    const b = await armResult(oracle, { path: `~/${basename(orc)}`, edits: [{ oldText: "beta", newText: "BETA" }] });
    assert.equal(a.rejected, b.rejected);
    assert.deepStrictEqual(readFileSafe(mine), readFileSafe(orc));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `tilde: ${e.message.slice(0, 400)}` };
  } finally {
    rmSync(mine, { force: true });
    rmSync(orc, { force: true });
  }
});
add("parity: NBSP path normalizes to the space variant", async () => {
  const body = "alpha\nbeta\n";
  const mine = fixture("nbsp mine.piedit", body);
  const orc = fixture("nbsp orc.oracle", body);
  const nbsp = (s) => s.replaceAll(" ", "\u00a0");
  const a = await armResult(wrapped, { path: nbsp(mine), edits: [{ oldText: "beta", newText: "BETA" }] });
  const b = await armResult(oracle, { path: nbsp(orc), edits: [{ oldText: "beta", newText: "BETA" }] });
  try {
    assert.equal(a.rejected, b.rejected);
    assert.deepStrictEqual(readFileSafe(mine), readFileSafe(orc));
    return { ok: true };
  } catch (e) {
    return { ok: false, diff: `nbsp: ${e.message.slice(0, 400)}` };
  }
});
// validation parity (built-in validateEditInput order/message)
add("parity: empty edits array rejects identically", () =>
  paritySamePath("empty-edits", fixture("ee.piedit", "x\n"), []));
add("parity: non-array edits rejects identically", () =>
  paritySamePath("nonarray-edits", fixture("na.piedit", "x\n"), "nope"));
// read-only target → EACCES wrapper, not a raw write error
add("parity: read-only file rejects identically", async () => {
  const body = "alpha\n";
  const mine = fixture("ro.piedit", body);
  const orc = fixture("ro.oracle", body);
  chmodSync(mine, 0o444);
  chmodSync(orc, 0o444);
  try {
    const a = await armResult(wrapped, { path: mine, edits: [{ oldText: "alpha", newText: "A" }] });
    const b = await armResult(oracle, { path: orc, edits: [{ oldText: "alpha", newText: "A" }] });
    try {
      assert.equal(a.rejected, b.rejected);
      assert.equal(String(a.error).replaceAll("ro.piedit", "<F>"), String(b.error).replaceAll("ro.oracle", "<F>"));
      return { ok: true };
    } catch (e) {
      return { ok: false, diff: `read-only: ${e.message.slice(0, 400)}` };
    }
  } finally {
    chmodSync(mine, 0o644);
    chmodSync(orc, 0o644);
  }
});

// fallback: fail-open to the oracle plus one stderr line
add("native failure: missing binary → tool error + one stderr line", async () => {
  const bak = `${BIN}.parity-bak`;
  renameSync(BIN, bak);
  resetDaemon(); // cold-start path: no live daemon may serve from the renamed inode
  try {
    const mine = fixture("native-failure-missing.piedit", "alpha\nbeta\n");
    const cap = captureStderr(async () =>
      armResult(wrapped, { path: mine, edits: [{ oldText: "beta", newText: "BETA" }] }),
    );
    const a = await cap.run();
    const lines = cap.done();
    if (!a.rejected || !/native edit unavailable/.test(a.error))
      return { ok: false, diff: `expected native-unavailable rejection, got ${JSON.stringify(a)}` };
    const fb = lines.filter((l) => l.startsWith("piedit: native unavailable"));
    assert.equal(fb.length, 1, `expected exactly one failure line, got: ${JSON.stringify(lines)}`);
    // no built-in rung: the file must be untouched
    assert.equal(readFileSafe(mine), "alpha\nbeta\n");
  } finally {
    renameSync(bak, BIN);
  }
});
add("native failure: garbage stdout → tool error + one stderr line", async () => {
  const bak = `${BIN}.parity-bak`;
  renameSync(BIN, bak);
  writeFileSync(BIN, "#!/bin/sh\necho 'not-json at all'\n");
  chmodSync(BIN, 0o755);
  resetDaemon(); // cold-start path: no live daemon may serve from the renamed inode
  try {
    const mine = fixture("native-failure-garbage.piedit", "alpha\nbeta\n");
    const cap = captureStderr(async () =>
      armResult(wrapped, { path: mine, edits: [{ oldText: "beta", newText: "BETA" }] }),
    );
    const a = await cap.run();
    const lines = cap.done();
    if (!a.rejected || !/native edit unavailable/.test(a.error))
      return { ok: false, diff: `expected native-unavailable rejection, got ${JSON.stringify(a)}` };
    assert.ok(lines.some((l) => l.startsWith("piedit: native unavailable")), JSON.stringify(lines));
    assert.equal(readFileSafe(mine), "alpha\nbeta\n");
  } finally {
    unlinkSync(BIN);
    renameSync(bak, BIN);
  }
});

// ---- daemon (persistent dispatch) lock-ins ----
// The wrapped tool dispatches through a lazy-started `piedit --serve` daemon
// (spawn-floor fix). These pin the client behaviors parity does not: id
// matching under concurrency, lazy restart after death, abort semantics.

add("daemon: concurrent dispatches keep responses matched", async () => {
  const names = ["d-one", "d-two", "d-three", "d-four"];
  const paths = names.map((n) => fixture(n, "alpha\nbeta\ngamma\n"));
  const edits = names.map((_, i) => [{ oldText: "beta", newText: `BETA${i}` }]);
  const got = await Promise.all(
    paths.map((p, i) => wrapped.execute(`d${i}`, { path: p, edits: edits[i] })),
  );
  for (let i = 0; i < paths.length; i++) {
    assert.deepStrictEqual(readFileSafe(paths[i]), `alpha\nBETA${i}\ngamma\n`);
    assert.match(got[i].content[0].text, new RegExp(`BETA${i}|block`));
  }
});

add("daemon: lazy restart after death (no fallback line)", async () => {
  const path = fixture("d-restart", "alpha\nbeta\n");
  const first = await wrapped.execute("dr1", { path, edits: [{ oldText: "beta", newText: "BETA" }] }); // ensures a daemon exists
  resetDaemon(); // kill it — next dispatch must lazily restart
  const path2 = fixture("d-restart2", "alpha\nbeta\n");
  const cap = captureStderr(() => wrapped.execute("dr2", { path: path2, edits: [{ oldText: "beta", newText: "BETA" }] }));
  const r = await cap.run();
  const lines = cap.done();
  const fb = lines.filter((l) => l.startsWith("piedit: fallback"));
  assert.equal(fb.length, 0, `restart must not fall back: ${JSON.stringify(fb)}`);
  assert.equal(r.details.diff, first.details.diff);
  assert.equal(r.details.firstChangedLine, first.details.firstChangedLine);
  assert.match(r.content[0].text, /^Successfully replaced 1 block\(s\) in /);
  assert.deepStrictEqual(readFileSafe(path2), "alpha\nBETA\n");
});

add("daemon: pre-aborted signal rejects like the one-shot path", async () => {
  const path = fixture("d-abort", "alpha\nbeta\n");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    wrapped.execute("d-abort", { path, edits: [{ oldText: "beta", newText: "BETA" }] }, controller.signal),
    (e) => /abort/i.test(String(e?.message ?? e)),
  );
  assert.deepStrictEqual(readFileSafe(path), "alpha\nbeta\n"); // untouched
});

// ---- gate compatibility (Step 4): real permission-gate through stubbed events ----
// The gate intercepts by tool NAME (edit/piedit share the edit-kind branch)
// and event type — it must stay agnostic to who executes. Lock-ins: Anchor
// Guard block reasons identical for `edit` and `piedit` on the same fixture,
// the read→edit region binding honored for piedit, and a protected-path
// `piedit` call blocked at tool_call before execution.

const { freshGate } = await import("../gate/harness/stub.mjs");
const GATE_CTX = { hasUI: true, mode: "tui", ui: { confirm: async () => true } };

let gateSeq = 0;
function gateEditProbe(pi, toolName, path, edits) {
  return pi.invoke(
    "tool_call",
    { type: "tool_call", toolName, toolCallId: `pg${++gateSeq}`, input: { path, edits } },
    GATE_CTX,
  );
}

/** call + result replay: warn-tier AG rides the tool_result as a note — the
 * parity contract post-2026-10-28 demotion is identical NOTES, not blocks */
async function gateEditVerdict(pi, toolName, path, edits) {
  const id = `pg${++gateSeq}`;
  const input = { path, edits };
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName, toolCallId: id, input },
    GATE_CTX,
  );
  if (block) return `BLOCKED: ${block.reason}`;
  const res = await pi.invoke(
    "tool_result",
    { type: "tool_result", toolName, toolCallId: id, input, content: [{ type: "text", text: "ok" }], isError: false },
    GATE_CTX,
  );
  const note = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  return `PASS: ${note}`;
}

add("gate: unread piedit edit warns identically to edit (Anchor Guard Unread)", async () => {
  const path = fixture("gate-unread.txt", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\n");
  const a = await gateEditVerdict(freshGate(), "edit", path, [{ oldText: "L3", newText: "X" }]);
  const b = await gateEditVerdict(freshGate(), "piedit", path, [{ oldText: "L3", newText: "X" }]);
  assert.ok(!a.startsWith("BLOCKED"), `edit must pass with a note: ${a}`);
  assert.ok(!b.startsWith("BLOCKED"), `piedit must pass with a note: ${b}`);
  assert.equal(b, a, "piedit and edit must produce identical warn notes");
  assert.match(a, /Anchor Guard \(Unread\)/, `note was: ${a}`);
});

add("gate: overlapping piedit edits warn identically to edit", async () => {
  const path = fixture("gate-overlap.txt", "abcdef\n");
  const edits = [{ oldText: "abc", newText: "X" }, { oldText: "bcd", newText: "Y" }];
  const a = await gateEditVerdict(freshGate(), "edit", path, edits);
  const b = await gateEditVerdict(freshGate(), "piedit", path, edits);
  assert.ok(!a.startsWith("BLOCKED") && !b.startsWith("BLOCKED"), `both must pass with notes: ${a} / ${b}`);
  assert.equal(b, a, "piedit and edit must produce identical warn notes");
  assert.match(a, /overlap/i, `note was: ${a}`);
});

add("gate: missing anchor warns identically for edit and piedit", async () => {
  const path = fixture("gate-missing.txt", "present\n");
  const edits = [{ oldText: "absent-text", newText: "X" }];
  const a = await gateEditVerdict(freshGate(), "edit", path, edits);
  const b = await gateEditVerdict(freshGate(), "piedit", path, edits);
  assert.ok(!a.startsWith("BLOCKED") && !b.startsWith("BLOCKED"), `both must pass with notes: ${a} / ${b}`);
  assert.equal(b, a, "piedit and edit must produce identical warn notes");
  assert.match(a, /not found/i, `note was: ${a}`);
});

add("gate: read→piedit wins the region requirement", async () => {
  const path = fixture("gate-region.txt", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n");
  const pi = freshGate();
  // Negative control: the same edit with no prior read must warn (Unread).
  const unread = await gateEditVerdict(freshGate(), "piedit", path, [{ oldText: "L3", newText: "L3-edited" }]);
  assert.ok(!unread.startsWith("BLOCKED"), `unread piedit edit must pass, not block: ${unread}`);
  assert.match(unread, /Anchor Guard \(Unread\)/, `negative control note was: ${unread}`);
  // Read the region through the piread tool so the gate certifies it
  // (P1, 2026-10-15: built-in `read` on text files is blocked piread-first).
  const { createReadTool } = await import(
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
  );
  const readTool = createReadTool(process.cwd());
  const readId = `pg${++gateSeq}`;
  const readInput = { path, offset: 1, limit: 5 };
  const readBlock = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "piread", toolCallId: readId, input: readInput },
    GATE_CTX,
  );
  assert.ok(!readBlock, readBlock?.reason ?? "read must not block");
  const readResult = await readTool.execute(readId, readInput);
  await pi.invoke(
    "tool_result",
    { type: "tool_result", toolName: "piread", toolCallId: readId, input: readInput, content: readResult.content, isError: false, details: readResult.details },
    GATE_CTX,
  );
  // An anchor inside the certified region now passes with no AG note.
  const pass = await gateEditVerdict(pi, "piedit", path, [{ oldText: "L3", newText: "L3-edited" }]);
  assert.ok(!pass.startsWith("BLOCKED"), `certified-region edit must pass: ${pass}`);
  assert.ok(!pass.includes("Anchor Guard"), `region requirement must be satisfied (note-free): ${pass}`);
});

add("gate: protected-path piedit blocks at tool_call before execution", async () => {
  // Protected path = ~/.ssh under the process HOME (destructive.ts). Headless
  // ctx (hasUI:false) makes the H2 ladder fail closed, so the edit-kind
  // protected-path confirm blocks before piedit ever executes.
  const fakeHome = join(dir, "fake-home");
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  const keyPath = join(fakeHome, ".ssh", "id_rsa");
  writeFileSync(keyPath, "PRIVATE KEY\n");
  const before = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const pi = freshGate();
    const pieditPi = loadExtension("1");
    const tool = pieditPi.tools.get("piedit");
    let executions = 0;
    const orig = tool.execute;
    tool.execute = (...a) => {
      executions++;
      return orig(...a);
    };
    const block = await pi.invoke(
      "tool_call",
      { type: "tool_call", toolName: "piedit", toolCallId: "pg-prot", input: { path: keyPath, edits: [{ oldText: "PRIVATE", newText: "PUBLIC" }] } },
      { hasUI: false, mode: "tui" },
    );
    assert.ok(block, "protected-path piedit must block at tool_call (headless fail-closed)");
    assert.equal(executions, 0, "blocked piedit must never reach execute");
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
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
