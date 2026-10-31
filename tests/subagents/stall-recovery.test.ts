/**
 * Stalled-child health monitoring + recovery.
 *
 * Defect: a child could freeze while its tmux pane still rendered — the
 * status machine never aged an "active" snapshot into stalled, so a frozen
 * child sat unnoticed until the 30-minute session-file sweep killed it, and
 * that sweep never even ran while status cosmetics were disabled.
 *
 * Fix: stall decisions use the heartbeat age of the activity snapshot
 * (phase-aware, env-tunable thresholds). A stalled non-interactive child with
 * a heartbeat trail is nudged once (interrupt + health-check steer); if
 * activity does not resume within the grace window it is restarted once, and
 * a refused or failed restart delivers a synthesized "stalled" result. A
 * recovered-then-stalled-again child skips the nudge. Children without an
 * activity trail (recorder never ran or disabled) are left to the sweep's
 * session-file path.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  advanceStatusState,
  createStatusState,
  observeStatus,
} from "../../extensions/subagents/status.ts";
import {
  writeSubagentActivityFile,
  type SubagentActivityState,
} from "../../extensions/subagents/activity.ts";
import { STALL_TICKS } from "../../extensions/subagents/reconcile.ts";
import { __test__ } from "../../extensions/subagents/index.ts";

// Synthesized-result deliveries append to the repo-root inbox resolved from
// cwd; the shared bootstrap redirects PI_SUBAGENT_INBOX to a global tmp file —
// scrub it per test so appends land in each test's own repo-shaped tmp dir.
const savedInboxOverride = process.env.PI_SUBAGENT_INBOX;
beforeEach(() => {
  delete process.env.PI_SUBAGENT_INBOX;
});
afterEach(() => {
  if (savedInboxOverride === undefined) delete process.env.PI_SUBAGENT_INBOX;
  else process.env.PI_SUBAGENT_INBOX = savedInboxOverride;
  __test__.runningSubagents.clear();
});

// --- Helpers ---

/** Repo-shaped tmp dir: synthesized-result inbox writes stay contained. */
function makeRepoDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stall-${label}-`));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** Header + one assistant turn: enough progress to qualify for a restart. */
function writeSessionFixture(dir: string, name = "child.jsonl"): string {
  const file = join(dir, name);
  const lines = [
    JSON.stringify({ type: "session", id: "sess-stall-1", cwd: dir }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Milestone one done." }],
        usage: { cost: { total: 0.01 } },
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function activityFixture(
  childId: string,
  at: number,
  overrides: Partial<SubagentActivityState> = {},
): SubagentActivityState {
  return {
    version: 1,
    runningChildId: childId,
    createdAt: at,
    updatedAt: at,
    sequence: 1,
    latestEvent: "tool_execution_start",
    phase: "active",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: true,
    activeScope: "tool",
    activeSince: at,
    toolName: "bash",
    ...overrides,
  };
}

function fakeRunning(overrides: Record<string, unknown> = {}): any {
  return {
    id: "stall-1",
    name: "Worker-1",
    task: "verify the health watchdog",
    agent: "worker",
    surface: "%990001",
    startTime: Date.now() - 120_000,
    sessionFile: "/nonexistent/session.jsonl",
    interactive: false,
    autoExit: true,
    cwd: process.cwd(),
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() - 120_000 }),
    ...overrides,
  };
}

function fakePi() {
  const sent: { customType?: string; content: string; details?: any }[] = [];
  return {
    sent,
    sendMessage(message: { customType?: string; content: string; details?: unknown }) {
      sent.push({
        customType: message.customType,
        content: message.content,
        details: message.details,
      });
    },
  };
}

/** A status state whose last active heartbeat is `nowMs - 605_000` old —
 *  comfortably past the 10-minute active threshold, so the kind is stalled. */
function stalledStatusState(lastHeartbeatMs: number, nowMs: number) {
  let state = createStatusState({ source: "pi", startTimeMs: lastHeartbeatMs - 1_000 });
  state = observeStatus(state, {
    snapshot: "present",
    updatedAt: lastHeartbeatMs,
    sequence: 1,
    phase: "active",
    active: true,
    activeScope: "tool",
    activeSince: lastHeartbeatMs,
    latestEvent: "tool_execution_start",
  }, lastHeartbeatMs);
  const advanced = advanceStatusState(state, nowMs);
  assert.equal(advanced.snapshot.kind, "stalled", "fixture must be past the stall threshold");
  return advanced.nextState;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// --- Recovery state machine ---

describe("stall recovery state machine", () => {
  it("nudges a stalled child once: interrupt, then a health-check steer", () => {
    const pi = fakePi();
    const running = fakeRunning({ statusState: stalledStatusState(100_000, 705_000) });
    const calls: string[] = [];
    const deps = {
      interrupt: (surface: string) => calls.push(`interrupt:${surface}`),
      sendCommand: (surface: string, command: string) => calls.push(`send:${surface}:${command}`),
    };

    __test__.handleStallTransition(pi as never, running, 705_000, deps);

    assert.equal(calls.length, 2, "interrupt then steer, exactly once each");
    assert.match(calls[0], /^interrupt:%990001$/);
    assert.match(calls[1], /^send:%990001:Health check: no activity for \d+ min\./);
    assert.match(calls[1], /kill it and continue from your last milestone/);
    assert.match(calls[1], /ask_question/);
    assert.equal(running.stallRecovery?.nudgedAt, 705_000);
    assert.equal(running.stallRecovery?.exhaustedAt, undefined);
    assert.equal(pi.sent.length, 0, "the nudge itself does not message the parent");
  });

  it("leaves interactive, claude, and heartbeat-less children alone", () => {
    const calls: string[] = [];
    const deps = {
      interrupt: () => calls.push("interrupt"),
      sendCommand: () => calls.push("send"),
    };
    const pi = fakePi();
    const state = stalledStatusState(100_000, 705_000);

    const interactive = fakeRunning({ interactive: true, statusState: state });
    __test__.handleStallTransition(pi as never, interactive, 705_000, deps);
    assert.equal(interactive.stallRecovery, undefined, "user-driven pane is never nudged");

    const claude = fakeRunning({ cli: "claude", statusState: state });
    __test__.handleStallTransition(pi as never, claude, 705_000, deps);
    assert.equal(claude.stallRecovery, undefined, "claude child has no activity contract");

    // No heartbeat trail (recorder never ran or disabled): the sweep's
    // session-file path owns this child — recovery must not fire.
    let missing = createStatusState({ source: "pi", startTimeMs: 0 });
    missing = observeStatus(missing, { snapshot: "missing" }, 1_000);
    const heartbeatless = fakeRunning({
      statusState: { ...missing, currentKind: "stalled" },
    });
    __test__.handleStallTransition(pi as never, heartbeatless, 500_000, deps);
    assert.equal(heartbeatless.stallRecovery, undefined, "no trail to age — nothing to recover");

    assert.deepEqual(calls, []);
  });

  it("recovers without escalation when activity resumes inside the grace window", () => {
    const pi = fakePi();
    const running = fakeRunning({ statusState: stalledStatusState(100_000, 705_000) });
    running.stallRecovery = { nudgedAt: 705_000 };

    // The child woke up: a fresh heartbeat flips the kind off stalled.
    const recovered = advanceStatusState(
      observeStatus(running.statusState, {
        snapshot: "present",
        updatedAt: 760_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 760_000,
        latestEvent: "tool_execution_start",
      }, 760_000),
      760_500,
    );
    assert.equal(recovered.transition, "recovered");
    running.statusState = recovered.nextState;

    let restarts = 0;
    __test__.enforceStallRecovery(pi as never, running, 705_000 + 121_000, {
      restart: async () => {
        restarts += 1;
        return true;
      },
    });

    assert.equal(restarts, 0, "recovered child is never restarted");
    assert.equal(pi.sent.length, 0, "nothing delivered");
    assert.equal(running.stallRecovery?.exhaustedAt, undefined, "episode simply outlived");
  });

  it("restarts once after the grace window; a failed restart delivers synthesized stalled", async () => {
    const dir = makeRepoDir("grace");
    const sessionFile = writeSessionFixture(dir);
    const pi = fakePi();
    const running = fakeRunning({ cwd: dir, sessionFile, statusState: stalledStatusState(100_000, 705_000) });
    __test__.runningSubagents.set(running.id, running);
    running.stallRecovery = { nudgedAt: 705_000 };

    let restarts = 0;
    __test__.enforceStallRecovery(pi as never, running, 705_000 + 121_000, {
      restart: async () => {
        restarts += 1;
        return false;
      },
    });
    await flush();

    assert.equal(restarts, 1, "exactly one restart attempt");
    assert.equal(running.stallRecovery?.exhaustedAt, 705_000 + 121_000);
    assert.equal(running.delivered, true);
    assert.equal(__test__.runningSubagents.has(running.id), false, "entry finalized");
    const result = pi.sent.find((m) => m.customType === "subagent_result");
    assert.ok(result, "synthesized result delivered");
    assert.equal(result.details.synthesized, "stalled");
    assert.match(result.content, /stall/i);

    // One recovery per episode: a later tick must not escalate again.
    __test__.enforceStallRecovery(pi as never, running, 705_000 + 200_000, {
      restart: async () => {
        restarts += 1;
        return false;
      },
    });
    await flush();
    assert.equal(restarts, 1, "exhausted episode never re-escalates");
    assert.equal(pi.sent.length, 1, "no second delivery");
  });

  it("delivers immediately when the restart gates refuse the stalled child", async () => {
    const dir = makeRepoDir("refused");
    const pi = fakePi();
    // No session file: no progress worth resuming, so the gate refuses.
    const running = fakeRunning({
      cwd: dir,
      sessionFile: join(dir, "absent.jsonl"),
      statusState: stalledStatusState(100_000, 705_000),
    });
    __test__.runningSubagents.set(running.id, running);
    running.stallRecovery = { nudgedAt: 705_000 };

    let restarts = 0;
    __test__.enforceStallRecovery(pi as never, running, 705_000 + 121_000, {
      restart: async () => {
        restarts += 1;
        return false;
      },
    });
    await flush();

    assert.equal(restarts, 0, "gate refused before any restart attempt");
    assert.equal(running.delivered, true);
    const result = pi.sent.find((m) => m.customType === "subagent_result");
    assert.ok(result, "loss delivered without a restart");
    assert.equal(result.details.synthesized, "stalled");
  });

  it("a recovered-then-stalled-again child skips the nudge and finalizes immediately", async () => {
    const dir = makeRepoDir("again");
    const sessionFile = writeSessionFixture(dir);
    const pi = fakePi();
    const running = fakeRunning({ cwd: dir, sessionFile, statusState: stalledStatusState(800_000, 1_405_000) });
    __test__.runningSubagents.set(running.id, running);
    // The first episode's nudge, outlived by a recovery: a second stall must
    // not interrupt the child again — it goes straight to restart-or-deliver.
    running.stallRecovery = { nudgedAt: 200_000 };

    const calls: string[] = [];
    __test__.handleStallTransition(pi as never, running, 1_405_000, {
      interrupt: () => calls.push("interrupt"),
      sendCommand: () => calls.push("send"),
      restart: async () => false,
    });
    await flush();

    assert.deepEqual(calls, [], "no second nudge");
    assert.equal(running.delivered, true, "straight to restart-or-deliver");
    assert.ok(pi.sent.some((m) => m.customType === "subagent_result"));
  });

  it("honors PI_SUBAGENT_STALL_RECOVERY_GRACE_MS from the environment", async () => {
    const saved = process.env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS;
    try {
      const pi = fakePi();
      const dir = makeRepoDir("envgrace");
      const sessionFile = writeSessionFixture(dir);
      const running = fakeRunning({
        cwd: dir,
        sessionFile,
        statusState: stalledStatusState(100_000, 705_000),
      });
      __test__.runningSubagents.set(running.id, running);
      running.stallRecovery = { nudgedAt: 100_000 };

      // Default 120s grace: 119_999 ms of silence is still inside the window.
      let restarts = 0;
      const deps = {
        restart: async () => {
          restarts += 1;
          return false;
        },
      };
      delete process.env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS;
      __test__.enforceStallRecovery(pi as never, running, 219_999, deps);
      assert.equal(restarts, 0, "default grace not yet lapsed");

      process.env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS = "1000";
      __test__.enforceStallRecovery(pi as never, running, 101_500, deps);
      await flush();
      assert.equal(restarts, 1, "env override shrinks the grace window");
    } finally {
      if (saved === undefined) delete process.env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS;
      else process.env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS = saved;
    }
  });
});

// --- Status refresh tick (drives observation, recovery, and the sweep) ---

describe("status refresh tick", () => {
  const live = async () => new Set(["%990001"]);

  it("detects a frozen child, nudges it, and recovers when heartbeats resume", () => {
    const dir = makeRepoDir("tick-live");
    const sessionFile = writeSessionFixture(dir);
    const activityFile = join(dir, "subagent-activity", "tick-live.json");
    mkdirSync(dirname(activityFile), { recursive: true });
    writeSubagentActivityFile(activityFile, activityFixture("tick-live", 1_000));
    const running = fakeRunning({
      id: "tick-live",
      cwd: dir,
      sessionFile,
      activityFile,
      statusState: createStatusState({ source: "pi", startTimeMs: 1_000 }),
    });
    __test__.runningSubagents.set(running.id, running);
    const pi = fakePi();

    __test__.runStatusRefreshTick(pi as never, 2_000, { listPanes: live });
    assert.equal(running.statusState.currentKind, "active");

    // Heartbeats stop: 10 minutes of silence flips the kind and starts
    // recovery. The real pane channel is absent in tests, so the nudge's
    // sends are contained no-ops; the bookkeeping is what must land.
    __test__.runStatusRefreshTick(pi as never, 606_000, { listPanes: live });
    assert.equal(running.statusState.currentKind, "stalled");
    assert.equal(running.stallRecovery?.nudgedAt, 606_000);
    const stalledNotice = pi.sent.find((m) => m.customType === "subagent_status");
    assert.ok(stalledNotice, "parent steered about the stall");
    assert.match(stalledNotice.content, /stalled/);

    // Resume inside the grace window: fresh heartbeat -> recovered, no kill.
    writeSubagentActivityFile(
      activityFile,
      activityFixture("tick-live", 607_000, { sequence: 2 }),
    );
    __test__.runStatusRefreshTick(pi as never, 607_500, { listPanes: live });
    assert.equal(running.statusState.currentKind, "active");
    const notices = pi.sent.filter((m) => m.customType === "subagent_status");
    assert.match(notices[notices.length - 1].content, /recovered/);

    __test__.runStatusRefreshTick(pi as never, 606_000 + 121_000, { listPanes: live });
    assert.equal(running.delivered, undefined, "recovered child is never finalized");
    assert.equal(__test__.runningSubagents.has(running.id), true);
    assert.equal(pi.sent.some((m) => m.customType === "subagent_result"), false);
  });

  it("frozen through the grace window: one restart, failure delivers synthesized stalled", async () => {
    const dir = makeRepoDir("tick-frozen");
    const sessionFile = writeSessionFixture(dir);
    const activityFile = join(dir, "subagent-activity", "tick-frozen.json");
    mkdirSync(dirname(activityFile), { recursive: true });
    writeSubagentActivityFile(activityFile, activityFixture("tick-frozen", 1_000));
    const running = fakeRunning({
      id: "tick-frozen",
      cwd: dir,
      sessionFile,
      activityFile,
      statusState: createStatusState({ source: "pi", startTimeMs: 1_000 }),
    });
    __test__.runningSubagents.set(running.id, running);
    const pi = fakePi();

    __test__.runStatusRefreshTick(pi as never, 2_000, { listPanes: live });
    __test__.runStatusRefreshTick(pi as never, 606_000, { listPanes: live });
    assert.equal(running.stallRecovery?.nudgedAt, 606_000);

    // Grace lapses with no resumed heartbeat. The restart attempt happens for
    // real: without a loadout sidecar it refuses, so the loss is delivered.
    __test__.runStatusRefreshTick(pi as never, 606_000 + 121_000, { listPanes: live });
    await flush();

    assert.equal(running.restart?.attemptedAt != null, true, "one restart was attempted");
    assert.equal(running.delivered, true);
    assert.equal(__test__.runningSubagents.has(running.id), false, "pane closed, entry gone");
    const result = pi.sent.find((m) => m.customType === "subagent_result");
    assert.ok(result, "synthesized result delivered");
    assert.equal(result.details.synthesized, "stalled");
  });

  it("still sweeps with status cosmetics disabled, and recorder-less children never nudge", async () => {
    const dir = makeRepoDir("tick-disabled");
    const sessionFile = writeSessionFixture(dir);
    // No activityFile: the recorder never ran, so liveness falls back to the
    // sweep's session-file mtime/size path.
    const running = fakeRunning({
      id: "tick-disabled",
      cwd: dir,
      sessionFile,
      statusState: createStatusState({ source: "pi", startTimeMs: 1_000 }),
    });
    __test__.runningSubagents.set(running.id, running);
    const pi = fakePi();

    const enabledSaved = __test__.statusConfig.enabled;
    __test__.statusConfig.enabled = false;
    try {
      let now = 1_000;
      for (let i = 0; i < STALL_TICKS + 1; i++) {
        __test__.runStatusRefreshTick(pi as never, now, { listPanes: live });
        now += 1_000;
      }
      await flush();
    } finally {
      __test__.statusConfig.enabled = enabledSaved;
    }

    assert.equal(running.stallRecovery, undefined, "no heartbeat trail -> no recovery nudge");
    assert.equal(__test__.runningSubagents.has(running.id), false, "sweep finalized the frozen entry");
    assert.equal(pi.sent.length, 1, "exactly one message: the result, no status cosmetics");
    assert.equal(pi.sent[0].customType, "subagent_result");
    assert.equal(pi.sent[0].details.synthesized, "stalled");
  });
});
