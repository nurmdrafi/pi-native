import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { snapshotFor, lineageFor } from "../scripts/dashboard.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Field set of feeds.mjs readChildren entries — the wire contract the UI
 *  types (src/types-feeds.ts) must mirror. */
const CHILD_KEYS = [
  "childId",
  "sessionId",
  "name",
  "phase",
  "activeTool",
  "activeScope",
  "activeSinceMs",
  "waitingSinceMs",
  "turnIndex",
  "updatedAtMs",
  "latestEvent",
  "stallState",
];

/** Field set of feeds.mjs readSubagentResults entries. */
const RESULT_KEYS = ["id", "ts", "name", "agent", "exitCode", "elapsedMs", "costUsd", "summary", "error"];

function mkChild(overrides = {}) {
  return {
    childId: "01aaa111-2222-3333-4444-555566667777",
    sessionId: "parent-session-id",
    name: "recon",
    phase: "active",
    activeTool: "bash",
    activeScope: null,
    activeSinceMs: Date.now() - 30_000,
    waitingSinceMs: null,
    turnIndex: 3,
    updatedAtMs: Date.now(),
    latestEvent: "tool_call",
    stallState: "healthy",
    ...overrides,
  };
}

function mkResult(overrides = {}) {
  return {
    id: "rec-1",
    ts: 1791649000000,
    name: "recon",
    agent: "scout",
    exitCode: 0,
    elapsedMs: 12_345,
    costUsd: 0.42,
    summary: "done",
    error: null,
    ...overrides,
  };
}

/** A session summary complete enough for snapshotFor's aggregate chain. */
function mkSession(overrides = {}) {
  return {
    sessionId: "s-aaaa1111",
    project: "/proj/alpha",
    path: "/proj/alpha/2026-10-31T10-00-00-000Z_s-aaaa1111.jsonl",
    kind: "main",
    parentSession: null,
    turns: 2,
    cost: 0.5,
    models: ["sonnet"],
    toolCalls: 4,
    tools: {},
    toolCosts: {},
    firstTs: "2026-10-31T10:00:00Z",
    lastTs: "2026-10-31T10:05:00Z",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    reasoningShare: 0,
    durationSec: 300,
    tokensPerTurn: 75,
    avgTurnCost: 0.25,
    compactions: 0,
    blocksByTool: {},
    gateTags: {},
    subagents: { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] },
    agent: {
      repeatWithoutChange: 0,
      failureStreakCalls: 0,
      maxFailureStreak: 0,
      blocks: 0,
      blocksByFamily: {},
      gateTokenSharePct: 0,
    },
    ...overrides,
  };
}

function mkBase(overrides = {}) {
  return {
    raw: [],
    sessions: [mkSession()],
    active: [],
    children: [mkChild()],
    subagentResults: [mkResult()],
    generatedAt: "2026-10-31T14:00:00Z",
    ...overrides,
  };
}

const ALL = { from: null, to: null };

// ── snapshot wiring ─────────────────────────────────────────────────────────

describe("snapshot feeds wiring", () => {
  it("rides the children and subagentResults arrays through unchanged", () => {
    const children = [mkChild(), mkChild({ childId: "c2", phase: "waiting", stallState: "unknown" })];
    const subagentResults = [mkResult(), mkResult({ exitCode: 1, error: "boom" })];
    const snap = snapshotFor(mkBase({ children, subagentResults }), ALL);
    assert.equal(snap.children, children, "children must be the same array, not a copy");
    assert.equal(snap.subagentResults, subagentResults, "subagentResults must be the same array");
  });

  it("pins the child field set to the feeds.mjs shape", () => {
    const snap = snapshotFor(mkBase(), ALL);
    assert.deepEqual(Object.keys(snap.children[0]).sort(), [...CHILD_KEYS].sort());
    assert.ok(["healthy", "stalled", "unknown"].includes(snap.children[0].stallState));
  });

  it("pins the result field set to the feeds.mjs shape", () => {
    const snap = snapshotFor(mkBase(), ALL);
    assert.deepEqual(Object.keys(snap.subagentResults[0]).sort(), [...RESULT_KEYS].sort());
  });

  it("yields empty arrays when the base carries no feeds (older builders)", () => {
    const snap = snapshotFor(mkBase({ children: undefined, subagentResults: undefined }), ALL);
    assert.deepEqual(snap.children, []);
    assert.deepEqual(snap.subagentResults, []);
  });

  it("degrades to empty arrays on non-array feeds garbage instead of throwing", () => {
    const snap = snapshotFor(mkBase({ children: null, subagentResults: "nope" }), ALL);
    assert.deepEqual(snap.children, []);
    assert.deepEqual(snap.subagentResults, []);
  });
});

