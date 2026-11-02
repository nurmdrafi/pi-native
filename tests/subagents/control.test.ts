/**
 * Control verbs (subagent_control: cancel / restart).
 *
 * Defect: the parent could spawn children but not control them — a mistaken
 * or obsolete child ran to its budget, a queued spawn waited behind a scope
 * owner that no longer mattered, and a wedged-but-alive child could not be
 * re-dispatched.
 *
 * Fix: a `subagent_control` tool — `cancel` stops a running child through
 * the budget-stop interrupt→grace→kill sequence and finalizes it via the
 * standard delivery funnel with a `cancelled_by_parent` result (scope lock
 * released by the funnel, slot freed by the settling watcher), or removes a
 * queued spawn (reservation released, slot parity kept — queued entries hold
 * no slot); `restart` pre-checks the pane-loss restart gates, stops the live
 * pane, and re-dispatches through the in-place restart machinery (same
 * name, same entry).
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";
import subagentsModule from "../../extensions/subagents/index.ts";
import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";
import { writeSubagentLoadout } from "../../extensions/subagents/session.ts";

const subagentsExtension = subagentsModule as unknown as (pi: unknown) => void;

const savedEnv: Record<string, string | undefined> = {};

function fakePi() {
  const sent: Array<Record<string, any>> = [];
  return {
    sent,
    sendMessage(msg: Record<string, any>, _options: unknown) {
      sent.push(msg);
    },
  };
}

/** Minimal running entry: no pane, no budget — cancel/restart cores inject
 *  their own interrupt/kill so the multiplexer is never touched. */
function fakeRunning(overrides: Record<string, unknown> = {}): any {
  const dir = mkdtempSync(join(tmpdir(), "control-"));
  return {
    id: `run-${Math.random().toString(16).slice(2, 8)}`,
    name: "Worker-1",
    task: "do the thing",
    agent: "worker",
    surface: "%424242",
    startTime: Date.now() - 60_000,
    sessionFile: "/nonexistent/session.jsonl",
    cwd: dir,
    interactive: false,
    autoExit: true,
    abortController: new AbortController(),
    statusState: { source: "pi", startTimeMs: Date.now() - 60_000, currentKind: "running" },
    ...overrides,
  };
}

beforeEach(() => {
  __test__.resetScopeRegistry();
  __test__.resetSpawnQueue();
  __test__.pendingSpawns.length = 0;
  __test__.reservedNames.clear();
  __test__.runningSubagents.clear();
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
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = v;
  }
});

describe("cancel running subagent", () => {
  it("delivers one cancelled_by_parent result, releases the declared scope, and frees the entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-run-"));
    const running = fakeRunning({
      cwd: dir,
      scopeId: "scope-cancel-1",
      scope: { origin: "declared", paths: [join(dir, "src")] },
    });
    __test__.runningSubagents.set(running.id, running);
    __test__.declareScope("scope-cancel-1", {
      name: running.name,
      paths: running.scope.paths,
      state: "running",
    });

    const pi = fakePi();
    const calls: string[] = [];
    await __test__.cancelRunningSubagent(pi as never, running, {
      interrupt: (s: string) => calls.push(`interrupt:${s}`),
      kill: (s: string) => calls.push(`kill:${s}`),
      graceMs: 0,
      sleep: async () => {},
    });

    const results = pi.sent.filter((m) => m.customType === "subagent_result");
    assert.equal(results.length, 1, "exactly one result delivered");
    assert.equal(results[0].details.synthesized, "cancelled_by_parent");
    assert.match(String(results[0].content), /cancelled by its parent/i);
    assert.deepEqual(
      calls,
      ["interrupt:%424242", "kill:%424242"],
      "budget-stop interrupt → grace → kill sequence reused",
    );
    assert.ok(running.cancelledAt, "cancel intent recorded before the stop");
    assert.equal(__test__.runningSubagents.has(running.id), false, "entry reaped by the delivery funnel");
    assert.equal(running.abortController?.signal.aborted, true, "watcher aborted — its slot frees on settle");
    assert.deepEqual(
      __test__.findConflicts([join(dir, "src")], "scope-other"),
      [],
      "declared scope released by the funnel",
    );
  });

  it("does not double-deliver when the watcher won the race during the grace window", async () => {
    const running = fakeRunning();
    __test__.runningSubagents.set(running.id, running);
    const pi = fakePi();

    await __test__.cancelRunningSubagent(pi as never, running, {
      interrupt: () => {},
      kill: () => {
        // The watcher delivers during the grace window (child exited on the
        // interrupt): the funnel's idempotence must hold.
        running.delivered = true;
      },
      graceMs: 0,
      sleep: async () => {},
    });

    assert.equal(pi.sent.filter((m) => m.customType === "subagent_result").length, 0, "no second result");
  });

  it("a cancel-intent entry is never auto-restarted by the pane-loss gates", async () => {
    const running = fakeRunning({ cancelledAt: Date.now() });
    assert.equal(__test__.canRestartLostPane(running), false, "cancel intent blocks the restart gates");
  });
});

