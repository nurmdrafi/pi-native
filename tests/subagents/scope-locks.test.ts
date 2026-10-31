/**
 * File-scope locks in the spawn queue (plan §3.1/3.2).
 *
 * Children that declare their write targets (`files` param on the spawn
 * tool) own those paths while queued or running: a later spawn declaring
 * overlap is parked behind the owner instead of racing it. Parsed task-text
 * scope never locks — it only feeds prior-work injection and display.
 *
 * The drain is a skip-scan: on each pass, non-conflicting queued entries
 * launch past parked ones, and parked entries keep their original index.
 * Ordering guard under test: a slot release re-fires the drain hook
 * synchronously, so any re-queue mutation must happen AFTER the release.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";
import { registerName, writeSubagentLoadout } from "../../extensions/subagents/session.ts";
import {
  declareScope,
  findConflicts,
  releaseScope,
  resetScopeRegistry,
  scopedChildren,
} from "../../extensions/subagents/spawn-queue.ts";
import { deriveScope, intersectFilesChanged, parseTaskPaths } from "../../extensions/subagents/scope.ts";

const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
const subagentsExtension = subagentsModule.default;

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

const savedEnv: Record<string, string | undefined> = {};

function fakeTmux() {
  let splits = 0;
  const runner = (args: string[]): string => {
    switch (args[0]) {
      case "has-session":
        return "";
      case "new-session":
        return "";
      case "list-panes":
        return "%70";
      case "split-window":
        splits += 1;
        return `%${100 + splits}`;
      default:
        return "";
    }
  };
  return { runner };
}

function freshRoot(agentName = "worker") {
  const root = mkdtempSync(join(tmpdir(), "scope-lock-"));
  const agentDir = join(root, "agent-home");
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "other"), { recursive: true });
  writeFileSync(join(projectDir, "src", "a.ts"), "export {};\n", "utf8");
  const agentsDir = join(agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${agentName}.md`), `---\nname: ${agentName}\ntools: piread\n---\n\nBody.\n`, "utf8");
  const ctx = {
    cwd: projectDir,
    sessionManager: {
      getSessionFile: () => join(projectDir, "parent.jsonl"),
      getSessionId: () => "parent-sid",
      getSessionDir: () => projectDir,
    },
  };
  return { agentDir, projectDir, ctx };
}

function fakePi() {
  const tools: Record<string, unknown>[] = [];
  const messages: { content: unknown; options: unknown }[] = [];
  const pi = {
    on: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    registerTool: (t: Record<string, unknown>) => tools.push(t),
    sendUserMessage: () => {},
    sendMessage: (msg: unknown, options: unknown) => messages.push({ content: msg, options }),
    getAllTools: () => [],
    getActiveTools: () => ["subagent"],
    setActiveTools: () => {},
  };
  return { pi, tools, messages };
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const runningNames = () => new Set([...__test__.runningSubagents.values()].map((r) => r.name));

function historyPath(): string {
  return join(dirname(process.env.PI_SUBAGENT_INBOX!), "subagent-history.jsonl");
}

function writeHistory(records: unknown[]): void {
  mkdirSync(dirname(historyPath()), { recursive: true });
  writeFileSync(historyPath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** Register an agent + fake mux and return the spawn/list tools for a project. */
function armSpawn(projectDir: string, agentDir: string, ctx: unknown) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  __surfaceTest__.setTmuxRunner(fakeTmux().runner);
  const { pi, tools } = fakePi();
  subagentsExtension(pi as never);
  const spawn = tools.find((t) => t.name === "subagent") as { execute: Function };
  const list = tools.find((t) => t.name === "subagents_list") as { execute: Function };
  return { pi, tools, spawn, list, projectDir, ctx };
}

