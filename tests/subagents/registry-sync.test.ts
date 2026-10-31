/**
 * Registry sync: a (re)started spawner session must see its registered
 * subagents so it resumes them by name instead of spawning replacements.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listRegisteredSubagents } from "../../extensions/subagents/session.ts";

function makeArtifactDir(): string {
  return mkdtempSync(join(tmpdir(), "registry-sync-"));
}

function seedRegistry(
  artifactDir: string,
  entries: Record<string, unknown>,
): void {
  writeFileSync(join(artifactDir, "subagent-registry.json"), JSON.stringify(entries));
}

describe("listRegisteredSubagents", () => {
  it("returns [] when the registry is absent", () => {
    assert.deepEqual(listRegisteredSubagents(makeArtifactDir()), []);
  });

  it("returns [] for a corrupt registry", () => {
    const dir = makeArtifactDir();
    writeFileSync(join(dir, "subagent-registry.json"), "not json{");
    assert.deepEqual(listRegisteredSubagents(dir), []);
  });

  it("lists registered names sorted, flagging missing session files", () => {
    const dir = makeArtifactDir();
    const live = join(dir, "w37.jsonl");
    writeFileSync(live, "{}");
    seedRegistry(dir, {
      w70: { sessionFile: join(dir, "w70.jsonl"), sessionId: null },
      w37: { sessionFile: live, sessionId: null },
    });
    const out = listRegisteredSubagents(dir);
    assert.deepEqual(
      out.map((r) => [r.name, r.exists]),
      [
        ["w37", true],
        ["w70", false],
      ],
    );
    assert.equal(out[0].sessionFile, live);
  });

  it("drops entries without a sessionFile string", () => {
    const dir = makeArtifactDir();
    seedRegistry(dir, {
      broken: { sessionId: null },
      ok: { sessionFile: join(dir, "ok.jsonl") },
    });
    assert.deepEqual(
      listRegisteredSubagents(dir).map((r) => r.name),
      ["ok"],
    );
  });
});