describe("cancel queued spawn", () => {
  it("removes the entry, releases its reservation, and keeps queue neighbors intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-q-"));
    const entry = {
      params: { agent: "worker", task: "t", name: "Queue-A" },
      ctx: {} as never,
      parentArtifactDir: dir,
      reservedName: "Queue-A",
      scopeId: "scope-q-1",
      scope: { origin: "declared" as const, paths: [join(dir, "src")] },
      queuedAt: Date.now(),
    };
    const neighbor = {
      params: { agent: "worker", task: "t", name: "Queue-B" },
      ctx: {} as never,
      parentArtifactDir: dir,
      reservedName: null,
      queuedAt: Date.now(),
    };
    __test__.pendingSpawns.push(entry, neighbor);
    __test__.declareScope("scope-q-1", { name: "Queue-A", paths: entry.scope.paths, state: "queued" });
    __test__.reservedNames.add("Queue-A");

    const removed = __test__.cancelQueuedSpawn("Queue-A");
    assert.ok(removed, "the removed entry is returned");
    assert.equal(removed.params.name, "Queue-A");
    assert.equal(__test__.pendingSpawns.length, 1, "queue shrank by exactly one");
    assert.equal(__test__.pendingSpawns[0].params.name, "Queue-B", "FIFO neighbors keep their order");
    assert.deepEqual(__test__.findConflicts([join(dir, "src")], "scope-other"), [], "reservation released");
    assert.equal(__test__.reservedNames.has("Queue-A"), false, "name reservation dropped");
    assert.equal(__test__.cancelQueuedSpawn("Queue-A"), null, "a second cancel finds nothing");
  });
});

describe("restart subagent", () => {
  it("stops the live pane, re-dispatches through the restart machinery, and preserves the entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-ondemand-"));
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "sess-restart", cwd: dir }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Partial work." }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeSubagentLoadout(sessionFile, {
      agent: "worker",
      toolAllowlist: null,
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: dir,
      agentDir: null,
    });
    const artifactDir = join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const running = fakeRunning({ sessionFile, cwd: dir, parentArtifactDir: artifactDir });
    __test__.runningSubagents.set(running.id, running);

    const stopped: string[] = [];
    const created: Array<{ name: string; paneCommand: string }> = [];
    const outcome = await __test__.restartSubagent(running, {
      interrupt: (s: string) => stopped.push(`interrupt:${s}`),
      kill: (s: string) => stopped.push(`kill:${s}`),
      graceMs: 0,
      sleep: async () => {},
      createSurfaceRunning: (name: string, paneCommand: string) => {
        created.push({ name, paneCommand });
        return "%9001";
      },
      writeScript: () => {},
    });

    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(stopped, ["interrupt:%424242", "kill:%424242"], "old pane stopped first");
    assert.equal(created.length, 1, "one replacement pane");
    assert.equal(running.surface, "%9001", "entry mutated in place onto the replacement pane");
    assert.ok(__test__.runningSubagents.has(running.id), "running entry preserved");
    const resolved = __test__.resolveRunningByName(running.name);
    assert.ok("running" in resolved && resolved.running === running, "same name resolves to the same entry");
  });

  it("refuses without stopping when the restart gates do not apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-refused-"));
    const running = fakeRunning({ cwd: dir, sessionFile: join(dir, "missing.jsonl") });
    __test__.runningSubagents.set(running.id, running);

    const stopped: string[] = [];
    const outcome = await __test__.restartSubagent(running, {
      interrupt: (s: string) => stopped.push(s),
      kill: (s: string) => stopped.push(s),
      graceMs: 0,
      sleep: async () => {},
    });

    assert.ok("error" in outcome, `expected a refusal, got ${JSON.stringify(outcome)}`);
    assert.deepEqual(stopped, [], "an ineligible child is never stopped");
    assert.ok(__test__.runningSubagents.has(running.id), "entry untouched");
  });
});