async function spawnTool(
  harness: ReturnType<typeof armSpawn>,
  args: { agent?: string; task: string; name: string; files?: string[]; cwd?: string },
) {
  const res = (await harness.spawn.execute(
    `tc-${args.name}`,
    {
      agent: args.agent ?? "worker",
      task: args.task,
      name: args.name,
      ...(args.files ? { files: args.files } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
    },
    undefined,
    undefined,
    harness.ctx,
  )) as { content: { type: string; text: string }[]; details: Record<string, unknown> };
  return res;
}

beforeEach(() => {
  savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
  savedEnv.PI_SUBAGENTS_SCOPE_MODE = process.env.PI_SUBAGENTS_SCOPE_MODE;
  delete process.env.PI_SUBAGENTS_SCOPE_MODE; // default: "queue"
});

afterEach(async () => {
  // Teardown order: empty the queue BEFORE aborting watchers, or releases
  // drain and relaunch. Abort every live watcher, clear scope locks, then
  // give the 1s poll tick time to settle so no async activity outlives us.
  __test__.pendingSpawns.length = 0;
  __test__.resetSpawnQueue();
  for (const r of [...__test__.runningSubagents.values()]) {
    try {
      r.abortController?.abort();
    } catch {}
  }
  __test__.runningSubagents.clear();
  resetScopeRegistry();
  for (const key of [Symbol.for("pi-subagents/widget-interval"), Symbol.for("pi-subagents/status-interval")]) {
    const timer = (globalThis as Record<symbol, unknown>)[key] as ReturnType<typeof setInterval> | null;
    if (timer) {
      clearInterval(timer);
      (globalThis as Record<symbol, unknown>)[key] = null;
    }
  }
  __surfaceTest__.setTmuxRunner(null);
  try {
    rmSync(historyPath(), { force: true });
  } catch {}
  if (savedEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
  if (savedEnv.PI_SUBAGENTS_SCOPE_MODE === undefined) delete process.env.PI_SUBAGENTS_SCOPE_MODE;
  else process.env.PI_SUBAGENTS_SCOPE_MODE = savedEnv.PI_SUBAGENTS_SCOPE_MODE;
  await new Promise((r) => setTimeout(r, 1100));
});

// ── deriveScope: token extraction + hygiene ──

describe("parseTaskPaths hygiene", () => {
  it("drops the bare '/' token and keeps real relative paths", () => {
    const tokens = parseTaskPaths("start at / then edit src/a.ts. done");
    assert.ok(!tokens.includes("/"), "the bare '/' token is dropped");
    assert.ok(tokens.includes("src/a.ts"), "real path token kept");
  });

  it("trims trailing punctuation from tokens", () => {
    const tokens = parseTaskPaths("fix src/a.ts, then src/b/. finally done");
    assert.ok(tokens.includes("src/a.ts"), "trailing comma-period trimmed");
    assert.ok(tokens.includes("src/b"), "trailing period on a dir trimmed");
  });

  it("splits URLs at ':' so schemes never become tokens", () => {
    const tokens = parseTaskPaths("docs: https://x.test/guide/setup.md and lib/util.ts remain");
    assert.ok(tokens.some((t) => t.startsWith("//x.test/")), "URL body kept as one token");
    assert.ok(!tokens.some((t) => t.startsWith("https")), "scheme split off at ':'");
    assert.ok(tokens.includes("lib/util.ts"), "plain path kept");
  });

  it("keeps extension-only tokens but drops prose words", () => {
    const tokens = parseTaskPaths("read index.ts and main.go, then summarize today");
    assert.ok(tokens.includes("index.ts"), "extension-only token kept");
    assert.ok(!tokens.includes("then"), "plain word rejected");
    assert.ok(!tokens.includes("summarize"), "plain word rejected");
  });
});

describe("deriveScope", () => {
  it("declared files are normalized absolute and NOT existence-checked", () => {
    const { projectDir } = freshRoot();
    const scope = deriveScope("create the deliverable", projectDir, ["src/a.ts", "out/new-file.ts", "src"]);
    assert.equal(scope.origin, "declared");
    assert.deepEqual(scope.paths, [
      join(projectDir, "out", "new-file.ts"),
      join(projectDir, "src"),
      join(projectDir, "src", "a.ts"),
    ]);
  });

  it("empty files array falls back to parsed derivation", () => {
    const { projectDir } = freshRoot();
    const scope = deriveScope("edit src/a.ts please", projectDir, []);
    assert.equal(scope.origin, "parsed");
    assert.deepEqual(scope.paths, [join(projectDir, "src", "a.ts")]);
  });

  it("parsed scope keeps only existing paths (prose pairs rejected)", () => {
    const { projectDir } = freshRoot();
    const scope = deriveScope("fix alpha/beta and src/a.ts today", projectDir);
    assert.equal(scope.origin, "parsed");
    assert.deepEqual(scope.paths, [join(projectDir, "src", "a.ts")], "alpha/beta does not exist");
  });

  it("parsed scope caps at 20 paths", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-cap-"));
    mkdirSync(join(root, "d"), { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(root, "d", `f${String(i).padStart(2, "0")}.ts`), "x", "utf8");
    const task = Array.from({ length: 25 }, (_, i) => `d/f${String(i).padStart(2, "0")}.ts`).join(" ");
    const scope = deriveScope(task, root);
    assert.equal(scope.origin, "parsed");
    assert.equal(scope.paths.length, 20, "capped at 20");
  });

  it("nothing path-shaped and existing yields origin none", () => {
    const { projectDir } = freshRoot();
    const scope = deriveScope("just do the thing, no paths", projectDir);
    assert.equal(scope.origin, "none");
    assert.deepEqual(scope.paths, []);
  });
});

// ── spawn-queue scope registry ──

describe("scope registry conflicts", () => {
  it("exact file overlap conflicts", () => {
    declareScope("s1", { name: "owner", paths: [join("/r", "src", "a.ts")], state: "running" });
    const hits = findConflicts([join("/r", "src", "a.ts")]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "owner");
    assert.deepEqual(hits[0].hits, [join("/r", "src", "a.ts")]);
  });

  it("dir vs descendant and nested dirs conflict", () => {
    declareScope("s1", { name: "owner", paths: [join("/r", "src")], state: "running" });
    assert.equal(findConflicts([join("/r", "src", "deep", "a.ts")]).length, 1, "dir owns subtree");
    assert.equal(findConflicts([join("/r", "src", "lib")]).length, 1, "nested dir");
    assert.equal(findConflicts([join("/r", "other")]).length, 0, "disjoint does not conflict");
  });

  it("same relative path under different cwds is no conflict", () => {
    declareScope("s1", { name: "owner", paths: [join("/r1", "src", "a.ts")], state: "running" });
    assert.equal(findConflicts([join("/r2", "src", "a.ts")]).length, 0);
  });

  it("queued reservations participate in conflicts", () => {
    declareScope("s1", { name: "parked", paths: [join("/r", "src")], state: "queued" });
    assert.equal(findConflicts([join("/r", "src", "a.ts")]).length, 1);
  });

  it("releaseScope is idempotent and clears the reservation", () => {
    declareScope("s1", { name: "owner", paths: [join("/r", "src")], state: "running" });
    assert.equal(releaseScope("s1"), true);
    assert.equal(releaseScope("s1"), false);
    assert.equal(findConflicts([join("/r", "src")]).length, 0);
  });

  it("scopedChildren snapshots name/paths/state", () => {
    declareScope("s1", { name: "a", paths: [join("/r", "x")], state: "queued" });
    declareScope("s2", { name: "b", paths: [join("/r", "y")], state: "running" });
    const snap = scopedChildren();
    assert.equal(snap.length, 2);
    assert.deepEqual(snap.map((s) => `${s.name}:${s.state}`).sort(), ["a:queued", "b:running"]);
  });
});

// ── spawn flow locking ──

describe("declared scope in the spawn flow", () => {
  it("queues an overlapping declared spawn behind the owner, then launches on release", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    const a = await spawnTool(harness, { task: "own it", name: "lock-a", files: ["src/a.ts"] });
    assert.match(a.content[0].text, /launched/, "first owner launches when no conflict");
    const aRunning = [...__test__.runningSubagents.values()].find((r) => r.name === "lock-a");
    assert.ok(aRunning?.scope, "scope stored on the running entry");
    assert.ok(aRunning?.scopeId, "lock id stored on the running entry");
    assert.equal(scopedChildren().length, 1, "owner's scope declared");

    const b = await spawnTool(harness, { task: "same file", name: "lock-b", files: ["src/a.ts"] });
    assert.match(b.content[0].text, /queued behind "lock-a"/, "ack names the owner");
    assert.ok(b.content[0].text.includes(join(projectDir, "src", "a.ts")), "ack lists the owned hit");
    assert.ok(!runningNames().has("lock-b"), "overlapping spawn is parked, not running");
    assert.equal(__test__.pendingSpawns.length, 1, "parked in the spawn queue");
    assert.deepEqual(
      scopedChildren().map((s) => `${s.name}:${s.state}`).sort(),
      ["lock-a:running", "lock-b:queued"],
    );

    // Owner finishes → delivery releases the scope → the drain launches B.
    aRunning!.abortController?.abort();
    assert.ok(await waitUntil(() => runningNames().has("lock-b")), "parked spawn launches after the owner delivers");
    const bRunning = [...__test__.runningSubagents.values()].find((r) => r.name === "lock-b");
    assert.equal(scopedChildren().find((s) => s.name === "lock-b")?.state, "running", "state moves queued -> running at launch");
    assert.ok(bRunning?.scope, "launched entry carries its scope");
  });

  it("parsed scope never locks", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "own-p", files: ["src/a.ts"] });
    const b = await spawnTool(harness, { task: "review src/a.ts and report", name: "reader-p" });
    assert.match(b.content[0].text, /launched/, "parsed-scope spawn runs despite the overlap");
    assert.ok(runningNames().has("reader-p"));
    assert.equal(scopedChildren().length, 1, "only the declared owner is in the registry");
  });

  it("parsed scope never locks on the drain path", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    // Fill the cap: a declared owner of src/, then four unscoped holders.
    const holders: { abortController?: AbortController }[] = [];
    for (const [n, files] of [
      ["own-pd", ["src"]],
      ["h-pd-2", []],
      ["h-pd-3", []],
      ["h-pd-4", []],
      ["h-pd-5", []],
    ] as const) {
      await spawnTool(harness, { task: "hold", name: n, ...(files.length ? { files: [...files] } : {}) });
      holders.push([...__test__.runningSubagents.values()].find((r) => r.name === n)!);
    }
    // Cap full: a PARSED-scope spawn (task names src/a.ts, no files[]) queues
    // on the slot even though its parsed paths overlap the declared owner.
    const p = await spawnTool(harness, { task: "review src/a.ts and report", name: "parsed-drain" });
    assert.match(p.content[0].text, /concurrency cap/, "queued on the cap, not on the scope");
    assert.equal(__test__.pendingSpawns.length, 1);

    // Free a slot held by an unscoped child. The parsed entry must launch on
    // the slot release alone — the wait window deliberately closes BEFORE the
    // ~1s watcher tick at which this harness reaps idle children: only the
    // owner's scope release (never a slot) could otherwise wake it (bug).
    holders[4].abortController?.abort();
    const launchedEarly = await waitUntil(() => runningNames().has("parsed-drain"), 700);
    assert.ok(launchedEarly, "parsed-scope entry launches as soon as a slot frees");
    assert.equal(__test__.pendingSpawns.length, 0, "queue drained");
  });

  it("warn mode proceeds and the ack warns with the conflict", async () => {
    process.env.PI_SUBAGENTS_SCOPE_MODE = "warn";
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "own-w", files: ["src"] });
    const b = await spawnTool(harness, { task: "same dir", name: "warn-b", files: ["src/a.ts"] });
    assert.match(b.content[0].text, /launched/, "warn mode still launches");
    assert.match(b.content[0].text, /write-scope overlap/i, "ack warns about the overlap");
    assert.ok(b.content[0].text.includes('"own-w"'), "warning names the owner");
    assert.equal(scopedChildren().length, 2, "both scopes tracked in warn mode");
  });

  it("off mode does no tracking at all", async () => {
    process.env.PI_SUBAGENTS_SCOPE_MODE = "off";
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "own-o", files: ["src/a.ts"] });
    const b = await spawnTool(harness, { task: "same file", name: "off-b", files: ["src/a.ts"] });
    assert.match(b.content[0].text, /launched/, "off mode launches unconditionally");
    assert.equal(scopedChildren().length, 0, "no scope tracking in off mode");
    const bRunning = [...__test__.runningSubagents.values()].find((r) => r.name === "off-b");
    assert.equal(bRunning?.scopeId, undefined, "no reservation created");
  });

  it("a queued declared scope blocks a third colliding spawn while slots are free", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "own-t", files: ["src/a.ts"] });
    await spawnTool(harness, { task: "collide 1", name: "third-b", files: ["src/a.ts"] });
    const c = await spawnTool(harness, { task: "collide 2", name: "third-c", files: ["src/"] });
    assert.ok(!runningNames().has("third-c"), "third colliding spawn is parked");
    assert.equal(__test__.pendingSpawns.length, 2, "both colliding spawns parked");
    assert.match(c.content[0].text, /queued behind "own-t"/, "ack names the earliest owner");
    assert.equal(scopedChildren().filter((s) => s.state === "queued").length, 2);
  });

  it("skip-scan: a non-conflicting tail launches past a parked head, which keeps its index", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    // Fill the default cap of 5: the first declares src/, the rest are unscoped.
    const holders: { abortController?: AbortController }[] = [];
    for (const [n, files] of [
      ["hold-1", ["src"]],
      ["hold-2", []],
      ["hold-3", []],
      ["hold-4", []],
      ["hold-5", []],
    ] as const) {
      await spawnTool(harness, { task: "hold", name: n, ...(files.length ? { files: [...files] } : {}) });
      holders.push([...__test__.runningSubagents.values()].find((r) => r.name === n)!);
    }
    // Cap full: the conflicting head parks on scope, the disjoint tail parks on the cap.
    await spawnTool(harness, { task: "wants src", name: "parked-head", files: ["src/b.ts"] });
    await spawnTool(harness, { task: "disjoint", name: "free-tail", files: ["other/c.ts"] });
    assert.equal(__test__.pendingSpawns.length, 2);

    // Free a slot: the drain must skip the conflicting head and launch the tail.
    holders[4].abortController?.abort();
    assert.ok(await waitUntil(() => runningNames().has("free-tail")), "disjoint tail launches past parked head");
    assert.ok(!runningNames().has("parked-head"), "conflicting head stays parked");
    assert.deepEqual(
      __test__.pendingSpawns.map((e: { params: { name?: string } }) => e.params.name),
      ["parked-head"],
      "parked entry keeps its original index",
    );

    // Owner delivers → scope releases → the head launches. No recursion, no hang.
    holders[0].abortController?.abort();
    assert.ok(await waitUntil(() => runningNames().has("parked-head")), "parked head launches once the owner releases");
  });

  it("scope is released by the time the watcher settles", async () => {
    // Settling spans delete AND the delivery funnel — this pins that the lock
    // never outlives the watcher, not which site performed the release.
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "rel-a", files: ["src/a.ts"] });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "rel-a")!;
    assert.equal(findConflicts([join(projectDir, "src", "a.ts")]).length, 1, "held while running");

    running.abortController?.abort();
    assert.ok(await waitUntil(() => !runningNames().has("rel-a")), "watcher settles");
    assert.equal(findConflicts([join(projectDir, "src", "a.ts")]).length, 0, "released at delivery");
  });

  it("reconcile-driven delivery releases the scope", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "rec-a", files: ["src/a.ts"] });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "rec-a")!;
    __test__.deliverSubagentResult(
      harness.pi as never,
      running,
      { name: "rec-a", task: "own it", summary: "synth", sessionFile: running.sessionFile, exitCode: -1, elapsed: 1, error: "pane_lost" },
      "pane_lost",
    );
    assert.equal(findConflicts([join(projectDir, "src", "a.ts")]).length, 0, "reconcile funnel released the lock");
  });

  it("restart keeps the reservation (entry mutated in place)", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "rst-a", files: ["src/a.ts"] });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "rst-a")!;
    running.restart = { attemptedAt: Date.now() };
    assert.equal(findConflicts([join(projectDir, "src", "a.ts")]).length, 1, "reservation survives the restart mutation");
  });

  it("resume entries stay unscoped", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __surfaceTest__.setTmuxRunner(fakeTmux().runner);
    const { pi } = fakePi();
    subagentsExtension(pi as never);

    const sessionFile = join(projectDir, "resume-me.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    writeSubagentLoadout(sessionFile, {
      agent: "worker",
      toolAllowlist: "piread",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: projectDir,
      agentDir: null,
    });    registerName(join(projectDir, "artifacts", "parent-sid"), "resumee", {
      sessionFile,
      sessionId: "sess-1",
    });

    await __test__.resumeSubagentByName({ name: "resumee", message: "continue" }, ctx as never);
    const resumed = [...__test__.runningSubagents.values()].find((r) => r.name === "resumee");
    assert.ok(resumed, "resume launched and registered");
    assert.equal(resumed?.scopeId, undefined, "resumed entry has no lock id");
    assert.equal(resumed?.scope, undefined, "resumed entry carries no scope");
  });
});

