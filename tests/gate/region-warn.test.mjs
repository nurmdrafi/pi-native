#!/usr/bin/env node
/**
 * AG2 (`editRegionGuard`) at `warn` — severity must be honored the way it is
 * for every other rule. With `warn`:
 *   - an anchor outside the certified read window passes (the exact-match
 *     check still applies),
 *   - a never-read path and a wrong anchor pass with an AG warn note (AG
 *     demoted 2026-10-28: the edit pipeline enforces oldText correctness).
 *
 * Default stays `error` until live sessions justify relaxing it
 * (docs/plans/permission_gate_implementation_plan.md §12).
 * Run: node tests/gate/region-warn.test.mjs  (env set BEFORE the gate import).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.PGATE_EDIT_REGION_GUARD = "warn";

const { freshGate } = await import("./harness/stub.mjs");
const { read, edit, runEdit, noteOf, tmp } = await import("./harness/helpers.mjs");

const lines = (n) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n") + "\n";

test("AG2 at warn: anchor outside the read window passes", async () => {
  const pi = freshGate();
  const f = join(tmp, "region-warn-outside.ts");
  writeFileSync(f, lines(60));
  await read(pi, f, { offset: 1, limit: 10 }, { outputLines: 10 }); // certifies 1–10
  const r = await edit(pi, f, [{ oldText: "l50", newText: "x" }]);
  assert.equal(r.blocked, false, r.reason ?? "blocked");
});

test("AG2 at warn: never-read path carries an Unread note", async () => {
  const pi = freshGate();
  const f = join(tmp, "region-warn-never.ts");
  writeFileSync(f, "alpha\nbeta\ngamma\n");
  const r = await runEdit(pi, f, [{ oldText: "beta", newText: "BETA" }]);
  assert.equal(r.blocked, false, r.reason ?? "blocked");
  assert.match(noteOf(r), /Anchor Guard \(Unread\)/);
});

test("AG2 at warn: a non-matching anchor carries an AG note", async () => {
  const pi = freshGate();
  const f = join(tmp, "region-warn-wrong.ts");
  writeFileSync(f, lines(60));
  await read(pi, f, { offset: 1, limit: 10 }, { outputLines: 10 });
  const r = await runEdit(pi, f, [{ oldText: "not-in-file", newText: "x" }]);
  assert.equal(r.blocked, false, r.reason ?? "blocked");
  assert.match(noteOf(r), /Anchor Guard/);
});
