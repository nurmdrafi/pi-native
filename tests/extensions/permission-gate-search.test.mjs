// 2026-11-18 code review (finding 5): the SE2 jq bound must resolve the file
// operand against the bash cwd, not the gate process cwd — a relative operand
// from any other cwd silently skips the reader-bypass warn.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readerBypassCheck } from "../../extensions/permission-gate/rules/search-guard.ts";

test("R6: jq oversized operand resolves against the passed cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "jq-cwd-"));
  try {
    writeFileSync(join(dir, "big.json"), '{"x":"' + "a".repeat(1_100_000) + '"}');
    // resolves via cwd → flagged
    assert.match(readerBypassCheck("jq -r '.x' big.json", dir) ?? "", /Reader-bypass/);
    // same command, unrelated cwd → nothing to flag
    assert.equal(readerBypassCheck("jq -r '.x' big.json", tmpdir()), undefined);
    // small file stays allowed
    writeFileSync(join(dir, "small.json"), "{}");
    assert.equal(readerBypassCheck("jq -r '.name' small.json", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