// ── exposure ──

describe("scope exposure", () => {
  it("subagents_list shows owned declared paths for running and queued children", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "exp-a", files: ["src/a.ts"] });
    await spawnTool(harness, { task: "collide", name: "exp-b", files: ["src"] });
    const res = (await harness.list.execute("tc-list", {}, undefined, undefined, ctx as never)) as {
      content: { text: string }[];
      details: Record<string, unknown>;
    };
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /exp-a[^\n]*owns/, "running owner listed with its paths");
    assert.ok(text.includes("src/a.ts"), "owned path shown");
    assert.match(text, /exp-b[^\n]*queued/, "queued scope holder listed");
    const scoped = res.details.scoped as { name: string; state: string; paths: string[]; more?: number }[];
    assert.equal(scoped.length, 2);
    // Exposure is transcript-safe: repo-relative paths, never absolute
    // machine paths, and capped so a wide scope cannot flood the details.
    assert.ok(
      scoped.every((s) => s.paths.every((p) => !p.startsWith("/"))),
      "exposed scope paths are repo-relative, not absolute",
    );
    assert.ok(scoped[0].paths.includes("src/a.ts"), "owned path relativized");
    assert.ok((scoped[0].paths.length <= 10), "exposed path list capped");
  });

  it("subagents_list renderResult renders the declared-scope section", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "rend-a", files: ["src/a.ts"] });
    const res = (await harness.list.execute("tc-list", {}, undefined, undefined, ctx as never)) as {
      content: { text: string }[];
      details: Record<string, unknown>;
    };
    const theme = { fg: (_mode: string, t: string) => t, bold: (t: string) => t };
    const rendered = (harness.list.renderResult as Function)(res, {}, theme) as { render(w: number): string[] };
    const out = rendered.render(80).join("\n");
    assert.match(out, /Declared file scopes/, "scope section rendered in the expanded view");
    assert.ok(out.includes("rend-a"), "owner named");
    assert.ok(out.includes("\u25A3"), "lock glyph rendered");
  });

  it("widget row shows a lock indicator with the declared path count", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);

    await spawnTool(harness, { task: "own it", name: "wid-a", files: ["src/a.ts", "src/b.ts"] });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "wid-a")!;
    const lines = __test__.renderSubagentWidgetLines([running], 100) as string[];
    const row = (lines.find((l) => l.includes("wid-a")) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(row.includes("▣2"), "lock glyph + declared path count on the row");
  });

  it("__test__ exposes the scope hooks", () => {
    for (const hook of ["deriveScope", "parseTaskPaths", "intersectFilesChanged", "declareScope", "releaseScope", "findConflicts", "scopedChildren", "resetScopeRegistry", "resolveScopeMode"]) {
      assert.equal(typeof (__test__ as Record<string, unknown>)[hook], "function", `${hook} exported`);
    }
  });
});

