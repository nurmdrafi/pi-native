import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __test__ } from "../../extensions/subagents/index.ts";
import { agentsSessionNameFor } from "../../extensions/subagents/tmux.ts";

/** Minimal running entry — only the fields the isolation helpers read. */
function fakeRunning(overrides: Record<string, unknown> = {}): any {
  return {
    id: `run-${Math.random().toString(16).slice(2, 8)}`,
    name: "Worker-1",
    task: "do the thing",
    agent: "worker",
    surface: "%424242",
    startTime: Date.now() - 60_000,
    sessionFile: "/nonexistent/session.jsonl",
    cwd: "/nonexistent",
    interactive: false,
    autoExit: true,
    abortController: new AbortController(),
    statusState: { source: "pi", startTimeMs: Date.now() - 60_000, currentKind: "running" },
    ...overrides,
  };
}

/** A fake project root: a real directory with a .git marker so repo-root
 *  derivation resolves any path inside it back to the root itself. */
function fakeProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

beforeEach(() => {
  __test__.runningSubagents.clear();
});

afterEach(() => {
  __test__.runningSubagents.clear();
});

describe("agentsSessionNameFor", () => {
  it("is stable per project root and distinct across project roots", () => {
    const a = "/repos/project-a";
    const b = "/repos/project-b";
    assert.equal(agentsSessionNameFor(a), agentsSessionNameFor(a), "same root, same name");
    assert.notEqual(agentsSessionNameFor(a), agentsSessionNameFor(b), "different roots, different names");
    assert.notEqual(agentsSessionNameFor(a), agentsSessionNameFor(join(a, "nested")), "subtree root differs");
  });

  it("derives a tmux-safe session name for any path shape", () => {
    for (const root of ["/repos/My Project_2024!", "/wëird/päth", "/x"]) {
      const name = agentsSessionNameFor(root);
      assert.match(name, /^pi-agents-[A-Za-z0-9-]+$/, `tmux-safe charset for ${root}`);
      assert.doesNotMatch(name, /[:.]/, `no tmux-hostile chars for ${root}`);
    }
  });

  it("falls back to the shared default session for an empty root", () => {
    assert.equal(agentsSessionNameFor(""), "pi-agents");
    assert.equal(agentsSessionNameFor("   "), "pi-agents");
  });
});

describe("running-child scope isolation", () => {
  it("runningInScope returns only children of the given project scope", () => {
    const p1 = fakeRunning({ id: "p1-w", name: "Worker-P1", scopeKey: "/repos/p1" });
    const p2 = fakeRunning({ id: "p2-w", name: "Worker-P2", scopeKey: "/repos/p2" });
    __test__.runningSubagents.set(p1.id, p1);
    __test__.runningSubagents.set(p2.id, p2);

    const inP1 = __test__.runningInScope("/repos/p1");
    assert.deepEqual(inP1.map((r: any) => r.id), ["p1-w"], "only the p1 child is visible to p1");

    const inP3 = __test__.runningInScope("/repos/p3");
    assert.deepEqual(inP3, [], "a third project sees no children at all");
  });

  it("an unscoped entry predating scoping stays visible to every scope", () => {
    const legacy = fakeRunning({ id: "legacy-u", name: "Legacy" });
    __test__.runningSubagents.set(legacy.id, legacy);

    assert.deepEqual(
      __test__.runningInScope("/repos/any-a").map((r: any) => r.id),
      ["legacy-u"],
      "visible to project A",
    );
    assert.deepEqual(
      __test__.runningInScope("/repos/any-b").map((r: any) => r.id),
      ["legacy-u"],
      "and to project B — never dropped on the floor",
    );
  });

  it("childScopeKey prefers the recorded scopeKey and derives one from cwd otherwise", () => {
    const project = fakeProject("scope-derive-");
    const explicit = fakeRunning({ scopeKey: "/repos/explicit", cwd: project });
    const derived = fakeRunning({ cwd: join(project, "packages", "sub") });

    assert.equal(__test__.childScopeKey(explicit), "/repos/explicit", "explicit key wins");
    assert.equal(__test__.childScopeKey(derived), project, "cwd inside a repo derives its repo root");
  });

  it("resolveRunningByName never resolves a child from another project", () => {
    const foreign = fakeRunning({ id: "f-w", name: "Worker-1", scopeKey: "/repos/p2" });
    __test__.runningSubagents.set(foreign.id, foreign);

    const crossed = __test__.resolveRunningByName("Worker-1", "/repos/p1");
    assert.ok("error" in crossed, "a foreign same-named child is not addressable from p1");
    assert.match(crossed.error, /No running subagent/, "the miss reads as a plain miss, not ambiguity");

    const own = fakeRunning({ id: "o-w", name: "Worker-1", scopeKey: "/repos/p1" });
    __test__.runningSubagents.set(own.id, own);
    const hit = __test__.resolveRunningByName("Worker-1", "/repos/p1");
    assert.ok("running" in hit, "same-project child resolves despite a foreign twin");
    if ("running" in hit) assert.equal(hit.running.id, "o-w");
  });

  it("uniqueRunningName may reuse a name taken only in another project", () => {
    const foreign = fakeRunning({ id: "f-w", name: "worker", scopeKey: "/repos/p2" });
    __test__.runningSubagents.set(foreign.id, foreign);

    assert.equal(
      __test__.uniqueRunningName("worker", undefined, "/repos/p1"),
      "worker",
      "a p1 default name ignores a p2 collision",
    );
    assert.equal(
      __test__.uniqueRunningName("worker", undefined, "/repos/p2"),
      "worker-2",
      "a same-project collision still suffixes",
    );
  });
});

