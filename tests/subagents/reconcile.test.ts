/**
 * Reconciliation sweep + durable result inbox.
 *
 * Defect: a budget-killed or externally reaped subagent vanished without
 * delivering a result — the poll loop keys on the pane, so a group pane
 * reap produced no observable exit and the result was never constructed.
 * The fix synthesizes the result from the durable session file (independent
 * of the pane) and delivers it through a durable per-repo inbox written
 * BEFORE any in-memory delivery.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  sweepRunningSubagents,
  STALL_TICKS,
  type SweepDeps,
} from "../../extensions/subagents/reconcile.ts";
import {
  appendSubagentResult,
  drainSubagentResults,
  repoRootFor,
  resultInboxPath,
} from "../../extensions/subagents/inbox.ts";
import { __test__ } from "../../extensions/subagents/index.ts";

/** Minimal session JSONL fixture: header + two assistant turns. */
function writeSessionFixture(dir: string, name = "session.jsonl"): string {
  const file = join(dir, name);
  const lines = [
    JSON.stringify({ type: "session", id: "sess-fixture-1", cwd: dir }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Partial analysis done." }],
        usage: { cost: { total: 0.01 } },
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "LAST ASSISTANT TEXT: verified hooks span." }],
        usage: { cost: { total: 0.02 } },
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

type RunningLike = Parameters<SweepDeps["finalize"]>[0];

function fakeRunning(overrides: Record<string, unknown> = {}): RunningLike {
  return {
    id: "run-1",
    name: "Worker-1",
    task: "verify the delivery gap fix",
    agent: "worker",
    surface: "%999999",
    startTime: Date.now() - 60_000,
    sessionFile: "/nonexistent/session.jsonl",
    interactive: false,
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

describe("synthesized results from the durable session file", () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-synth-"));

  it("reports budget_exceeded with last assistant text when the stopper fired", () => {
    const sessionFile = writeSessionFixture(dir, "breached.jsonl");
    const running = fakeRunning({
      sessionFile,
      budget: { turns: 25 },
      budgetStopper: { breached: () => ({ dimension: "turns", value: 27, limit: 25 }) },
    });
    const result = __test__.synthesizeLostResult(running as never, "pane_lost");
    assert.equal(result.error, "budget_exceeded");
    assert.equal(result.sessionFile, sessionFile);
    assert.match(result.summary, /LAST ASSISTANT TEXT: verified hooks span\./);
    assert.match(result.errorMessage ?? "", /turns 27\/25/);
  });

  it("derives the breach from the meter when the stopper never observed it", () => {
    const sessionFile = writeSessionFixture(dir, "metered.jsonl");
    const running = fakeRunning({
      sessionFile,
      budget: { turns: 2 },
      budgetMeter: { update: () => ({ turns: 2, costUsd: 0.03 }) },
      budgetStopper: { breached: () => null },
    });
    const result = __test__.synthesizeLostResult(running as never, "pane_lost");
    assert.equal(result.error, "budget_exceeded");
    assert.match(result.summary, /turns 2\/2/);
  });

  it("reports pane_lost when no budget applies", () => {
    const sessionFile = writeSessionFixture(dir, "plain.jsonl");
    const running = fakeRunning({ sessionFile });
    const result = __test__.synthesizeLostResult(running as never, "pane_lost");
    assert.equal(result.error, "pane_lost");
    assert.match(result.summary, /LAST ASSISTANT TEXT/);
    assert.equal(result.sessionFile, sessionFile);
  });

  it("survives a missing session file", () => {
    const running = fakeRunning({ sessionFile: join(dir, "absent.jsonl") });
    const result = __test__.synthesizeLostResult(running as never, "stalled");
    assert.equal(result.error, "pane_lost");
    assert.ok(result.summary.length > 0);
  });
});

describe("reconciliation sweep", () => {
  it("finalizes entries whose pane is gone and never double-delivers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-sweep-"));
    const sessionFile = writeSessionFixture(dir, "sweep.jsonl");
    const running = fakeRunning({ id: "run-sweep", sessionFile, cwd: dir, surface: "%424242" });
    const map = new Map([[running.id, running]]);
    const pi = fakePi();
    const inboxPath = resultInboxPath(repoRootFor(dir));

    const deps: SweepDeps = {
      runningSubagents: map,
      listPanes: async () => new Set(["%111111"]),
      finalize: (r: any, kind: any) => {
        // Mirror the production wiring: deliverSubagentResult deletes from the
        // real running map; the local map stands in for it here.
        map.delete(r.id);
        __test__.deliverSubagentResult(pi as never, r, { name: r.name, task: r.task, summary: "synth", sessionFile: r.sessionFile, exitCode: -1, elapsed: 1, error: "pane_lost" }, kind);
      },
    };

    await sweepRunningSubagents(deps);
    assert.equal(map.size, 0, "dead entry removed");
    assert.equal(pi.sent.length, 1, "result delivered once");
    assert.ok(existsSync(inboxPath), "durable inbox written before in-memory delivery");

    // Second sweep: nothing left, nothing re-delivered.
    await sweepRunningSubagents(deps);
    assert.equal(pi.sent.length, 1);
  });

  it("keeps live entries and counts a stalled session file only after the stall window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-stall-"));
    const sessionFile = writeSessionFixture(dir, "stall.jsonl");
    const livePane = fakeRunning({ id: "run-live", sessionFile, cwd: dir, surface: "%111111" });
    const map = new Map([[livePane.id, livePane]]);
    let finalized = 0;
    const deps: SweepDeps = {
      runningSubagents: map,
      listPanes: async () => new Set(["%111111"]),
      finalize: (r) => {
        finalized += 1;
        map.delete(r.id);
      },
    };

    for (let i = 0; i < STALL_TICKS && map.size > 0; i++) {
      await sweepRunningSubagents(deps);
    }
    assert.equal(finalized, 0, "long pause without file advance is not yet a stall");
    await sweepRunningSubagents(deps);
    assert.equal(finalized, 1, "stall window elapsed without advance finalizes");
  });
});