// ── prior-work injection ──

describe("prior-work injection at payload assembly", () => {
  it("appends the prior-work block only on overlap", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);
    const artifactDir = join(projectDir, "artifacts", "parent-sid", "context");

    // Overlapping record: an earlier child changed the file this spawn declares.
    writeHistory([
      { id: "h1", ts: Date.now() - 60_000, name: "earlier", files_changed: ["src/a.ts"], summary: "refactored the export" },
    ]);
    await spawnTool(harness, { task: "touch the file", name: "inj-a", files: ["src/a.ts"] });
    let arts = readdirSync(artifactDir).filter((f) => f.endsWith(".md"));
    let body = arts.map((f) => readFileSync(join(artifactDir, f), "utf8")).find((t) => t.includes("touch the file")) ?? "";
    assert.match(body, /Prior work touching your scope/, "overlapping record injected");
    assert.match(body, /from earlier/, "record attributed");
    assert.match(body, /- src\/a\.ts/, "changed path listed");

    // Non-overlapping record: no injection.
    writeHistory([
      { id: "h2", ts: Date.now() - 60_000, name: "elsewhere", files_changed: ["other/c.ts"], summary: "unrelated work" },
    ]);
    await spawnTool(harness, { task: "other task text", name: "inj-b", files: ["src/a.ts"] });
    arts = readdirSync(artifactDir).filter((f) => f.endsWith(".md"));
    body = arts.map((f) => readFileSync(join(artifactDir, f), "utf8")).find((t) => t.includes("other task text")) ?? "";
    assert.ok(!body.includes("Prior work touching your scope"), "no injection without overlap");
  });

  it("injection is orthogonal to locking — it runs in off mode", async () => {
    process.env.PI_SUBAGENTS_SCOPE_MODE = "off";
    const { agentDir, projectDir, ctx } = freshRoot();
    const harness = armSpawn(projectDir, agentDir, ctx);
    writeHistory([
      { id: "h1", ts: Date.now() - 60_000, name: "earlier", files_changed: ["src/a.ts"], summary: "refactored" },
    ]);
    await spawnTool(harness, { task: "off mode task", name: "inj-off", files: ["src/a.ts"] });
    const artifactDir = join(projectDir, "artifacts", "parent-sid", "context");
    const body = readdirSync(artifactDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(artifactDir, f), "utf8"))
      .find((t) => t.includes("off mode task")) ?? "";
    assert.match(body, /Prior work touching your scope/, "injection runs even when locks are off");
  });
});