describe("session shutdown scopes to the dying session", () => {
  it("detaches and aborts only the dying session's children", () => {
    const projectA = fakeProject("shutdown-a-");
    const projectB = fakeProject("shutdown-b-");
    const artifactsA = mkdtempSync(join(tmpdir(), "artifacts-a-"));
    const artifactsB = mkdtempSync(join(tmpdir(), "artifacts-b-"));

    const own = fakeRunning({
      id: "own-w",
      name: "Own-Worker",
      parentSessionId: "sess-a",
      scopeKey: projectA,
      parentArtifactDir: artifactsA,
    });
    const legacy = fakeRunning({
      id: "legacy-w",
      name: "Legacy-Worker",
      scopeKey: projectA,
      cwd: join(projectA, "src"),
      parentArtifactDir: artifactsA,
    });
    const foreign = fakeRunning({
      id: "foreign-w",
      name: "Foreign-Worker",
      parentSessionId: "sess-b",
      scopeKey: projectB,
      parentArtifactDir: artifactsB,
    });
    __test__.runningSubagents.set(own.id, own);
    __test__.runningSubagents.set(legacy.id, legacy);
    __test__.runningSubagents.set(foreign.id, foreign);

    __test__.handleSessionShutdown({
      sessionManager: { getSessionId: () => "sess-a" },
      cwd: join(projectA, "subdir"),
    } as never);

    assert.equal(__test__.runningSubagents.has("own-w"), false, "own child removed");
    assert.equal(__test__.runningSubagents.has("legacy-w"), false, "scope-matched legacy child removed");
    assert.equal(own.abortController.signal.aborted, true, "own child's watcher aborted");
    assert.equal(legacy.abortController.signal.aborted, true, "legacy child's watcher aborted");

    assert.equal(__test__.runningSubagents.has("foreign-w"), true, "foreign child untouched");
    assert.equal(foreign.abortController.signal.aborted, false, "foreign watcher keeps running");

    // Orphan sidecars persist for the dying project only.
    assert.equal(
      existsSync(join(artifactsA, "subagent-pending", "own-w.json")),
      true,
      "own child gets a recovery sidecar",
    );
    assert.equal(
      existsSync(join(artifactsB, "subagent-pending", "foreign-w.json")),
      false,
      "foreign child gets no sidecar",
    );
  });

  it("a later shutdown of the other session clears what remains", () => {
    const projectB = fakeProject("shutdown-b2-");
    const artifactsB = mkdtempSync(join(tmpdir(), "artifacts-b2-"));
    const foreign = fakeRunning({
      id: "b-w",
      name: "B-Worker",
      parentSessionId: "sess-b",
      scopeKey: projectB,
      parentArtifactDir: artifactsB,
    });
    __test__.runningSubagents.set(foreign.id, foreign);

    __test__.handleSessionShutdown({
      sessionManager: { getSessionId: () => "sess-b" },
      cwd: projectB,
    } as never);

    assert.equal(__test__.runningSubagents.size, 0, "the last session out clears the registry");
    assert.equal(foreign.abortController.signal.aborted, true, "its child is aborted");
  });
});
