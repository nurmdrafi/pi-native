// The rule table at the top of the gate entry file is the reader-facing
// description of what the gate enforces. It drifted from the code twice: rows
// for live rules were missing, and H1's numbers disagreed with the bounds the
// cap actually uses. Both are checked here so a new rule cannot land without a
// row and a bounds change cannot leave a stale number in prose.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "extensions/permission-gate");
const source = readFileSync(join(GATE, "index.ts"), "utf8");
const { RULE_IDS } = await import(join(GATE, "loader.ts"));
const bounds = await import(join(GATE, "bounds.gen.ts"));

test("every rule in RULE_IDS has a row in the rule table", () => {
  const missing = Object.values(RULE_IDS).filter(
    (id) => !new RegExp(String.raw`^\s\*\s\|\s${id}\s*\|`, "m").test(source),
  );
  assert.deepEqual(missing, [], `rule table is missing rows for: ${missing.join(", ")}`);
});

test("H1's prose cap matches the bounds the cap actually uses", () => {
  const row = source.split("\n").find((l) => /^\s\*\s\|\sH1\s*\|/.test(l)) ?? "";
  assert.ok(row, "H1 row present");
  assert.match(
    row,
    new RegExp(String.raw`\b${bounds.BASH_CAP_LINES} lines\b`),
    `H1 row must state ${bounds.BASH_CAP_LINES} lines`,
  );
  assert.match(
    row,
    new RegExp(String.raw`\b${Math.round(bounds.BASH_CAP_BYTES / 1024)}KB\b`),
    `H1 row must state ${Math.round(bounds.BASH_CAP_BYTES / 1024)}KB`,
  );
});
