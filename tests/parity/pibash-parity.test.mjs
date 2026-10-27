#!/usr/bin/env node
/**
 * Parity oracle suite for the pibash extension.
 *
 * The built-in bash tool (createBashTool) is the oracle: for a deterministic
 * command matrix the registered `pibash` tool and the oracle must agree on
 * exit code, truncation semantics, and the display/structured envelopes.
 * Byte-identity is asserted for the fields that can be identical (content
 * text modulo the oracle's own temp-file paths, truncation shape, exit code,
 * structured `truncated` flag); timings and temp paths are normalized.
 *
 * Also locks in: env-off = zero registration; env-on = exactly one `pibash`
 * tool whose parameter schema is byte-equal to createBashToolDefinition's;
 * fail-open fallback equals the oracle plus one stderr line.
 *
 * Run: node tests/pibash-parity.test.mjs   (exit 0 = all pass)
 */
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const { createBashTool, createBashToolDefinition } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
);
const pibashModule = await import("../../extensions/pibash/index.ts");
const pibash = pibashModule.default;
const resetDaemon = pibashModule.__resetDaemonForTest;

const BIN = join(ROOT, "bin", "pibash");

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
  const before = process.env.PI_NATIVE_BASH;
  if (envValue === undefined) delete process.env.PI_NATIVE_BASH;
  else process.env.PI_NATIVE_BASH = envValue;
  try {
    const pi = makePi();
    pibash(pi);
    return pi;
  } finally {
    if (before === undefined) delete process.env.PI_NATIVE_BASH;
    else process.env.PI_NATIVE_BASH = before;
  }
}

// ---- oracle + wrapped tool ----

