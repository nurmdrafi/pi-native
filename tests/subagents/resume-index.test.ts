/**
 * Resume-by-name must survive a lost or stale name registry.
 *
 * The registry (`subagent-registry.json`) is rewritten wholesale on every
 * spawn (temp file + rename), so a crash mid-write, a manual cleanup, or a
 * spawner session whose artifact dir was recreated leaves resume with "No
 * subagent named X" even though `<name>-*.jsonl` is still on disk.
 *
 * Fix: an append-only index (`subagent-sessions.ndjson`) gets one line per
 * launch, and name resolution falls back to it — last line for a name wins.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";
import {
  appendSessionIndex,
  resolveNameInIndex,
  sessionIndexPath,
} from "../../extensions/subagents/session.ts";

const roots: string[] = [];

function freshArtifactDir(): { artifactDir: string; sessionDir: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "resume-index-"));
  roots.push(root);
  const sessionId = "spawner-sid";
  const artifactDir = join(root, "artifacts", sessionId);
  mkdirSync(artifactDir, { recursive: true });
  return { artifactDir, sessionDir: root, sessionId };
}

function fakeSessionFile(artifactDir: string, name: string): string {
  const file = join(artifactDir, `${name}-1111.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ id: "leaf", type: "message", message: { role: "user" } })}\n`,
    "utf8",
  );
  return file;
}

function ctxFor(sessionDir: string, sessionId: string): any {
  return {
    cwd: sessionDir,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
    },
  };
}

describe("subagent name index", () => {
  beforeEach(() => {
    __test__.runningSubagents.clear();
  });

  afterEach(() => {
    __test__.runningSubagents.clear();
    __test__.setLatestPi(null);
    __test__.resetChannelState();
    __test__.setUiContext(null);
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends one line per launch and resolves the newest line for a name", () => {
    const { artifactDir } = freshArtifactDir();
    appendSessionIndex(artifactDir, { name: "scout", sessionFile: "/s/one.jsonl", sessionId: "s1" });
    appendSessionIndex(artifactDir, { name: "other", sessionFile: "/s/two.jsonl", sessionId: "s2" });
    appendSessionIndex(artifactDir, { name: "scout", sessionFile: "/s/three.jsonl", sessionId: "s3" });

    assert.equal(resolveNameInIndex(artifactDir, "scout")?.sessionFile, "/s/three.jsonl");
    assert.equal(resolveNameInIndex(artifactDir, "other")?.sessionFile, "/s/two.jsonl");
    assert.equal(resolveNameInIndex(artifactDir, "missing"), null);
  });

  it("skips malformed lines instead of failing the lookup", () => {
    const { artifactDir } = freshArtifactDir();
    appendSessionIndex(artifactDir, { name: "scout", sessionFile: "/s/one.jsonl" });
    appendFileSync(sessionIndexPath(artifactDir), "not json at all\n");
    appendSessionIndex(artifactDir, { name: "scout", sessionFile: "/s/two.jsonl" });

    assert.equal(resolveNameInIndex(artifactDir, "scout")?.sessionFile, "/s/two.jsonl");
  });

  it("returns null when no index exists", () => {
    const { artifactDir } = freshArtifactDir();
    assert.equal(resolveNameInIndex(artifactDir, "scout"), null);
  });

  it("resumes by name from the index when the registry lost the entry", async () => {
    const { artifactDir, sessionDir, sessionId } = freshArtifactDir();
    const sessionFile = fakeSessionFile(artifactDir, "scout");
    appendSessionIndex(artifactDir, { name: "scout", sessionFile, sessionId: "child-sid" });
    __test__.setLatestPi({} as never);

    const res = await __test__.resumeSubagentByName(
      { name: "scout", message: "keep going" },
      ctxFor(sessionDir, sessionId),
    );
    const err = res.details.error as string;
    assert.ok(err, "resume refused at the sandbox stage");
    assert.doesNotMatch(err, /No subagent named/, "name resolved through the index fallback");
  });

  it("names every indexed subagent when the requested name is unknown", async () => {
    const { artifactDir, sessionDir, sessionId } = freshArtifactDir();
    const sessionFile = fakeSessionFile(artifactDir, "scout");
    appendSessionIndex(artifactDir, { name: "scout", sessionFile, sessionId: "child-sid" });
    __test__.setLatestPi({} as never);

    const res = await __test__.resumeSubagentByName(
      { name: "nobody", message: "hi" },
      ctxFor(sessionDir, sessionId),
    );
    const err = res.details.error as string;
    assert.match(err, /No subagent named "nobody"/);
    assert.match(err, /scout/, "indexed name suggested");
  });

  it("still refuses at the sandbox stage when a loadout sidecar is missing", async () => {
    const { artifactDir, sessionDir, sessionId } = freshArtifactDir();
    const sessionFile = fakeSessionFile(artifactDir, "scout");
    appendSessionIndex(artifactDir, { name: "scout", sessionFile, sessionId: "child-sid" });
    __test__.setLatestPi({} as never);

    const res = await __test__.resumeSubagentByName(
      { name: "scout", message: "keep going" },
      ctxFor(sessionDir, sessionId),
    );
    assert.ok(res.details.error, "refused without a sandbox snapshot");
  });

});
