import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "gate-block-recovery-"));
const audit = fileURLToPath(new URL("./block-recovery.mjs", import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));

it("counts current gate families and ignores non-error notes", () => {
  const records = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc" }] },
    {
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "Toolchain (pnpm): use pnpm exec." }],
    },
    { role: "assistant", content: [{ type: "toolCall", id: "locate" }] },
    {
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "Locate-first: search before reading." }],
    },
    {
      role: "toolResult",
      isError: false,
      content: [{ type: "text", text: "Token Economy (Re-read): advisory note." }],
    },
    {
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "Error: mentions Permission Gate but is not one." }],
    },
  ].map((message, id) => JSON.stringify({ id: String(id), message }));
  writeFileSync(join(root, "fixture.jsonl"), `${records.join("\n")}\n`);

  const result = spawnSync(process.execPath, [audit, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /blocks=2\b/);
  assert.match(result.stdout, /Toolchain=1/);
  assert.match(result.stdout, /Locate-first=1/);
  assert.doesNotMatch(result.stdout, /Token Economy/);
});