// ── live server integration (cycle → snapshot) ──────────────────────────────

describe("server feeds integration", () => {
  const SERVER = join(here, "..", "scripts", "dashboard.mjs");

  function boot(sessionsDir) {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PI_DASH_PORT: "0",
        PI_DASH_SESSIONS_DIR: sessionsDir,
        PI_DASH_SESSION_BUDGET: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolvePromise, rejectPromise) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error(`server did not boot in 20s\nstdout: ${out}\nstderr: ${err}`));
      }, 20_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => (err += c));
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((l) => l.startsWith("dashboard: http://"));
        if (line) {
          clearTimeout(timer);
          resolvePromise({ child, url: line.match(/http:\/\/[^\s)]+/)[0] });
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectPromise(new Error(`server exited early (code ${code})\nstderr: ${err}`));
      });
    });
  }

  it("serves children read from the sessions tree and results as an array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-wiring-"));
    const now = Date.now();
    const childId = "01abc222-3333-4444-5555-666677778888";
    // One fresh (healthy) activity snapshot + a registry naming the child.
    const activityDir = join(dir, "proj-alpha", "artifacts", "parent-session-id", "subagent-activity");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(
      join(activityDir, `${childId}.json`),
      `${JSON.stringify({
        version: 1,
        runningChildId: childId,
        createdAt: now - 60_000,
        updatedAt: now,
        sequence: 3,
        latestEvent: "tool_call",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: now - 25_000,
        waitingSince: null,
        turnIndex: 2,
        toolName: "bash",
        toolStartedAt: now - 5_000,
        toolEndedAt: null,
      })}\n`,
    );
    writeFileSync(
      join(dir, "proj-alpha", "artifacts", "parent-session-id", "subagent-registry.json"),
      JSON.stringify({ recon: { sessionFile: `/x/2026-10-31T10-00-00-000Z_${childId}-0.jsonl`, sessionId: childId } }),
    );

    let child;
    try {
      const booted = await boot(dir);
      child = booted.child;
      const res = await fetch(`${booted.url}/api/sessions`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.children), "snapshot must carry a children array");
      const found = body.children.find((c) => c.childId === childId);
      assert.ok(found, "fixture child must be served");
      assert.deepEqual(Object.keys(found).sort(), [...CHILD_KEYS].sort());
      assert.equal(found.name, "recon");
      assert.equal(found.stallState, "healthy");
      assert.equal(found.phase, "active");
      assert.ok(Array.isArray(body.subagentResults), "snapshot must carry a subagentResults array");
    } finally {
      child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── lineage join (detail endpoint helper) ───────────────────────────────────

describe("lineageFor", () => {
  function registryDir(entries, sessionId) {
    const dir = mkdtempSync(join(tmpdir(), "dash-lineage-"));
    const artifact = join(dir, "slug", "artifacts", sessionId);
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, "subagent-registry.json"), JSON.stringify(entries));
    return dir;
  }

  it("resolves the parent (as a named child entry) and the children of a spawner", () => {
    // Spawner "parent-1" registered child "recon" (session "child-9").
    const dir = registryDir(
      { recon: { sessionFile: "/x/1_child-9-0.jsonl", sessionId: "child-9" } },
      "parent-1",
    );
    try {
      const asChild = lineageFor("child-9", dir);
      assert.equal(asChild.parent.sessionId, "parent-1");
      assert.equal(asChild.parent.name, "recon");
      assert.deepEqual(asChild.children, []);
      const asParent = lineageFor("parent-1", dir);
      assert.equal(asParent.parent, null);
      assert.equal(asParent.children.length, 1);
      assert.equal(asParent.children[0].name, "recon");
      assert.equal(asParent.children[0].sessionId, "child-9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty-safe on a tree with no registries", () => {
    const empty = mkdtempSync(join(tmpdir(), "dash-lineage-empty-"));
    try {
      const got = lineageFor("whatever", empty);
      assert.equal(got.parent, null);
      assert.deepEqual(got.children, []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── component helper blocks (same extraction as subagents.test.mjs) ─────────

function extractBlock(relPath, begin, end) {
  const source = readFileSync(join(here, "..", relPath), "utf8");
  const beginAt = source.indexOf(begin);
  const endAt = source.indexOf(end);
  assert.ok(beginAt >= 0, `${begin} sentinel missing in ${relPath}`);
  assert.ok(endAt > beginAt, `${end} sentinel missing in ${relPath}`);
  return source.slice(beginAt, source.indexOf("*/", endAt) + 2);
}

const helperDir = mkdtempSync(join(tmpdir(), "dash-wiring-helpers-"));
after(() => rmSync(helperDir, { recursive: true, force: true }));

const livePath = join(helperDir, "live-helpers.ts");
writeFileSync(
  livePath,
  extractBlock("src/components/LiveTab.tsx", "/* live-helpers:begin", "/* live-helpers:end"),
);
const { childActivity, stallTone } = await import(pathToFileURL(livePath).href);

const subPath = join(helperDir, "outcome-helpers.ts");
writeFileSync(
  subPath,
  extractBlock("src/components/SubagentsTab.tsx", "/* subagent-helpers:begin", "/* subagent-helpers:end"),
);
const { outcomeTone, fmtEpochMs } = await import(pathToFileURL(subPath).href);

describe("LiveTab child helpers", () => {
  const now = 1_000_000_000;

  it("labels an active child by its active span and a waiting child by its wait span", () => {
    assert.deepEqual(childActivity({ phase: "active", activeSinceMs: now - 30_000, waitingSinceMs: null }, now), {
      kind: "active",
      ms: 30_000,
    });
    assert.deepEqual(childActivity({ phase: "waiting", activeSinceMs: null, waitingSinceMs: now - 5_000 }, now), {
      kind: "waiting",
      ms: 5_000,
    });
  });

  it("yields nothing without a usable timestamp", () => {
    assert.equal(childActivity({ phase: "active", activeSinceMs: null, waitingSinceMs: null }, now), null);
    assert.equal(childActivity({ phase: "waiting", activeSinceMs: now, waitingSinceMs: null }, now), null);
  });

  it("maps stall states onto tones: stalled warns, healthy stays neutral", () => {
    assert.equal(stallTone("stalled"), "warn");
    assert.equal(stallTone("healthy"), "neutral");
    assert.equal(stallTone("unknown"), "muted");
    assert.equal(stallTone("nonsense"), "muted");
  });
});

describe("SubagentsTab outcome helpers", () => {
  it("tones exit codes: zero neutral, nonzero warns, missing muted", () => {
    assert.equal(outcomeTone(0, null), "neutral");
    assert.equal(outcomeTone(1, null), "warn");
    assert.equal(outcomeTone(null, "boom"), "warn");
    assert.equal(outcomeTone(null, null), "muted");
  });

  it("formats epoch millis as a terse UTC stamp, null as a dash", () => {
    assert.equal(fmtEpochMs(1791649000000), "10-10 16:16");
    assert.equal(fmtEpochMs(null), "—");
  });
});

describe("snapshot cache", () => {
  it("second GET within the poll window is served from the cycle cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-cache-"));
    const server = join(here, "..", "scripts", "dashboard.mjs");
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, PI_DASH_PORT: "0", PI_DASH_SESSIONS_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise((resolvePromise, rejectPromise) => {
      let out = "";
      const timer = setTimeout(() => rejectPromise(new Error("no boot line")), 20_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        out += c;
        const line = out.split("\n").find((l) => l.startsWith("dashboard: http://"));
        if (line) {
          clearTimeout(timer);
          resolvePromise(line.match(/http:\/\/[^\s)]+/)[0]);
        }
      });
      child.on("exit", () => rejectPromise(new Error("server exited early")));
    });
    try {
      const first = await fetch(`${url}/api/sessions`);
      const second = await fetch(`${url}/api/sessions`);
      assert.equal(first.headers.get("x-snapshot-cache"), "miss");
      assert.equal(second.headers.get("x-snapshot-cache"), "hit");
      const a = await first.json();
      const b = await second.json();
      assert.equal(Array.isArray(a.sessions), true);
      // A concurrent boot cycle may rebuild between the two GETs; the cache
      // contract is freshness (same poll window), not byte identity.
      assert.ok(Math.abs(Date.parse(b.generatedAt) - Date.parse(a.generatedAt)) < 5_000);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
