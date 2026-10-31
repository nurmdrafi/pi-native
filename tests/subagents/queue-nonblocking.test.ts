/**
 * Non-blocking spawn queue.
 *
 * Defect: the spawn tool awaited `spawnQueue.acquire()` inside the tool
 * execute. With the cap (default 5) reached, spawn #6+ blocked the parent's
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

// Cap defaults to 5 (PI_SUBAGENT_MAX_CONCURRENT unset — the runner preloads
// the extension before this file's module scope runs, so pinning it here
// would not take effect; the tests fill the default cap instead).
delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
const subagentsExtension = subagentsModule.default;

const savedEnv: Record<string, string | undefined> = {};

function fakeTmux(opts: { failSplitFrom?: number } = {}) {
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
        if (opts.failSplitFrom !== undefined && splits >= opts.failSplitFrom) {
          throw new Error(`fake tmux: split-window #${splits + 1} refused`);
        }
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
  it("spawn #6 returns immediately as queued while the cap is held, then launches on release", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fake = fakeTmux();
    __surfaceTest__.setTmuxRunner(fake.runner);
    const { pi, tools } = fakePi();
    subagentsExtension(pi as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };

    for (const n of ["nb-one", "nb-two", "nb-three", "nb-four", "nb-five"]) {
      const r = await tool.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
      assert.match(r.content[0].text, /launched/i);
    }
    assert.equal(fake.splits(), 5, "default cap filled with five panes");

    const t0 = Date.now();
    const sixth = await tool.execute("tc6", { agent: "worker", task: "work", name: "nb-six" }, undefined, undefined, ctx);
    const elapsed = Date.now() - t0;
    assert.match(sixth.content[0].text, /queued/i, "spawn past the cap reports queued, never blocks");
    assert.ok(elapsed < 2000, `execute returned in ${elapsed}ms, not the oldest child's runtime`);
    assert.ok(!runningNames().has("nb-six"), "queued spawn has not launched yet");
    assert.equal(fake.splits(), 5, "still only five panes");

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

    for (const n of ["fifo-a", "fifo-b", "fifo-c", "fifo-d", "fifo-e"]) {
      await tool.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
    }
    await tool.execute("tc-f", { agent: "worker", task: "first", name: "fifo-f" }, undefined, undefined, ctx);
    await tool.execute("tc-g", { agent: "worker", task: "second", name: "fifo-g" }, undefined, undefined, ctx);
    assert.equal(__test__.pendingSpawns.length, 2, "two entries waiting");

    const names = () => [...__test__.runningSubagents.values()].map((r) => r.name);
    const holder = [...__test__.runningSubagents.values()].find((r) => r.name === "fifo-a");
    assert.ok(holder, "fifo-a holds a slot before its abort");
    holder.abortController?.abort();
    assert.ok(await waitUntil(() => names().includes("fifo-f")), "first queued entry launches");
    assert.ok(!names().includes("fifo-g"), "second queued entry still waiting — one slot only");

    const d = [...__test__.runningSubagents.values()].find((r) => r.name === "fifo-f");
    assert.ok(d, "fifo-f is running before its abort");
    d.abortController?.abort();
    assert.ok(await waitUntil(() => names().includes("fifo-g")), "second queued entry launches next");
    assert.ok(await waitUntil(() => !names().includes("fifo-f")), "fifo-f finalized");
  });

  it("reports a queued spawn whose launch fails instead of losing it silently", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Splits work for the five holders; the queued spawn's split (6th) fails.
    const fake = fakeTmux({ failSplitFrom: 5 });
    __surfaceTest__.setTmuxRunner(fake.runner);
    const { pi, tools, messages } = fakePi();
    subagentsExtension(pi as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };

    for (const n of ["drain-a", "drain-b", "drain-c", "drain-d", "drain-e"]) {
      await tool.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
    }
    const sixth = await tool.execute(
      "tc-f",
      { agent: "worker", task: "work", name: "drain-lost" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(sixth.content[0].text, /queued/i);

    // The failure of a queued launch must surface as a reported result, never
    // as an unhandled rejection escaping the drain hook.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const holder = [...__test__.runningSubagents.values()].find((r) => r.name === "drain-a");
      assert.ok(holder, "drain-a holds a slot before its abort");
      holder.abortController?.abort();

      type SentResult = { content: { customType?: string; content?: string }; options?: { deliverAs?: string } };
      const sent = messages as SentResult[];
      const reportOf = () =>
        sent.find(
          (m) => m.content?.customType === "subagent_result" && /drain-lost/.test(m.content?.content ?? ""),
        );
      assert.ok(
        await waitUntil(() => reportOf() !== undefined),
        `queued launch failure reported to the parent, got: ${JSON.stringify(sent.map((m) => m.content?.content))}`,
      );
      const report = reportOf()!;
      assert.match(report.content.content ?? "", /failed to launch/i);
      assert.equal(report.options?.deliverAs, "steer");

      await new Promise((r) => setTimeout(r, 300)); // an escaping rejection fires on a later tick
      assert.equal(unhandled.length, 0, `rejection escaped the drain hook: ${unhandled.map(String).join("; ")}`);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("contains a watcher error report whose send channel rejects (stale module after reload)", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fake = fakeTmux();
    __surfaceTest__.setTmuxRunner(fake.runner);
    const { pi, tools } = fakePi();
    subagentsExtension(pi as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };

    await tool.execute("tc-w", { agent: "worker", task: "hold", name: "stale-watch" }, undefined, undefined, ctx);
    const running = [...__test__.runningSubagents.values()].find((r) => r.name === "stale-watch");
    assert.ok(running, "watched spawn is running");

    // Simulate /reload: the host replaced this module but its old watcher
    // keeps polling, and sends on the dead ExtensionAPI handle reject.
    (pi as unknown as { sendMessage: () => Promise<void> }).sendMessage = () =>
      Promise.reject(new Error("stale extension handle"));

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      running.abortController?.abort(); // watcher rejects -> its catch reports -> the report send rejects
      await new Promise((r) => setTimeout(r, 2500)); // one watcher poll tick + report settle
      assert.equal(
        unhandled.length,
        0,
        `failed error report escaped to the host: ${unhandled.map(String).join("; ")}`,
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
