#!/usr/bin/env node
/** SE2 fail-closed tier — the shipped severity.
 *
 * One week of sessions logged 107 reader-bypass warns and no behavior change:
 * the note taught nothing the model had not already learned, and a warn/off
 * toggle moved no number. SE2 now blocks like P1/P2/P3 do for the native
 * tools, and the reason names the piread call that replaces the command.
 *
 * Run: node --test tests/gate/reader-bypass-error.test.mjs
 * (env set BEFORE the import — the loader reads it at import time). */
process.env.PGATE_CONFIG = new URL("./fixtures/rules-calibrated.json", import.meta.url).pathname;
process.env.PGATE_READER_BYPASS = "error";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic imports: ESM hoists static imports, so the env above would apply
// only after the gate (and its loader) had already read the config.
const { freshGate, bash } = await import("./harness/helpers.mjs");

const FILE = join(mkdtempSync(join(tmpdir(), "se2-error-")), "a.txt");
writeFileSync(FILE, "one\ntwo\nthree\nfour\nfive\n");

const readers = [
  ["cat", `cat ${FILE}`],
  ["head", `head -n 2 ${FILE}`],
  ["tail", `tail -n 2 ${FILE}`],
  ["tail wide bytes", `tail -c 400 ${FILE}`],
  ["head one byte", `head -c 1 ${FILE}`],
  ["sed -n", `sed -n '1,2p' ${FILE}`],
];

for (const [shape, command] of readers) {
  test(`${shape} as a file reader blocks with the piread fix`, async () => {
    const r = await bash(freshGate(), command);
    assert.equal(r.blocked, true, `${shape} must block at error`);
    assert.match(r.reason, /Reader-bypass/);
    assert.match(r.reason, /piread/, "the reason must name the replacement tool");
    assert.ok(
      /offset\/limit/.test(r.reason) && /hits/.test(r.reason) && /outline/.test(r.reason),
      "the reason must carry all three piread equivalents",
    );
  });
}

test("a standalone literal head or sed view gets exact piread arguments", async () => {
  for (const [command, expected] of [
    [`head -n 2 ${FILE}`, { path: FILE, offset: 1, limit: 2 }],
    [`sed -n '2,3p' ${FILE}`, { path: FILE, offset: 2, limit: 2 }],
    [`cat ${FILE}`, { path: FILE }],
  ]) {
    const r = await bash(freshGate(), command);
    assert.equal(r.blocked, true);
    assert.ok(r.reason.includes(`piread ${JSON.stringify(expected)}`), r.reason);
  }
});

test("byte windows and pipelines keep generic guidance", async () => {
  for (const command of [`tail -c 400 ${FILE}`, `head -n 2 ${FILE} | wc -l`]) {
    const r = await bash(freshGate(), command);
    assert.equal(r.blocked, true);
    assert.doesNotMatch(r.reason, /piread \{/);
  }
});

const allowed = [
  ["a piped view", `printf 'x\\n' | head -1`],
  ["a piped sed filter", `printf 'x\\n' | sed -n '1,1p'`],
  ["a cat write", `printf 'x\\n' | cat > ${FILE}.out`],
  ["jq", `jq -r '.name' ${FILE}`],
  ["a concatenation write", `cat ${FILE} ${FILE} > ${FILE}.out`],
  ["an append write", `cat ${FILE} >> ${FILE}.out`],
  ["a sed extract write", `sed -n '1,2p' ${FILE} > ${FILE}.out`],
  ["the one-byte newline probe", `tail -c 1 ${FILE}`],
  ["the append-guard composite", `printf 'x' >> ${FILE}.out; tail -c 1 ${FILE}.out`],
];

for (const [shape, command] of allowed) {
  test(`${shape} is not a file read and passes`, async () => {
    const r = await bash(freshGate(), command);
    assert.equal(r.blocked, false, `${shape} must pass: ${r.reason ?? ""}`);
  });
}
