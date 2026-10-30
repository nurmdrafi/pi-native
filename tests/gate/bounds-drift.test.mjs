// Pins the single-source-of-truth contract: every generated bounds file must
// match scripts/gen-bounds.mjs's table. An edit to the table without a
// regen (or a hand-edit of a generated file) fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("generated bounds files match the table (no drift)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/gen-bounds.mjs"), "--check"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `drift detected — regenerate: ${r.stdout}${r.stderr}`);
});
