/**
 * Pane-loss internal recovery.
 *
 * Defect: when a subagent's tmux pane vanished mid-run (window reaped,
 * external kill-pane), the child was immediately pronounced dead: a
 * `pane_lost` result was synthesized from its session file and delivered,
 * even though the durable session file still held a half-finished task that
 * could have continued in a fresh pane.
 *
 * Fix: an auto-exit pi child with real progress gets ONE automatic restart —
 * a new pane resuming the same session file with the same sandbox snapshot
 * the spawn recorded — and the watcher keeps watching. A second loss (or a
 * child that is interactive, foreign-CLI, progress-less, or already
 * restarted) synthesizes and delivers `pane_lost` as before, noting that a
 * restart was attempted.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeSubagentLoadout } from "../../extensions/subagents/session.ts";
import { sweepRunningSubagents, type SweepDeps } from "../../extensions/subagents/reconcile.ts";
import { __test__ } from "../../extensions/subagents/index.ts";

/** Minimal session JSONL fixture: header + one assistant turn. */
function writeSessionFixture(dir: string, name = "child.jsonl", withAssistant = true): string {
  const file = join(dir, name);
  const lines = [
    JSON.stringify({ type: "session", id: "sess-fixture-1", cwd: dir }),
    ...(withAssistant
      ? [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Partial analysis done." }],
              usage: { cost: { total: 0.01 } },
            },
          }),
        ]
      : []),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function writeLoadoutFixture(sessionFile: string, cwd: string): void {
  writeSubagentLoadout(sessionFile, {
    agent: "scout",
    toolAllowlist: null,
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: true,
    cwd,
    agentDir: null,
  });
}

type RunningLike = Parameters<SweepDeps["finalize"]>[0] & {
  autoExit?: boolean;
  delivered?: boolean;
  restart?: { attemptedAt: number; respawnedAt?: number };
};

function fakeRunning(overrides: Record<string, unknown> = {}): any {
  const dir = mkdtempSync(join(tmpdir(), "restart-"));
  return {
    id: `run-${Math.random().toString(16).slice(2, 8)}`,
    name: "Scout-1",
    task: "survey the pane-loss recovery",
    agent: "scout",
    surface: "%424242",
    startTime: Date.now() - 60_000,
    sessionFile: "/nonexistent/session.jsonl",
    interactive: false,
    autoExit: true,
    cwd: dir,
    statusState: { source: "pi", startTimeMs: Date.now() - 60_000, currentKind: "running" },
    ...overrides,
  } as RunningLike;
}

function fakePi() {
  const sent: { content: string; details: unknown }[] = [];
  return {
    sent,
    sendMessage(msg: { content: string; details?: unknown }) {
      sent.push({ content: msg.content, details: msg.details });
    },
  };
}

function fakeRestartDeps(failSend = false) {
  const created: string[] = [];
  const closed: string[] = [];
  const sent: { surface: string; command: string; scriptPath: string }[] = [];
  return {
    created,
    closed,
    sent,
    deps: {
      createSurface: (name: string) => {
        created.push(name);
        return "%777";
      },
      sendScript: (surface: string, command: string, opts: { scriptPath: string }) => {
        if (failSend) throw new Error("send-keys failed");
        sent.push({ surface, command, scriptPath: opts.scriptPath });
      },
      closeSurface: (surface: string) => {
        closed.push(surface);
      },
      shellDelayMs: 0,
    },
  };
}

/** One poll script: each call consumes one scripted result. */
function fakePoll(results: { reason: "gone" | "sentinel" | "done"; exitCode: number }[], onPoll?: (surface: string, call: number) => void) {
  const surfaces: string[] = [];
  let calls = 0;
  const poll = async (surface: string) => {
    surfaces.push(surface);
    onPoll?.(surface, calls);
    const r = results[Math.min(calls, results.length - 1)];
    calls++;
    return r;
  };
  return { surfaces, calls: () => calls, poll };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.PI_SUBAGENT_SHELL_READY_DELAY_MS = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __test__.runningSubagents.clear();
});

