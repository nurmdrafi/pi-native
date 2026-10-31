/**
 * Non-blocking spawn queue.
 *
 * Defect: the spawn tool awaited `spawnQueue.acquire()` inside the tool
 * execute. With the cap (default 3) reached, spawn #4+ blocked the parent's
 * whole turn for the remaining runtime of the oldest child — minutes —
 * despite the tool being documented fire-and-forget.
 *
 * Fix: the execute never blocks. When no slot is free the spawn is queued
 * FIFO with its name already reserved; the queue's release hook launches
 * queued entries as slots free. The tool result always returns immediately,
 * telling the model the subagent is queued and its result will still arrive
 * as a steer.
 *
 * The resume path keeps its blocking acquire deliberately: a resume answers
 * a specific user intent and its result message is the reply.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";

// Cap defaults to 3 (PI_SUBAGENT_MAX_CONCURRENT unset — the runner preloads
// the extension before this file's module scope runs, so pinning it here
// would not take effect; the tests fill the default cap instead).
delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
const subagentsExtension = subagentsModule.default;

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
  return { runner, splits: () => splits };
}

function freshRoot(agentName: string): { agentDir: string; projectDir: string; ctx: unknown } {
  const root = mkdtempSync(join(tmpdir(), "queue-nb-"));
  const agentDir = join(root, "agent-home");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const agentsDir = join(agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${agentName}.md`),
    `---\nname: ${agentName}\ntools: piread\n---\n\nBody.\n`,
    "utf8",
  );
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

beforeEach(() => {
  savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  // Teardown order matters: empty the queue BEFORE aborting watchers, or the
  // releases drain and relaunch. Abort every live watcher, then give the 1s
  // poll tick time to observe the abort so no async activity outlives the file.
  __test__.pendingSpawns.length = 0;
  __test__.resetSpawnQueue();
  for (const r of [...__test__.runningSubagents.values()]) {
    try {
      r.abortController?.abort();
    } catch {}
  }
  __test__.runningSubagents.clear();
  // The execute path starts the widget/status refresh intervals (1s each);
  // nothing else stops them in a bare test process, so clear via the same
  // process-global symbols the extension uses, or the loop never drains.
  for (const key of [Symbol.for("pi-subagents/widget-interval"), Symbol.for("pi-subagents/status-interval")]) {
    const timer = (globalThis as Record<symbol, unknown>)[key] as ReturnType<typeof setInterval> | null;
    if (timer) {
      clearInterval(timer);
      (globalThis as Record<symbol, unknown>)[key] = null;
    }
  }
  __surfaceTest__.setTmuxRunner(null);
  await new Promise((r) => setTimeout(r, 1100));
  if (savedEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
});

describe("non-blocking spawn queue", () => {
  it("spawn #4 returns immediately as queued while the cap is held, then launches on release", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fake = fakeTmux();
    __surfaceTest__.setTmuxRunner(fake.runner);
    const { pi, tools } = fakePi();
    subagentsExtension(pi as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };

    for (const n of ["nb-one", "nb-two", "nb-three"]) {
      const r = await tool.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
      assert.match(r.content[0].text, /launched/i);
    }
    assert.equal(fake.splits(), 3, "default cap filled with three panes");

    const t0 = Date.now();
    const fourth = await tool.execute("tc4", { agent: "worker", task: "work", name: "nb-four" }, undefined, undefined, ctx);
    const elapsed = Date.now() - t0;
    assert.match(fourth.content[0].text, /queued/i, "spawn past the cap reports queued, never blocks");
    assert.ok(elapsed < 2000, `execute returned in ${elapsed}ms, not the oldest child's runtime`);
    assert.ok(!runningNames().has("nb-four"), "queued spawn has not launched yet");
    assert.equal(fake.splits(), 3, "still only three panes");

    // Slot frees when #1's watcher settles: abort it — the watcher rejects,
    // releases, and the drain hook launches the queued spawn.
    const one = [...__test__.runningSubagents.values()].find((r) => r.name === "nb-one");
    assert.ok(one, "nb-one holds a slot before its abort");
    one.abortController?.abort();
    assert.ok(
      await waitUntil(() => runningNames().has("nb-four")),
      "queued spawn launches when the slot frees",
    );
    assert.ok(await waitUntil(() => !runningNames().has("nb-one")), "finished entry removed");
  });

  it("drains queued spawns in FIFO order", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fake = fakeTmux();
    __surfaceTest__.setTmuxRunner(fake.runner);
    const { pi, tools } = fakePi();
    subagentsExtension(pi as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };

    for (const n of ["fifo-a", "fifo-b", "fifo-c"]) {
      await tool.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
    }
    await tool.execute("tc-d", { agent: "worker", task: "first", name: "fifo-d" }, undefined, undefined, ctx);
    await tool.execute("tc-e", { agent: "worker", task: "second", name: "fifo-e" }, undefined, undefined, ctx);
    assert.equal(__test__.pendingSpawns.length, 2, "two entries waiting");

    const names = () => [...__test__.runningSubagents.values()].map((r) => r.name);
    const holder = [...__test__.runningSubagents.values()].find((r) => r.name === "fifo-a");
    assert.ok(holder, "fifo-a holds a slot before its abort");
    holder.abortController?.abort();
    assert.ok(await waitUntil(() => names().includes("fifo-d")), "first queued entry launches");
    assert.ok(!names().includes("fifo-e"), "second queued entry still waiting — one slot only");

    const d = [...__test__.runningSubagents.values()].find((r) => r.name === "fifo-d");
    assert.ok(d, "fifo-d is running before its abort");
    d.abortController?.abort();
    assert.ok(await waitUntil(() => names().includes("fifo-e")), "second queued entry launches next");
    assert.ok(await waitUntil(() => !names().includes("fifo-d")), "fifo-d finalized");
  });
});
