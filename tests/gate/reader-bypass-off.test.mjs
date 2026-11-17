#!/usr/bin/env node
/** SE2 off rung — `"off"` must be silent, not a warning.
 *
 * The gate's `enforce` helper routed every non-`error` severity to warnCall,
 * so an `off` rule still noted on every match: config.json shipped SE2 as
 * `off` while 107 reader-bypass warns landed in one week of sessions, and
 * turning SE2 to `warn` looked identical. The severity ladder is now
 * off → nothing, warn → note, error → block, in one place.
 *
 * Run: node --test tests/gate/reader-bypass-off.test.mjs
 * (env set BEFORE the import — the loader reads it at import time). */
process.env.PGATE_CONFIG = new URL("./fixtures/rules-calibrated.json", import.meta.url).pathname;
process.env.PGATE_READER_BYPASS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic imports: ESM hoists static imports, so the env above would apply
// only after the gate (and its loader) had already read the config.
const { freshGate, textBlocks, nextId } = await import("./harness/helpers.mjs");

const AUTO_CTX = { hasUI: true, mode: "tui", ui: { confirm: async () => true } };
const FILE = join(mkdtempSync(join(tmpdir(), "se2-off-")), "a.txt");
writeFileSync(FILE, "one\ntwo\n");

/** pibash call + result; returns the block and the note text the gate added */
async function probe(pi, command) {
  const toolCallId = `off${nextId()}`;
  const input = { command };
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "pibash", toolCallId, input },
    AUTO_CTX,
  );
  if (block) return { block, text: "" };
  const res = await pi.invoke("tool_result", {
    type: "tool_result",
    toolName: "pibash",
    toolCallId,
    input,
    content: textBlocks("one\ntwo"),
    isError: false,
  });
  const text = (res?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { block, text };
}

for (const command of [`cat ${FILE}`, `head -n 1 ${FILE}`, `sed -n '1,2p' ${FILE}`]) {
  test(`off severity keeps '${command.split(" ")[0]} <file>' silent`, async () => {
    const { block, text } = await probe(freshGate(), command);
    assert.equal(block, undefined, "off must not block");
    assert.ok(
      !text.includes("Reader-bypass"),
      `off must not warn, got note: ${text}`,
    );
  });
}