describe("restart gates (canRestartLostPane)", () => {
  it("allows an auto-exit pi child with assistant output", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-gates-"));
    const sessionFile = writeSessionFixture(dir);
    const running = fakeRunning({ sessionFile });
    assert.equal(__test__.canRestartLostPane(running), true);
  });

  it("refuses interactive, foreign-cli, delivered, or restarted children", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-gates-"));
    const sessionFile = writeSessionFixture(dir);
    assert.equal(__test__.canRestartLostPane(fakeRunning({ sessionFile, interactive: true })), false, "interactive");
    assert.equal(__test__.canRestartLostPane(fakeRunning({ sessionFile, autoExit: false })), false, "not auto-exit");
    assert.equal(__test__.canRestartLostPane(fakeRunning({ sessionFile, cli: "claude" })), false, "claude child");
    assert.equal(
      __test__.canRestartLostPane(fakeRunning({ sessionFile, restart: { attemptedAt: Date.now() } })),
      false,
      "already restarted",
    );
    assert.equal(__test__.canRestartLostPane(fakeRunning({ sessionFile, delivered: true })), false, "already delivered");
  });

  it("refuses a child without real progress", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-gates-"));
    const noOutput = writeSessionFixture(dir, "bare.jsonl", false);
    assert.equal(__test__.canRestartLostPane(fakeRunning({ sessionFile: noOutput })), false, "no assistant output");
    assert.equal(
      __test__.canRestartLostPane(fakeRunning({ sessionFile: join(dir, "missing.jsonl") })),
      false,
      "no session file",
    );
  });

  it("refuses a budget-killed child — restarting would bypass the budget stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-gates-"));
    const sessionFile = writeSessionFixture(dir);
    assert.equal(
      __test__.canRestartLostPane(
        fakeRunning({ sessionFile, budgetStopper: { breached: () => true } }),
      ),
      false,
      "stopper already engaged (interrupt → kill path)",
    );
  });
});

describe("restartLostPane", () => {
  it("respawns a pane resuming the session file and mutates the entry in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-run-"));
    const sessionFile = writeSessionFixture(dir);
    writeLoadoutFixture(sessionFile, dir);
    const artifactDir = join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const running = fakeRunning({
      sessionFile,
      cwd: dir,
      parentArtifactDir: artifactDir,
      budgetStopper: { breached: () => false, onExit() {}, onTick() {}, onBreach() {} },
      reconcile: { lastMtimeMs: 1, lastSize: 1, unchangedTicks: 5 },
    });
    const f = fakeRestartDeps();

    const ok = await __test__.restartLostPane(running as never, f.deps);
    assert.equal(ok, true);

    assert.deepEqual(f.created, ["Scout-1"], "one new pane for the child");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].surface, "%777", "command sent to the new pane");
    const command = f.sent[0].command;
    assert.ok(command.includes(`cd '${dir}' && `), "resumes in the child's original cwd");
    assert.ok(command.includes(`pi --session '${sessionFile}'`), "resumes the durable session file");
    assert.ok(command.includes("subagent-done.ts"), "self-termination extension loaded");
    assert.ok(command.includes("PI_SUBAGENT_AUTO_EXIT=1"), "child stays auto-exit");
    assert.ok(command.includes(`PI_SUBAGENT_SESSION='${sessionFile}'`));
    assert.ok(command.includes("PI_SUBAGENT_TASK="), "task replayed for self-report");
    assert.ok(command.includes("PI_SUBAGENT_PARENT_SESSION="), "parent id replayed for self-report");
    assert.ok(command.includes("PI_SUBAGENT_START_MS="), "start clock preserved for self-report");
    assert.ok(command.includes("PI_SUBAGENT_SURFACE='%777'"));
    assert.ok(command.includes("PI_SUBAGENT_AGENT='scout'"), "agent identity replayed");
    assert.ok(command.includes(`echo '__SUBAGENT_DONE_'$?'__'`), "exit sentinel echoed");

    assert.ok(f.sent[0].scriptPath.startsWith(join(artifactDir, "subagent-scripts")), "script archived under artifacts");
    const resumeDir = join(artifactDir, "subagent-resume");
    const msgFile = readdirSync(resumeDir).find((f2) => f2.endsWith(".md"));
    assert.ok(msgFile, "restart nudge message written");
    assert.ok(command.includes(`@${join(resumeDir, msgFile!)}`), "message attached to the resume command");

    assert.equal(running.surface, "%777", "entry points at the new pane");
    assert.equal(running.restart?.respawnedAt != null, true, "respawn recorded");
    assert.equal(running.reconcile, undefined, "stall bookkeeping re-baselined");
    assert.equal(running.budgetStopper, undefined, "budget unenforced on the resumed run");
    assert.equal(running.delivered, undefined, "not delivered — still being watched");
  });

  it("refuses and burns the single attempt when no loadout snapshot exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-noloadout-"));
    const sessionFile = writeSessionFixture(dir); // no .loadout.json sidecar
    const running = fakeRunning({ sessionFile });
    const f = fakeRestartDeps();

    assert.equal(await __test__.restartLostPane(running as never, f.deps), false);
    assert.deepEqual(f.created, [], "no pane spawned");
    assert.equal(running.surface, "%424242", "entry keeps the dead pane id");
    assert.equal(running.restart?.attemptedAt != null, true, "attempt recorded so nothing retries");
  });

  it("restores the dead pane id when the respawned pane cannot be seeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-sendfail-"));
    const sessionFile = writeSessionFixture(dir);
    writeLoadoutFixture(sessionFile, dir);
    const running = fakeRunning({ sessionFile });
    const f = fakeRestartDeps(true /* send fails */);

    assert.equal(await __test__.restartLostPane(running, f.deps), false);
    assert.deepEqual(f.closed, ["%777"], "empty replacement pane closed");
    assert.equal(running.surface, "%424242", "entry restored so the loss is re-detected");
  });
});