// ── parent-side scope intersect of files_changed ──

describe("scope-intersected files_changed", () => {
  it("intersectFilesChanged: a scope dir owns its subtree", () => {
    const root = "/repo";
    const changed = ["src/in/a.ts", "out/of.ts", "src"];
    const kept = intersectFilesChanged(changed, [join(root, "src")], root);
    assert.deepEqual(kept, ["src/in/a.ts", "src"], "input order preserved");
    assert.deepEqual(intersectFilesChanged(changed, [], root), changed, "no scope keeps everything");
  });

  it("deliverSubagentResult intersects the git delta with the child scope", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    // Real git repo so the spawn-time baseline and delivery-time status both work.
    mkdirSync(join(projectDir, "out"), { recursive: true });
    execFileSync("git", ["init", "-q", projectDir], { stdio: "ignore" });

    const harness = armSpawn(projectDir, agentDir, ctx);
    await spawnTool(harness, { task: "scoped work", name: "git-a", files: ["src"], cwd: projectDir });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "git-a")!;
    assert.ok(running.gitBaselinePath, "baseline captured for the repo");
    assert.ok(await waitUntil(() => existsSync(running.gitBaselinePath!)), "baseline file written");

    writeFileSync(join(projectDir, "src", "in.ts"), "new", "utf8");
    writeFileSync(join(projectDir, "out", "of.ts"), "stray sibling", "utf8");

    const result: {
      name: string;
      task: string;
      summary: string;
      sessionFile: string;
      exitCode: number;
      elapsed: number;
      files_changed?: string[];
      files_changed_source?: "git_status_delta";
    } = {
      name: "git-a",
      task: "scoped work",
      summary: "done",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 1,
    };
    __test__.deliverSubagentResult(harness.pi as never, running, result);
    assert.deepEqual(result.files_changed, ["src/in.ts"], "only in-scope changes attributed");
    assert.equal(result.files_changed_source, "git_status_delta");
  });

  it("deliverSubagentResult keeps edits outside a PARSED scope in files_changed", async () => {
    const { agentDir, projectDir, ctx } = freshRoot();
    // Real git repo so the spawn-time baseline and delivery-time status both work.
    execFileSync("git", ["init", "-q", projectDir], { stdio: "ignore" });

    const harness = armSpawn(projectDir, agentDir, ctx);
    // No files[] — the scope comes from parsing the task text (src/a.ts exists).
    await spawnTool(harness, { task: "review src/a.ts and report", name: "git-p", cwd: projectDir });
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "git-p")!;
    assert.equal(running.scope?.origin, "parsed", "setup: the child carries a parsed scope");
    assert.ok(await waitUntil(() => existsSync(running.gitBaselinePath!)), "baseline file written");

    // The child edits a file its task text never named — git ground truth must
    // keep it: parsed scope is advisory (injection matching), never a filter.
    writeFileSync(join(projectDir, "other", "of.ts"), "unnamed edit", "utf8");

    const result: {
      name: string;
      task: string;
      summary: string;
      sessionFile: string;
      exitCode: number;
      elapsed: number;
      files_changed?: string[];
      files_changed_source?: "git_status_delta";
    } = {
      name: "git-p",
      task: "review src/a.ts and report",
      summary: "done",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 1,
    };
    __test__.deliverSubagentResult(harness.pi as never, running, result);
    assert.ok(
      (result.files_changed ?? []).some((p) => p.endsWith("other/of.ts")),
      "edit outside the parsed scope stays in files_changed",
    );
    assert.equal(result.files_changed_source, "git_status_delta");
  });
});
