import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segmentDestructive } from "../../extensions/permission-gate/rules/destructive.ts";
import { toolchainCheck } from "../../extensions/permission-gate/rules/toolchain.ts";

const cwd = mkdtempSync(join(tmpdir(), "permission-gate-toolchain-"));
writeFileSync(join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
after(() => rmSync(cwd, { recursive: true, force: true }));

it("allows read-only npm view in a pnpm repo without treating it as destructive", () => {
  const command = "npm view example-package version";
  assert.equal(segmentDestructive(command), false);
  assert.equal(
    toolchainCheck(command, `cd project && ${command}`, cwd, { pnpm: true, node: false }),
    undefined,
  );
});

it("continues to flag package-mutating npm commands in a pnpm repo", () => {
  assert.match(
    toolchainCheck("npm install example-package", "npm install example-package", cwd, {
      pnpm: true,
      node: false,
    }),
    /Toolchain \(pnpm\)/,
  );
});