describe("watchSubagent pane-loss handling", () => {
  it("restarts once, keeps watching the replacement pane, then delivers normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-watch-"));
    const sessionFile = writeSessionFixture(dir);
    const running = fakeRunning({ sessionFile, surface: "%1" });
    __test__.runningSubagents.set(running.id, running as never);

    const { surfaces, poll } = fakePoll([
      { reason: "gone", exitCode: -1 },
      { reason: "sentinel", exitCode: 0 },
    ]);
    let restarts = 0;
    const restart = async (r: { surface: string }) => {
      restarts++;
      r.surface = "%2";
      return true;
    };

    const result = await __test__.watchSubagent(running as never, new AbortController().signal, { poll, restart });

    assert.deepEqual(surfaces, ["%1", "%2"], "re-polls the replacement pane");
    assert.equal(restarts, 1, "exactly one restart");
    assert.equal(result.error, undefined, "completed normally after the restart");
    assert.equal(result.summary, "Partial analysis done.");
    assert.equal(__test__.runningSubagents.has(running.id), false, "entry removed on completion");
  });

  it("does not restart again on a second loss and reports the failed restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-second-"));
    const sessionFile = writeSessionFixture(dir);
    const running = fakeRunning({ sessionFile, surface: "%1" });
    __test__.runningSubagents.set(running.id, running as never);

    const { surfaces, poll } = fakePoll([{ reason: "gone", exitCode: -1 }]);
    let restarts = 0;
    const restart = async (r: { surface: string; restart?: { attemptedAt: number; respawnedAt?: number } }) => {
      restarts++;
      if (restarts === 1) {
        r.restart = { attemptedAt: Date.now(), respawnedAt: Date.now() };
        r.surface = "%2";
        return true;
      }
      return false; // gates refuse the second attempt
    };

    const result = await __test__.watchSubagent(running as never, new AbortController().signal, { poll, restart });

    assert.equal(restarts, 2, "second loss re-asks and is refused");
    assert.deepEqual(surfaces, ["%1", "%2"]);
    assert.equal(result.error, "pane_lost");
    assert.match(result.summary, /restart/i, "the loss note mentions the attempted restart");
    assert.equal(__test__.runningSubagents.has(running.id), false, "entry removed after the second loss");
  });

  it("follows a pane the sweep restarted mid-poll instead of synthesizing a loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-race-"));
    const sessionFile = writeSessionFixture(dir);
    const running = fakeRunning({ sessionFile, surface: "%1" });
    __test__.runningSubagents.set(running.id, running as never);

    // While the first poll watches the dead %1, the sweep moves the entry.
    const { surfaces, poll } = fakePoll(
      [
        { reason: "gone", exitCode: -1 },
        { reason: "sentinel", exitCode: 0 },
      ],
      (surface, call) => {
        if (call === 0 && surface === "%1") {
          running.restart = { attemptedAt: Date.now(), respawnedAt: Date.now() };
          running.surface = "%9";
        }
      },
    );
    let restarts = 0;
    const restart = async () => {
      restarts++;
      return true;
    };

    const result = await __test__.watchSubagent(running as never, new AbortController().signal, { poll, restart });

    assert.deepEqual(surfaces, ["%1", "%9"], "watcher follows the sweep-moved pane");
    assert.equal(restarts, 0, "no duplicate restart for a pane the watcher did not own");
    assert.equal(result.error, undefined);
  });
});