describe("subagent_control tool wiring", () => {
  function registeredPi() {
    const tools: Array<Record<string, any>> = [];
    const messages: Array<Record<string, any>> = [];
    const pi = {
      on: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerShortcut: () => {},
      registerTool: (t: Record<string, any>) => tools.push(t),
      sendUserMessage: () => {},
      sendMessage: (msg: Record<string, any>, _options: unknown) => messages.push(msg),
      getAllTools: () => [],
      getActiveTools: () => ["subagent"],
      setActiveTools: () => {},
    };
    return { pi, tools, messages };
  }

  function fakeTmuxRunner(): (args: string[]) => string {
    let splits = 0;
    return (args: string[]): string => {
      switch (args[0]) {
        case "has-session":
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
  }

  async function waitUntil(cond: () => boolean, ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  }

  it("cancel removes a slot-queued spawn; the next queued spawn still drains, unknown names error", async () => {
    const root = mkdtempSync(join(tmpdir(), "control-tool-"));
    const agentDir = join(root, "agent-home");
    const projectDir = join(root, "project");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "worker.md"),
      "---\nname: worker\ntools: piread\n---\n\nBody.\n",
      "utf8",
    );
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionFile: () => join(projectDir, "parent.jsonl"),
        getSessionId: () => "parent-sid",
        getSessionDir: () => projectDir,
      },
    };
    __surfaceTest__.setTmuxRunner(fakeTmuxRunner());
    const { pi, tools } = registeredPi();
    subagentsExtension(pi as never);
    const spawn = tools.find((t) => t.name === "subagent") as { execute: Function };
    const control = tools.find((t) => t.name === "subagent_control") as { execute: Function };
    assert.ok(control, "subagent_control tool is registered");

    // Fill the default cap (5), then queue two spawns behind it.
    for (const n of ["ctrl-h1", "ctrl-h2", "ctrl-h3", "ctrl-h4", "ctrl-h5"]) {
      await spawn.execute(`tc-${n}`, { agent: "worker", task: "hold", name: n }, undefined, undefined, ctx);
    }
    const runningNames = () => new Set([...__test__.runningSubagents.values()].map((r) => r.name));
    assert.ok(
      [...runningNames()].length >= 1,
      "holders are running before the queue forms",
    );
    const q1 = await spawn.execute("tc-q1", { agent: "worker", task: "work", name: "ctrl-q1" }, undefined, undefined, ctx);
    assert.match(String(q1.content[0].text), /queued/i);
    const q2 = await spawn.execute("tc-q2", { agent: "worker", task: "work", name: "ctrl-q2" }, undefined, undefined, ctx);
    assert.match(String(q2.content[0].text), /queued/i);

    // Cancel the first queued entry through the tool.
    const cancelRes = await control.execute("tc-c1", { action: "cancel", name: "ctrl-q1" }, undefined, undefined, ctx);
    assert.match(String(cancelRes.content[0].text), /ctrl-q1/i);
    assert.equal(
      __test__.pendingSpawns.some((p: any) => p.params.name === "ctrl-q1"),
      false,
      "queue entry gone",
    );
    assert.equal(
      __test__.pendingSpawns.some((p: any) => p.params.name === "ctrl-q2"),
      true,
      "neighbor still queued",
    );

    // Unknown names: a single-line error, never a throw.
    const ghost = await control.execute("tc-c2", { action: "cancel", name: "ghost" }, undefined, undefined, ctx);
    assert.match(String(ghost.content[0].text), /ghost/i);
    assert.ok(String(ghost.content[0].text).split("\n").length === 1, "error is a single line");

    // Slot parity: free one holder — the surviving queued spawn must drain.
    const holder = [...__test__.runningSubagents.values()].find((r: any) => r.name === "ctrl-h1");
    assert.ok(holder, "ctrl-h1 still running");
    holder.abortController?.abort();
    assert.ok(
      await waitUntil(() => runningNames().has("ctrl-q2")),
      "the next queued spawn launches after the cancel",
    );
    assert.equal(runningNames().has("ctrl-q1"), false, "the cancelled spawn never launches");
  });

  it("cancel of a running child is fire-and-forget; restart of an unknown name errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "control-tool2-"));
    const agentDir = join(root, "agent-home");
    const projectDir = join(root, "project");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "worker.md"),
      "---\nname: worker\ntools: piread\n---\n\nBody.\n",
      "utf8",
    );
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const ctx = {
      cwd: projectDir,
      sessionManager: {
        getSessionFile: () => join(projectDir, "parent.jsonl"),
        getSessionId: () => "parent-sid",
        getSessionDir: () => projectDir,
      },
    };
    __surfaceTest__.setTmuxRunner(fakeTmuxRunner());
    const { pi, tools } = registeredPi();
    subagentsExtension(pi as never);
    const control = tools.find((t) => t.name === "subagent_control") as { execute: Function };

    const running = fakeRunning({ cwd: projectDir, surface: "%70" });
    __test__.runningSubagents.set(running.id, running);
    const res = await control.execute("tc-c3", { action: "cancel", name: running.name }, undefined, undefined, ctx);
    assert.match(String(res.content[0].text), /cancel initiated/i);

    const ghost = await control.execute("tc-c4", { action: "restart", name: "ghost" }, undefined, undefined, ctx);
    assert.match(String(ghost.content[0].text), /ghost/i);
    assert.ok(String(ghost.content[0].text).split("\n").length === 1, "error is a single line");
  });
});
