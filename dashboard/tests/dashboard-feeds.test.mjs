import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

import { readChildren, readSubagentResults, readRegistries } from "../scripts/feeds.mjs";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Build an empty sessions tree: <tmp>/<slug>/artifacts/. Returns the
 *  sessions dir (the tmp root). */
function makeSessionsTree(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function artifactDir(sessionsDir, slug, sessionId) {
  const dir = join(sessionsDir, slug, "artifacts", sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write one activity snapshot fixture; overrides merge over valid defaults. */
function writeSnapshot(sessionsDir, slug, sessionId, childId, overrides = {}) {
  const now = Date.now();
  const state = {
    version: 1,
    runningChildId: childId,
    createdAt: now - 60_000,
    updatedAt: now,
    sequence: 12,
    latestEvent: "tool_call",
    phase: "active",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: true,
    activeScope: "tool",
    activeSince: now - 30_000,
    waitingSince: null,
    turnIndex: 3,
    toolCallId: "call_abc",
    toolName: "bash",
    toolStartedAt: now - 5_000,
    toolEndedAt: null,
    ...overrides,
  };
  const dir = join(sessionsDir, slug, "artifacts", sessionId, "subagent-activity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${childId}.json`), `${JSON.stringify(state)}\n`, "utf8");
  return state;
}

/** Write a name registry fixture for one spawner session's artifact dir. */
function writeRegistry(sessionsDir, slug, sessionId, entries) {
  const dir = artifactDir(sessionsDir, slug, sessionId);
  writeFileSync(join(dir, "subagent-registry.json"), JSON.stringify(entries, null, 2), "utf8");
}

function writeResults(repoRoot, lines) {
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(join(repoRoot, ".pi", "subagent-results.jsonl"), lines.join("\n") + "\n", "utf8");
}

function resultRecord(overrides = {}) {
  return {
    id: "rec-1",
    ts: 1791649000000,
    name: "recon",
    task: "map the tree",
    agent: "scout",
    sessionFile: "/sessions/x/child.jsonl",
    sessionId: "child-1",
    parentSessionId: "parent-1",
    repoRoot: "/repo",
    summary: "done",
    error: undefined,
    exitCode: 0,
    elapsed: 12_345,
    stats: { model: "m", cost: 0.42 },
    ...overrides,
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── readChildren ────────────────────────────────────────────────────────────

describe("readChildren", () => {
  it("returns [] for a missing or empty sessions dir", () => {
    assert.deepEqual(readChildren(join(tmpdir(), "definitely-missing-dir-xyz")), []);
    const empty = makeSessionsTree("feeds-empty-");
    try {
      assert.deepEqual(readChildren(empty), []);
    } finally {
      cleanup(empty);
    }
  });

  it("maps snapshot fields onto child entries across the tree", () => {
    const root = makeSessionsTree("feeds-happy-");
    try {
      const now = Date.now();
      const state = writeSnapshot(root, "--cwd-a--", "sess-111", "ab12cd34", {
        updatedAt: now - 1_000,
      });
      writeSnapshot(root, "--cwd-b--", "sess-222", "ff99ee88", {
        phase: "waiting",
        latestEvent: "agent_end",
        agentActive: false,
        toolActive: false,
        activeScope: undefined,
        activeSince: undefined,
        waitingSince: now - 45_000,
        turnIndex: 7,
        updatedAt: now - 2_000,
      });

      const children = readChildren(root);
      assert.equal(children.length, 2);

      const first = children.find((c) => c.childId === "ab12cd34");
      assert.ok(first);
      assert.equal(first.sessionId, "sess-111");
      assert.equal(first.phase, "active");
      assert.equal(first.activeTool, "bash");
      assert.equal(first.activeScope, "tool");
      assert.equal(first.activeSinceMs, state.activeSince);
      assert.equal(first.waitingSinceMs, null);
      assert.equal(first.turnIndex, 3);
      assert.equal(first.updatedAtMs, state.updatedAt);
      assert.equal(first.latestEvent, "tool_call");
      assert.equal(first.stallState, "healthy");

      const second = children.find((c) => c.childId === "ff99ee88");
      assert.ok(second);
      assert.equal(second.sessionId, "sess-222");
      assert.equal(second.phase, "waiting");
      assert.equal(second.activeTool, null);
      assert.equal(second.activeScope, null);
      assert.equal(second.activeSinceMs, null);
      assert.equal(second.waitingSinceMs, now - 45_000);
      assert.equal(second.stallState, "healthy");
    } finally {
      cleanup(root);
    }
  });

  it("resolves a child's display name from the spawner registry", () => {
    const root = makeSessionsTree("feeds-name-");
    try {
      writeSnapshot(root, "--cwd-a--", "sess-111", "ab12cd34");
      writeRegistry(root, "--cwd-a--", "sess-111", {
        "map-trees": {
          sessionFile: "/sessions/--cwd-a--/2026-10-31T10-00-00-000Z_ab12cd34-1111-2222-3333.jsonl",
          sessionId: "child-sess-1",
        },
        other: {
          sessionFile: "/sessions/--cwd-a--/2026-10-31T10-00-00-000Z_ffffffff-1111-2222-3333.jsonl",
          sessionId: null,
        },
      });

      const children = readChildren(root);
      const child = children.find((c) => c.childId === "ab12cd34");
      assert.ok(child);
      assert.equal(child.name, "map-trees");
    } finally {
      cleanup(root);
    }
  });

  it("omits corrupt, wrong-version, and wrong-id snapshots without throwing", () => {
    const root = makeSessionsTree("feeds-corrupt-");
    try {
      const good = writeSnapshot(root, "--cwd-a--", "sess-111", "good0001");
      const dir = join(root, "--cwd-a--", "artifacts", "sess-111", "subagent-activity");
      writeFileSync(join(dir, "badgarba.json"), "{not json at all", "utf8");
      writeFileSync(join(dir, "badversi.json"), JSON.stringify({ ...good, version: 2 }), "utf8");
      writeFileSync(
        join(dir, "badwrong.json"),
        JSON.stringify({ ...good, runningChildId: "somebody" }),
        "utf8",
      );
      writeFileSync(join(dir, "badphase.json"), JSON.stringify({ ...good, phase: "confused" }), "utf8");

      const children = readChildren(root);
      assert.equal(children.length, 1);
      assert.equal(children[0].childId, "good0001");
    } finally {
      cleanup(root);
    }
  });

  it("classifies stalls at both thresholds (exactly at = healthy, just over = stalled)", () => {
    const root = makeSessionsTree("feeds-stall-");
    try {
      const now = Date.now();
      writeSnapshot(root, "--a--", "s1", "activeexact", {
        phase: "active",
        updatedAt: now - 600_000,
      });
      writeSnapshot(root, "--a--", "s1", "activeover1", {
        phase: "active",
        updatedAt: now - 600_001,
      });
      writeSnapshot(root, "--a--", "s2", "startexact", {
        phase: "starting",
        updatedAt: now - 180_000,
      });
      writeSnapshot(root, "--a--", "s2", "startover1", {
        phase: "starting",
        updatedAt: now - 180_001,
      });
      writeSnapshot(root, "--a--", "s3", "waitingold", {
        phase: "waiting",
        agentActive: false,
        toolActive: false,
        activeScope: undefined,
        activeSince: undefined,
        waitingSince: now - 9_999_999,
        updatedAt: now - 9_999_999,
      });
      writeSnapshot(root, "--a--", "s4", "doneold", {
        phase: "done",
        agentActive: false,
        toolActive: false,
        activeScope: undefined,
        activeSince: undefined,
        updatedAt: now - 9_999_999,
      });

      const children = readChildren(root, { now });
      const byId = new Map(children.map((c) => [c.childId, c.stallState]));
      assert.equal(byId.size, 6);
      assert.equal(byId.get("activeexact"), "healthy");
      assert.equal(byId.get("activeover1"), "stalled");
      assert.equal(byId.get("startexact"), "healthy");
      assert.equal(byId.get("startover1"), "stalled");
      assert.equal(byId.get("waitingold"), "healthy");
      assert.equal(byId.get("doneold"), "healthy");
    } finally {
      cleanup(root);
    }
  });

  it("shifts stall classification when PI_SUBAGENT_STALL_* env overrides are set", () => {
    const root = makeSessionsTree("feeds-stall-env-");
    try {
      const now = Date.now();
      writeSnapshot(root, "--a--", "s1", "activeaged", {
        phase: "active",
        updatedAt: now - 60_000,
      });
      writeSnapshot(root, "--a--", "s2", "startaged", {
        phase: "starting",
        updatedAt: now - 20_000,
      });

      // defaults: 60s of active silence and 20s of starting silence are healthy
      let children = readChildren(root, { now });
      assert.equal(children.find((c) => c.childId === "activeaged").stallState, "healthy");
      assert.equal(children.find((c) => c.childId === "startaged").stallState, "healthy");

      // same snapshots, lowered thresholds in the same process -> stalled
      const env = { PI_SUBAGENT_STALL_ACTIVE_MS: "30000", PI_SUBAGENT_STALL_START_MS: "10000" };
      children = readChildren(root, { now, env });
      assert.equal(children.find((c) => c.childId === "activeaged").stallState, "stalled");
      assert.equal(children.find((c) => c.childId === "startaged").stallState, "stalled");
    } finally {
      cleanup(root);
    }
  });

  it("falls back to defaults for non-positive or non-numeric PI_SUBAGENT_STALL_* values", () => {
    const root = makeSessionsTree("feeds-stall-envbad-");
    try {
      const now = Date.now();
      // 300s of silence: healthy under the 600s default, stalled if "0"/"-5"/"" were honored
      writeSnapshot(root, "--a--", "s1", "age5min", {
        phase: "active",
        updatedAt: now - 300_000,
      });
      // 700s of silence: stalled under the 600s default, healthy if NaN were honored
      writeSnapshot(root, "--a--", "s1", "age700s", {
        phase: "active",
        updatedAt: now - 700_000,
      });
      for (const bad of ["0", "-5", "", "abc"]) {
        const children = readChildren(root, { now, env: { PI_SUBAGENT_STALL_ACTIVE_MS: bad } });
        const byId = new Map(children.map((c) => [c.childId, c.stallState]));
        assert.equal(byId.get("age5min"), "healthy", `raw ${JSON.stringify(bad)} must not be honored`);
        assert.equal(byId.get("age700s"), "stalled", `raw ${JSON.stringify(bad)} must not be honored`);
      }
    } finally {
      cleanup(root);
    }
  });
});

// ── readSubagentResults ─────────────────────────────────────────────────────

describe("readSubagentResults", () => {
  it("returns [] when the inbox file does not exist", () => {
    const repo = makeSessionsTree("feeds-noresults-");
    try {
      assert.deepEqual(readSubagentResults(repo), []);
    } finally {
      cleanup(repo);
    }
  });

  it("maps inbox records to result entries", () => {
    const repo = makeSessionsTree("feeds-results-");
    try {
      writeResults(repo, [
        JSON.stringify(resultRecord({ id: "rec-1", name: "recon", summary: "mapped" })),
        JSON.stringify(
          resultRecord({
            id: "rec-2",
            name: "fixer",
            agent: undefined,
            error: "boom",
            errorMessage: "boom detail",
            exitCode: 1,
            elapsed: 999,
            stats: undefined,
          }),
        ),
        JSON.stringify(
          resultRecord({ id: "rec-3", stats: { model: "m", cost: "not-a-number" } }),
        ),
      ]);

      const results = readSubagentResults(repo);
      assert.equal(results.length, 3);
      assert.deepEqual(results[0], {
        id: "rec-1",
        ts: 1791649000000,
        name: "recon",
        agent: "scout",
        exitCode: 0,
        elapsedMs: 12_345,
        costUsd: 0.42,
        summary: "mapped",
        error: null,
      });
      assert.equal(results[1].agent, null);
      assert.equal(results[1].error, "boom");
      assert.equal(results[1].costUsd, null);
      assert.equal(results[1].elapsedMs, 999);
      assert.equal(results[2].error, null);
      assert.equal(results[2].costUsd, null);
    } finally {
      cleanup(repo);
    }
  });

  it("falls back to errorMessage when error is absent", () => {
    const repo = makeSessionsTree("feeds-errmsg-");
    try {
      writeResults(repo, [
        JSON.stringify(resultRecord({ id: "rec-9", error: undefined, errorMessage: "pane lost" })),
      ]);
      const results = readSubagentResults(repo);
      assert.equal(results[0].error, "pane lost");
    } finally {
      cleanup(repo);
    }
  });

  it("skips corrupt lines and a truncated last line", () => {
    const repo = makeSessionsTree("feeds-trunc-");
    try {
      const truncated = JSON.stringify(resultRecord({ id: "rec-half" })).slice(0, 40);
      writeResults(repo, [
        "{ corrupt middle line",
        JSON.stringify(resultRecord({ id: "rec-ok" })),
        truncated,
      ]);
      const results = readSubagentResults(repo);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "rec-ok");
    } finally {
      cleanup(repo);
    }
  });

  it("returns only the last 50 records", () => {
    const repo = makeSessionsTree("feeds-cap-");
    try {
      const lines = [];
      for (let i = 0; i < 55; i++) {
        lines.push(JSON.stringify(resultRecord({ id: `rec-${i}`, ts: 1_000 + i })));
      }
      writeResults(repo, lines);
      const results = readSubagentResults(repo);
      assert.equal(results.length, 50);
      assert.equal(results[0].id, "rec-5");
      assert.equal(results[results.length - 1].id, "rec-54");
    } finally {
      cleanup(repo);
    }
  });

  it("parses an unchanged inbox file once and picks up appended lines (stat-keyed cache)", () => {
    const repo = makeSessionsTree("feeds-cache-");
    try {
      const file = join(repo, ".pi", "subagent-results.jsonl");
      writeResults(repo, [JSON.stringify(resultRecord({ id: "rec-1" }))]);
      const parseCalls = { parses: 0 };

      const first = readSubagentResults(repo, { parseCalls });
      assert.equal(first.length, 1);
      assert.equal(first[0].id, "rec-1");

      const second = readSubagentResults(repo, { parseCalls });
      assert.deepEqual(second, first);
      assert.equal(parseCalls.parses, 1, "an unchanged stat must reuse the cached parse");

      appendFileSync(file, JSON.stringify(resultRecord({ id: "rec-2", ts: 1791649001000 })) + "\n", "utf8");

      const third = readSubagentResults(repo, { parseCalls });
      assert.equal(parseCalls.parses, 2, "a changed stat must re-parse");
      assert.equal(third.length, 2);
      assert.equal(third[0].id, "rec-1");
      assert.equal(third[1].id, "rec-2");
    } finally {
      cleanup(repo);
    }
  });
});

// ── readRegistries ──────────────────────────────────────────────────────────

describe("readRegistries", () => {
  it("collects name registries from the whole tree", () => {
    const root = makeSessionsTree("feeds-regs-");
    try {
      writeRegistry(root, "--cwd-a--", "sess-111", {
        scout: { sessionFile: "/s/a/scout.jsonl", sessionId: "child-a" },
      });
      writeRegistry(root, "--cwd-b--", "sess-222", {
        worker: { sessionFile: "/s/b/worker.jsonl", sessionId: null },
      });

      const registries = readRegistries(root);
      assert.equal(registries.length, 2);
      const ids = registries.map((r) => r.sessionId).sort();
      assert.deepEqual(ids, ["sess-111", "sess-222"]);
      const first = registries.find((r) => r.sessionId === "sess-111");
      assert.deepEqual(first.entries, {
        scout: { sessionFile: "/s/a/scout.jsonl", sessionId: "child-a" },
      });
    } finally {
      cleanup(root);
    }
  });

  it("skips corrupt registries and returns [] when none exist", () => {
    const root = makeSessionsTree("feeds-noregs-");
    try {
      assert.deepEqual(readRegistries(root), []);
      const dir = artifactDir(root, "--cwd-a--", "sess-bad");
      writeFileSync(join(dir, "subagent-registry.json"), "]]not json", "utf8");
      artifactDir(root, "--cwd-a--", "sess-empty");
      assert.deepEqual(readRegistries(root), []);
    } finally {
      cleanup(root);
    }
  });
});