describe("sweep wiring (finalizeLostSubagent)", () => {
  it("restarts instead of delivering when the gates pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-sweep-"));
    const sessionFile = writeSessionFixture(dir);
    writeLoadoutFixture(sessionFile, dir);
    const artifactDir = join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const running = fakeRunning({ sessionFile, cwd: dir, parentArtifactDir: artifactDir });
    const map = new Map([[running.id, running]]);
    const pi = fakePi();
    const f = fakeRestartDeps();

    const deps: SweepDeps = {
      runningSubagents: map,
      listPanes: async () => new Set(["%111111"]),
      finalize: (r, kind) => __test__.finalizeLostSubagent(pi as never, r as never, kind, f.deps),
    };
    await sweepRunningSubagents(deps);
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget restart settles
    // The local map stands in for the real running map: production removes the
    // entry inside delivery, so mirror that only when delivery happened.
    if (running.delivered) map.delete(running.id);

    assert.equal(f.created.length, 1, "sweep initiated the restart");
    assert.equal(pi.sent.length, 0, "no loss delivered");
    assert.equal(map.size, 1, "entry stays alive for the watcher");
    assert.equal(running.restart?.respawnedAt != null, true);
  });

  it("delivers the pane_lost result when restart is impossible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-sweep2-"));
    const sessionFile = writeSessionFixture(dir); // no loadout sidecar
    const running = fakeRunning({ sessionFile, cwd: dir });
    const map = new Map([[running.id, running]]);
    const pi = fakePi();
    const f = fakeRestartDeps();

    const deps: SweepDeps = {
      runningSubagents: map,
      listPanes: async () => new Set(["%111111"]),
      finalize: (r, kind) => __test__.finalizeLostSubagent(pi as never, r as never, kind, f.deps),
    };
    await sweepRunningSubagents(deps);
    await new Promise((r) => setTimeout(r, 10));
    if (running.delivered) map.delete(running.id);

    assert.deepEqual(f.created, [], "no restart attempted beyond the gate check");
    assert.equal(pi.sent.length, 1, "loss delivered");
    assert.equal(map.size, 0, "entry finalized");
  });
});

describe("synthesizeLostResult restart note", () => {
  it("notes a respawned pane when the loss follows a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-note-"));
    const sessionFile = writeSessionFixture(dir);
    const restarted = fakeRunning({
      sessionFile,
      restart: { attemptedAt: Date.now() - 5000, respawnedAt: Date.now() - 4000 },
    });
    const fresh = fakeRunning({ sessionFile });
    assert.match(__test__.synthesizeLostResult(restarted as never, "pane_lost").summary, /restart/i);
    assert.doesNotMatch(__test__.synthesizeLostResult(fresh as never, "pane_lost").summary, /automatic restart/i);
  });
});
