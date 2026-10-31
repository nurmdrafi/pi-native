/**
 * Phase-B economy: one read per completion, cached agent definitions.
 *
 * Defect 1: finalizing a child re-read and re-parsed the entire session file
 * three times (entries for the summary, stats, session id) — cost scales with
 * transcript size and sat directly on the parent's wake path. The same
 * triple-read ran on every pane-loss synthesis.
 *
 * Fix 1: parse once, derive everything from the parsed entry array. Pure
 * derivations (stats-from-entries, id-from-entries) are exported and must
 * agree exactly with the file-based originals.
 *
 * Defect 2: agent definitions were re-discovered from disk on every spawn —
 * twice (tool validation + launch), each pass readdir+readFileSync over up to
 * three directories — and never cached, so every spawn paid full discovery.
 *
 * Fix 2: per-process cache keyed by file path, invalidated by mtime. The
 * observable contract: unchanged files serve cached parses (same object
 * identity), changed files are re-read (no staleness).
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getNewEntries,
  getSessionId,
  summarizeSessionStats,
  summarizeStatsFromEntries,
  getSessionIdFromEntries,
} from "../../extensions/subagents/session.ts";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
const { __test__ } = await import("../../extensions/subagents/index.ts");

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (savedEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
  __test__.clearAgentDefCache?.();
});

function sessionFixture(dir: string): string {
  const file = join(dir, "child.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "sess-abc", cwd: dir }),
    JSON.stringify({ type: "model_change", modelId: "test/model-x" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "test/model-x",
        content: [{ type: "text", text: "Work done." }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7 },
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

describe("single-read derivations", () => {
  it("stats from pre-parsed entries equal the file-based summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-b-"));
    const file = sessionFixture(dir);

    const fromFile = summarizeSessionStats(file);
    const fromEntries = summarizeStatsFromEntries(getNewEntries(file, 0));

    assert.ok(fromFile, "fixture produces stats");
    assert.deepEqual(fromEntries, fromFile);
  });

  it("session id from pre-parsed entries equals the file-based id", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-b-"));
    const file = sessionFixture(dir);

    assert.equal(getSessionIdFromEntries(getNewEntries(file, 0)), getSessionId(file));
    assert.equal(getSessionIdFromEntries(getNewEntries(file, 0)), "sess-abc");
  });
});

describe("agent-definition cache", () => {
  it("serves unchanged definitions from cache (same object) and re-reads changed files", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cache-"));
    const agentDir = join(root, "agents");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = root;

    const agentFile = join(agentDir, "cache-probe.md");
    writeFileSync(agentFile, "---\nname: cache-probe-v1\ntools: piread\n---\n\nBody v1.\n", "utf8");

    const first = __test__.discoverAgentDefinitions().find((a: { name: string }) => a.name === "cache-probe-v1");
    assert.ok(first, "v1 discovered on first (cold) pass");

    const second = __test__.discoverAgentDefinitions().find((a: { name: string }) => a.name === "cache-probe-v1");
    assert.ok(
      second === first,
      "unchanged file serves the cached parse — identical object reference",
    );

    // mtime must differ from the first write for invalidation to trigger.
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(agentFile, "---\nname: cache-probe-v2\ntools: piread\n---\n\nBody v2.\n", "utf8");

    const defs = __test__.discoverAgentDefinitions();
    assert.ok(
      defs.some((a: { name: string }) => a.name === "cache-probe-v2"),
      "changed file is re-read — no staleness",
    );
    assert.ok(
      !defs.some((a: { name: string }) => a.name === "cache-probe-v1"),
      "superseded definition is gone",
    );
  });
});