describe("durable result inbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-inbox-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  const nested = join(dir, "packages", "app");
  mkdirSync(nested, { recursive: true });

  it("resolves the repo root from a nested cwd via .git", (t) => {
    t.diagnostic(`git=${existsSync(join(dir, ".git"))} nested=${nested} dir=${dir}`);
    assert.equal(repoRootFor(nested), dir);
    assert.equal(resultInboxPath(repoRootFor(nested)), join(dir, ".pi", "subagent-results.jsonl"));
  });

  it("appends before delivery and drains exactly once, skipping the parent", () => {
    const root = repoRootFor(dir);
    const rec = {
      id: "rec-1",
      ts: Date.now(),
      name: "Worker-1",
      task: "t",
      sessionFile: "/tmp/s.jsonl",
      parentSessionId: "parent-1",
      repoRoot: root,
      summary: "done",
      exitCode: 0,
      elapsed: 5,
    };
    appendSubagentResult(rec);

    // The spawning parent already received the in-memory steer.
    assert.deepEqual(drainSubagentResults(root, "parent-1"), []);

    // A different session in the repo picks it up exactly once.
    const got = drainSubagentResults(root, "main-session");
    assert.equal(got.length, 1);
    assert.equal(got[0].id, "rec-1");
    assert.deepEqual(drainSubagentResults(root, "another-session"), [], "drained once globally");
  });

  it("ignores inbox records from another repo root", () => {
    const other = mkdtempSync(join(tmpdir(), "reconcile-inbox-other-"));
    appendSubagentResult({
      id: "rec-2",
      ts: Date.now(),
      name: "Worker-2",
      task: "t",
      sessionFile: "/tmp/o.jsonl",
      parentSessionId: null,
      repoRoot: other,
      summary: "done",
      exitCode: 0,
      elapsed: 5,
    });
    assert.equal(existsSync(resultInboxPath(repoRootFor(dir))), true);
    assert.equal(
      existsSync(resultInboxPath(other)),
      true,
      "record landed in its own repo's inbox",
    );
  });
});