const oracle = createBashTool(process.cwd());
const sdkDefinition = createBashToolDefinition(process.cwd());
const activePi = loadExtension("1");
if (activePi.tools.size !== 1 || !activePi.tools.has("pibash")) {
  console.error("FATAL  env-on extension must register exactly one tool named 'pibash'");
  process.exit(1);
}
const wrapped = activePi.tools.get("pibash");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error("assertion returned false");
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err?.message ?? err}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err?.message ?? err}`);
  }
}

let seq = 0;
async function run(tool, params, ctx) {
  try {
    return { rejected: false, value: await tool.execute(`t${++seq}`, params, undefined, undefined, ctx) };
  } catch (e) {
    return { rejected: true, error: String(e?.message ?? e) };
  }
}

/** Run with a live signal, aborting after delayMs. */
async function runAbortable(tool, params, ctx, delayMs) {
  const controller = new AbortController();
  const call = tool
    .execute("abort", params, controller.signal, undefined, ctx)
    .then(
      (value) => ({ rejected: false, value }),
      (e) => ({ rejected: true, error: String(e?.message ?? e) }),
    );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  controller.abort();
  return call;
}

/** The oracle's execute reads sessionManager for PI_* injection; the harness
 * supplies a minimal stub so the built-in runs outside a live pi session. */
function makeCtx(cwd = process.cwd()) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => 'parity-session',
      getSessionFile: () => undefined,
    },
    model: undefined,
    thinkingLevel: undefined,
  };
}

const NO_UI_CTX = makeCtx();

// ---- registration / definition lock-ins ----

check("env-off (PI_NATIVE_BASH=0) registers no tool", () => {
  const pi = loadExtension("0");
  assert.equal(pi.tools.size, 0);
});

check("env-on registers exactly one tool named 'pibash'", () => {
  assert.equal(activePi.tools.size, 1);
  assert.equal(wrapped.name, "pibash");
  assert.equal(wrapped.label, "pibash");
});

check("parameter schema is byte-equal to createBashToolDefinition's", () => {
  assert.deepStrictEqual(wrapped.parameters, sdkDefinition.parameters);
});

check("description stays bash-shaped (truncation contract preserved)", () => {
  assert.match(wrapped.description, /truncates to the last/);
  // the description must also disclose the gate cap the model actually sees
  assert.match(wrapped.description, /40 lines \/ 2KB/);
});

// ---- command matrix: envelope parity ----

const COMMANDS = [
  "printf 'hello\\n'",
  "printf 'a\\nb\\nc\\n'",
  "echo boom >&2; exit 3",
  "exit 7",
  "true",
  "printf ''",
  "printf 'héllo\\n🎉 emoji\\n'",
  "seq 1 100",
  "seq 1 2500",
  "awk 'BEGIN{for(i=0;i<600;i++) printf \"%*s\\n\", 100, \"\"}'",
  "printf 'x%.0s' $(seq 1 60000)",
  "printf 'no trailing newline'",
  // ---- added edge cases ----
  "printf 'crlf\r\ntext\r\n'",
  "printf 'tab\there'",
  "printf '  leading and trailing  '",
  "printf '\xc3\xa9 unicode ok\n'",
  "printf 'bad \xff byte\n'",
  "printf 'a\nb\nc\nd\ne\n'",
  "printf '%s' ''",
  "printf 'x\n' | head -c 3",
  "seq 1 1999",
  "seq 1 2000",
  "seq 1 2001",
  "seq 1 2100",
  "awk 'BEGIN{print length(\"x\")}' ; printf 'short\n'",
  "printf 'x%.0s' $(seq 1 51199)",
  "printf 'x%.0s' $(seq 1 51200)",
  "printf 'x%.0s' $(seq 1 51201)",
  "sh -c 'exit 0'",
  "false",
  "exit 255",
  "printf 'multi\nline\nstderr' >&2",
  "cd /tmp && pwd",
  "printf '\n'",
  "printf '\n\n\n'",
];

/** Normalize the volatile fields: temp spill paths and wall-clock timing. */
function normalize(result) {
  const value = result.value;
  if (!value) return value;
  const content = (value.content ?? []).map((block) => {
    if (block?.type !== "text") return block;
    const text = String(block.text ?? "")
      .replace(/\/tmp\/[^\s\]]+\.log/g, "<spill>")
      .replace(/\/var\/folders\/[^\s\]]+\.log/g, "<spill>");
    return { ...block, text };
  });
  const structured = value.structuredContent
    ? {
        ...value.structuredContent,
        full_output_path: value.structuredContent.full_output_path
          ? "<spill>"
          : undefined,
        wall_time_seconds: 0,
      }
    : undefined;
  if (structured && structured.full_output_path === undefined) {
    delete structured.full_output_path;
  }
  const details = value.details
    ? {
        ...value.details,
        fullOutputPath: value.details.fullOutputPath ? "<spill>" : undefined,
      }
    : undefined;
  if (details && details.fullOutputPath === undefined) delete details.fullOutputPath;
  return { content, structuredContent: structured, details, isError: value.isError };
}

/**
 * Machine-readable parity: fields that must stay byte-identical to the built-in
 * regardless of display-text compression. Display `text` is intentionally
 * excluded — the Tier-1 Rust engine compresses oversized output, so pibash is
 * no longer the display oracle for large payloads (see compression invariants
 * below).
 */
function machineFields(result) {
  const value = result.value;
  if (!value) return { rejected: result.rejected, error: result.error };
  return {
    isError: value.isError,
    exit_code: value.structuredContent?.exit_code,
    structured_truncated: value.structuredContent?.truncated,
    structured_has_path: typeof value.structuredContent?.full_output_path === "string",
    content_is_text: value.content?.[0]?.type === "text",
  };
}

/** The model-visible budget the Rust Tier-1 engine compresses to — mirrors
 * `compress.rs` COMPRESS_MAX_LINES / COMPRESS_MAX_BYTES and the gate's H1 cap. */
const COMPRESS_MAX_LINES = 40;
const COMPRESS_MAX_BYTES = 2048;

/** True when pibash's display text was compressed (differs from a plain tail
 * view): it carries the Rust omission marker or a head-tail/error-priority
 * shape. Small within-budget output never has these. */
function wasCompressed(text) {
  return /\[\.\.\. omitted |\[\.\.\. repeated /.test(String(text));
}

/** True when the ORACLE display exceeds the model budget, i.e. pibash will
 * intentionally diverge from it by compressing. */
function oracleExceedsBudget(text) {
  const s = String(text);
  return s.split("\n").length > COMPRESS_MAX_LINES || Buffer.byteLength(s, "utf8") > COMPRESS_MAX_BYTES;
}

/**
 * Compression invariants for oversized output: the display must stay within the
 * model-visible budget, carry an explicit omission marker, and preserve UTF-8
 * boundaries. These replace the old byte-identity assertion, which no longer
 * holds by design.
 */
function assertCompressionInvariants(text, label) {
  const s = String(text);
  assert.ok(s.length > 0, `${label}: empty display text`);
  assert.ok(!s.includes("\uFFFD"), `${label}: replacement char (broken UTF-8 boundary)`);
  const lines = s.split("\n").length;
  assert.ok(
    lines <= COMPRESS_MAX_LINES + 4,
    `${label}: ${lines} lines exceeds the ${COMPRESS_MAX_LINES}-line model budget (+marker)`,
  );
  assert.ok(
    Buffer.byteLength(s, "utf8") <= COMPRESS_MAX_BYTES + 512,
    `${label}: exceeds the ${COMPRESS_MAX_BYTES}-byte model budget (+marker)`,
  );
  assert.ok(
    wasCompressed(s) || s.includes("Showing lines") || s.includes("output capped"),
    `${label}: oversized output must carry an omission marker or cap note`,
  );
}

for (const command of COMMANDS) {
  await checkAsync(`parity: ${JSON.stringify(command)}`, async () => {
    resetDaemon();
    const mine = await run(wrapped, { command }, NO_UI_CTX);
    const theirs = await run(oracle, { command }, NO_UI_CTX);

    // Machine-readable fields must match the built-in exactly, always.
    assert.deepStrictEqual(
      machineFields(mine),
      machineFields(theirs),
      "machine-readable fields diverged from the built-in",
    );

    const mineText = mine.value.content[0].text;
    const theirsText = theirs.value.content[0].text;
    if (wasCompressed(mineText) || oracleExceedsBudget(theirsText)) {
      // Over the model budget: display text diverges by design — assert the
      // compression contract (budget, marker, UTF-8 boundaries) instead of
      // byte identity with the built-in.
      assertCompressionInvariants(mineText, JSON.stringify(command));
    } else {
      // Within budget: pibash must still be a byte-identical display oracle.
      assert.deepStrictEqual(normalize(mine), normalize(theirs));
    }
  });
}

// ---- exit code + isError parity ----

await checkAsync("parity: non-zero exit sets isError and the status line", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "exit 3" }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "exit 3" }, NO_UI_CTX);
  assert.equal(mine.value.isError, true);
  assert.equal(theirs.value.isError, true);
  assert.equal(mine.value.structuredContent.exit_code, 3);
  assert.equal(theirs.value.structuredContent.exit_code, 3);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
});

await checkAsync("parity: empty output renders the oracle's placeholder", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "true" }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "true" }, NO_UI_CTX);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
});

// ---- truncation lock-in ----

await checkAsync("truncation: oversized output preserves machine parity + compression contract", async () => {
  resetDaemon();
  const command = "seq 1 2500";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  // Machine-readable fields still match the built-in exactly.
  assert.deepStrictEqual(machineFields(mine), machineFields(theirs));
  assert.equal(mine.value.structuredContent.truncated, theirs.value.structuredContent.truncated);
  // Display text diverges by design: assert the compression contract.
  assertCompressionInvariants(mine.value.content[0].text, "seq 1 2500");
});

await checkAsync("truncation: byte-capped single line stays within budget", async () => {
  resetDaemon();
  const command = "printf 'x%.0s' $(seq 1 60000)";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.deepStrictEqual(machineFields(mine), machineFields(theirs));
  assertCompressionInvariants(mine.value.content[0].text, "single 60k line");
});

// ---- fail-open ladder ----

await checkAsync("fail-open: missing binary equals the oracle plus one stderr line", async () => {
  const hidden = `${BIN}.hidden`;
  if (existsSync(BIN)) renameSync(BIN, hidden);
  resetDaemon();
  const stderr = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk));
    return original(chunk, ...rest);
  };
  let mine;
  try {
    mine = await run(wrapped, { command: "printf 'hi\\n'" }, NO_UI_CTX);
  } finally {
    process.stderr.write = original;
    if (existsSync(hidden)) renameSync(hidden, BIN);
  }
  const theirs = await run(oracle, { command: "printf 'hi\\n'" }, NO_UI_CTX);
  assert.deepStrictEqual(normalize(mine), normalize(theirs));
  const fallbackLines = stderr.filter((line) => line.startsWith("pibash: falling back"));
  assert.equal(fallbackLines.length, 1, `expected exactly one fallback line, got ${JSON.stringify(stderr)}`);
  assert.match(fallbackLines[0], /pibash: falling back to built-in bash/);
});

// ---- daemon protocol lock-ins ----

await checkAsync("daemon: concurrent requests are id-matched in order", async () => {
  resetDaemon();
  const results = await Promise.all([
    run(wrapped, { command: "printf 'one'" }, NO_UI_CTX),
    run(wrapped, { command: "printf 'two'" }, NO_UI_CTX),
    run(wrapped, { command: "printf 'three'" }, NO_UI_CTX),
  ]);
  assert.equal(results[0].value.content[0].text, "one");
  assert.equal(results[1].value.content[0].text, "two");
  assert.equal(results[2].value.content[0].text, "three");
});

await checkAsync("parity: missing cwd rejects exactly like the built-in", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "echo x" }, { ...NO_UI_CTX, cwd: "/definitely/not/here" });
  const theirs = await run(oracle, { command: "echo x" }, { ...NO_UI_CTX, cwd: "/definitely/not/here" });
  // The built-in THROWS here (it does not return an error result), so the
  // native path must throw the same way rather than returning an envelope.
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.match(String(mine.error), /Working directory does not exist/);
});

await checkAsync("daemon: stays healthy after a rejected call", async () => {
  resetDaemon();
  await run(wrapped, { command: "echo x" }, { ...NO_UI_CTX, cwd: "/definitely/not/here" }).catch(() => {});
  const good = await run(wrapped, { command: "printf 'still alive'" }, NO_UI_CTX);
  assert.equal(good.value.content[0].text, "still alive");
});

await checkAsync("daemon: reset then reuse cold-starts cleanly", async () => {
  resetDaemon();
  const first = await run(wrapped, { command: "printf 'a'" }, NO_UI_CTX);
  resetDaemon();
  const second = await run(wrapped, { command: "printf 'b'" }, NO_UI_CTX);
  assert.equal(first.value.content[0].text, "a");
  assert.equal(second.value.content[0].text, "b");
});

await checkAsync("parity: timeout rejects exactly like the built-in", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "sleep 5", timeout: 1 }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "sleep 5", timeout: 1 }, NO_UI_CTX);
  // The built-in THROWS on timeout; the native path must match that shape.
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.match(String(mine.error), /timed out after 1 seconds/);
});

await checkAsync("truncation: details restore contract for spilled output", async () => {
  resetDaemon();
  // A stream beyond the accumulator's 50 KB spill cap: the envelope truncates
  // AND spills, so `details` is present. (A smaller stream compresses to fit
  // the 2 KB budget and emits no envelope-level truncation.)
  const command = "seq 1 20000";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.ok(mine.value.details?.truncation, "spilled output carries details.truncation");
  // Shape parity: the truncation object carries the oracle's field set.
  const oracleKeys = Object.keys(theirs.value.details.truncation).sort();
  assert.deepStrictEqual(Object.keys(mine.value.details.truncation).sort(), oracleKeys);
  // The extension restores `content` from the display text; it must be a
  // prefix of that text (compressed text differs from the oracle by design).
  const restored = mine.value.details.truncation.content;
  const display = mine.value.content[0].text;
  assert.ok(typeof restored === "string" && restored.length > 0, "content restored");
  assert.ok(display.startsWith(restored), "restored content is a prefix of the display text");
  assert.equal(mine.value.structuredContent.truncated, theirs.value.structuredContent.truncated);
});

await checkAsync("parity: timeout parameter shape is accepted like the oracle", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "printf 'quick'", timeout: 30 }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "printf 'quick'", timeout: 30 }, NO_UI_CTX);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
  assert.equal(mine.value.structuredContent.exit_code, theirs.value.structuredContent.exit_code);
});

// ---- operations parity: streaming decode, session env, timeout validation ----

await checkAsync("parity: a character split across reads decodes once", async () => {
  resetDaemon();
  // Two writes with a gap force the pipe to deliver a partial character; the
  // streaming decoder must reassemble it instead of emitting replacement chars.
  const command = "printf '€' | head -c 1; sleep 0.05; printf '€' | tail -c 2; echo";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.deepStrictEqual(normalize(mine), normalize(theirs));
  assert.equal(mine.value.content[0].text, "€\n");
});

await checkAsync("parity: PI_SESSION_ID is injected like the built-in", async () => {
  resetDaemon();
  const command = "printf '%s' \"$PI_SESSION_ID\"";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
  assert.equal(mine.value.content[0].text, "parity-session");
});

await checkAsync("parity: the managed bin dir is prepended to PATH", async () => {
  resetDaemon();
  const command = "case \":$PATH:\" in */.pi/agent/bin:*) printf yes;; *) printf no;; esac";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
});

await checkAsync("parity: PI_* is clear when the context omits it", async () => {
  resetDaemon();
  const command = "printf '%s' \"\${PI_MODEL:-unset}\"";
  const bare = makeCtx();
  const mine = await run(wrapped, { command }, bare);
  const theirs = await run(oracle, { command }, bare);
  assert.equal(mine.value.content[0].text, theirs.value.content[0].text);
});

await checkAsync("parity: invalid timeout rejects like the built-in", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "true", timeout: 0 }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "true", timeout: 0 }, NO_UI_CTX);
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.equal(mine.error, theirs.error);
});

await checkAsync("parity: timeout above the 32-bit ms ceiling rejects like the built-in", async () => {
  resetDaemon();
  const mine = await run(wrapped, { command: "true", timeout: 3_000_000 }, NO_UI_CTX);
  const theirs = await run(oracle, { command: "true", timeout: 3_000_000 }, NO_UI_CTX);
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.equal(mine.error, theirs.error);
});

await checkAsync("parity: a detached child does not block the call", async () => {
  resetDaemon();
  // The background sleep inherits the pipe; the call must return when the shell
  // exits, exactly as the in-process built-in does.
  const command = "sleep 30 & echo done";
  const mine = await run(wrapped, { command }, NO_UI_CTX);
  const theirs = await run(oracle, { command }, NO_UI_CTX);
  assert.deepStrictEqual(normalize(mine), normalize(theirs));
});

await checkAsync("parity: a pre-aborted signal rejects like the built-in", async () => {
  resetDaemon();
  const controller = new AbortController();
  controller.abort();
  const call = async (tool) => {
    try {
      const value = await tool.execute(
        "abort-test",
        { command: "echo hi" },
        controller.signal,
        undefined,
        NO_UI_CTX,
      );
      return { rejected: false, value };
    } catch (e) {
      return { rejected: true, error: String(e?.message ?? e) };
    }
  };
  const mine = await call(wrapped);
  const theirs = await call(oracle);
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.equal(mine.error, theirs.error);
});

// ---- live streaming + mid-run cancellation ----

await checkAsync("streaming: onUpdate receives partial output", async () => {
  resetDaemon();
  const updates = [];
  const command = "for i in 1 2 3 4 5 6 7 8; do printf '%s\n' \"$i\"; sleep 0.06; done";
  const result = await wrapped.execute(
    "stream-test",
    { command },
    undefined,
    (update) => updates.push(update),
    NO_UI_CTX,
  );
  assert.ok(updates.length >= 2, "expected streamed updates, got " + updates.length);
  const texts = updates.map((u) => u.content?.[0]?.text ?? "");
  assert.ok(
    texts.some((text) => text.length > 0),
    "no partial text: " + JSON.stringify(texts),
  );
  assert.ok(result.content[0].text.includes("8"), "final result keeps the full output");
});

await checkAsync("cancel: an aborted call rejects like the built-in", async () => {
  resetDaemon();
  const command = "printf before; sleep 10";
  const mine = await runAbortable(wrapped, { command }, NO_UI_CTX, 300);
  const theirs = await runAbortable(oracle, { command }, NO_UI_CTX, 300);
  assert.equal(mine.rejected, true);
  assert.equal(theirs.rejected, true);
  assert.match(String(mine.error), /Command aborted/);
  assert.equal(mine.error, theirs.error);
});

console.log(`\n${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
