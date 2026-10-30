// Isolation probe: describe-body setup + optional index.ts dynamic import.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRootFor } from "../../extensions/subagents/inbox.ts";

describe("A: plain describe body", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-desc-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  const nested = join(dir, "packages", "app");
  mkdirSync(nested, { recursive: true });

  it("finds .git from nested", () => {
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(repoRootFor(nested), dir);
  });
});

describe("B: with index.ts dynamic import", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-desc-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  const nested = join(dir, "packages", "app");
  mkdirSync(nested, { recursive: true });

  it("finds .git from nested after importing index.ts", async () => {
    await import("../../extensions/subagents/index.ts");
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(repoRootFor(nested), dir);
  });
});
