import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./session-blocks.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/hygiene-block.jsonl", import.meta.url));

// The tool is argv-driven (imports extension TS, reads --session), so drive it
// as a subprocess exactly the way the audit sweeps do.
const report = () =>
  JSON.parse(execFileSync(process.execPath, [TOOL, "--session", FIXTURE, "--json"], { encoding: "utf8" }));

test("hygiene gate block lands in the block ledger under family 'hygiene'", () => {
  const r = report();
  assert.equal(r.blocks.total, 1, `blocks.total: ${JSON.stringify(r.blocks.byFamily)}`);
  assert.deepEqual(r.blocks.byFamily, { hygiene: 1 });
});

test("hygiene block is not misfiled as a non-gate error; the ordinary error still is", () => {
  const r = report();
  assert.equal(r.errors.total, 1);
  assert.match(r.errors.ledger[0].head, /^piread:/);
});
