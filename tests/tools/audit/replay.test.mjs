import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { familyOfReason } from "../../gate/harness/stub.mjs";

const root = mkdtempSync(join(tmpdir(), "gate-replay-"));
const replay = fileURLToPath(new URL("./replay.mjs", import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));

it("replays all session files and excludes native-bash-first from the bash proxy", () => {
  for (let i = 0; i <= 600; i++) {
    const records = i === 600
      ? [
          {
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "echo ok" } }],
            },
          },
          {
            message: {
              role: "toolResult",
              toolCallId: "call",
              toolName: "bash",
              isError: false,
              content: [{ type: "text", text: "ok" }],
            },
          },
        ]
      : [];
    writeFileSync(
      join(root, `${String(i).padStart(3, "0")}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
  }

  const result = spawnSync(process.execPath, [replay, root, "--all"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.equal(metrics.sessions, 601);
  assert.equal(metrics.commands, 1);
  assert.equal(metrics.blocked, 0);
  assert.equal(metrics.ran_ok, 1);
  assert.equal(familyOfReason("Permission Gate (Failure Loop): retry"), "Permission Gate (Failure Loop)");
  assert.equal(familyOfReason("Toolchain (Node): use the pinned version"), "Toolchain (Node)");
  assert.equal(familyOfReason("ordinary command error"), null);
});
