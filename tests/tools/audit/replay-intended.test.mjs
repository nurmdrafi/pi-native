import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "gate-replay-intended-"));
const replay = fileURLToPath(new URL("./replay.mjs", import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));

it("does not count a malformed-input block as a false positive", () => {
  const records = [
    { role: "assistant", content: [{ type: "toolCall", id: "valid", name: "bash", arguments: { command: "echo ok" } }] },
    { role: "toolResult", toolCallId: "valid", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "empty", name: "bash", arguments: { command: "   " } }] },
    { role: "toolResult", toolCallId: "empty", toolName: "bash", isError: false, content: [] },
  ].map((message) => JSON.stringify({ message }));
  writeFileSync(join(root, "fixture.jsonl"), `${records.join("\n")}\n`);

  const result = spawnSync(process.execPath, [replay, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.equal(metrics.blocked, 1);
  assert.equal(metrics.intended_blocks, 1);
  assert.equal(metrics.fp_rate, 0);
  assert.equal(metrics.by_family["Permission Gate (Malformed)"], 1);
});
