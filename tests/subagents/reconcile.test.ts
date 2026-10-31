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
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
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
import { appendSelfResult } from "../../extensions/subagents/subagent-done.ts";
import { __test__ } from "../../extensions/subagents/index.ts";

// These tests assert the repo-root DEFAULT resolution of the durable inbox.
// The shared test bootstrap redirects PI_SUBAGENT_INBOX to a global tmp file
// so a suite running inside a real subagent cannot leak self-reports into
// the live parent's inbox — scrub that override for the duration of each
// test so appends land in the per-test repo root the fixtures construct.
const savedInboxOverride = process.env.PI_SUBAGENT_INBOX;
beforeEach(() => {
  delete process.env.PI_SUBAGENT_INBOX;
});
afterEach(() => {
  if (savedInboxOverride === undefined) delete process.env.PI_SUBAGENT_INBOX;
  else process.env.PI_SUBAGENT_INBOX = savedInboxOverride;
});

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

/** Run `fn` with the process cwd moved to `dir`. Adoption resolves the
 * durable-inbox repo root from cwd — without this the tests append their
 * synthesized results to the real repo inbox and a live session drains them. */
async function withCwd<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const here = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(here);
  }
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

  it("persists exactly one inbox record when delivery races a sweep finalize", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-once-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const pi = fakePi();
    const r = fakeRunning({ id: "dup-1", cwd: root });
    const result = { name: "Worker-1", task: "verify the delivery gap fix", summary: "s", sessionFile: r.sessionFile, exitCode: 0, elapsed: 1 };
    __test__.deliverSubagentResult(pi as never, r as never, result);
    __test__.deliverSubagentResult(pi as never, r as never, result);
    const lines = readFileSync(resultInboxPath(root), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "second delivery must not re-append");
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

  it("compacts the inbox once every record is drained", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-compact-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    for (const id of ["c-1", "c-2"]) {
      appendSubagentResult({ id, ts: Date.now(), name: "W", task: "t", sessionFile: "/tmp/a.jsonl", parentSessionId: id === "c-1" ? "p1" : null, repoRoot: root, summary: "done", exitCode: 0, elapsed: 1 });
    }
    const got = drainSubagentResults(root, "other-session");
    assert.equal(got.length, 2, "foreign records surfaced");
    assert.equal(readFileSync(resultInboxPath(root), "utf8"), "", "inbox compacted after a full drain");
    assert.deepEqual(drainSubagentResults(root, "third-session"), [], "nothing resurfaces after compaction");
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

  it("skips a corrupt line instead of blinding the whole drain", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-corrupt-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    for (const id of ["v-1", "v-2"]) {
      appendSubagentResult({ id, ts: Date.now(), name: "W", task: "t", sessionFile: "/tmp/v.jsonl", parentSessionId: null, repoRoot: root, summary: "done", exitCode: 0, elapsed: 1 });
    }
    // Simulate a crash mid-append: a truncated line at the tail.
    const inbox = resultInboxPath(root);
    writeFileSync(inbox, readFileSync(inbox, "utf8") + '{"id":"broken', "utf8");

    const got = drainSubagentResults(root, "other-session");
    assert.equal(got.length, 2, "valid records still surface past a corrupt line");
    // A full drain compacts — which also drops the corrupt line.
    assert.equal(readFileSync(inbox, "utf8"), "", "corrupt line cleaned by compaction");
  });

  it("surfaces an unobserved record even to its own parent session", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-unobserved-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    appendSubagentResult({ id: "u-1", ts: Date.now(), name: "W", task: "t", sessionFile: "/tmp/u.jsonl", parentSessionId: "parent-1", repoRoot: root, summary: "self-reported", exitCode: 0, elapsed: 1, observedByParent: false });
    const got = drainSubagentResults(root, "parent-1");
    assert.equal(got.length, 1, "parent never saw the in-memory delivery — surface on resume");
    assert.equal(got[0].id, "u-1");
  });

  it("still skips an observed record for its own parent session", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-observed-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    appendSubagentResult({ id: "o-1", ts: Date.now(), name: "W", task: "t", sessionFile: "/tmp/o.jsonl", parentSessionId: "parent-1", repoRoot: root, summary: "delivered", exitCode: 0, elapsed: 1, observedByParent: true });
    assert.deepEqual(drainSubagentResults(root, "parent-1"), [], "already steered in memory");
  });

  it("dedupes same-id lines, keeping the last (richest) record", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-dedupe-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const base = { id: "d-1", ts: Date.now(), name: "W", task: "t", sessionFile: "/tmp/d.jsonl", parentSessionId: "parent-1", repoRoot: root, exitCode: 0, elapsed: 1 };
    appendSubagentResult({ ...base, summary: "child self-report", observedByParent: false });
    appendSubagentResult({ ...base, summary: "parent delivery", observedByParent: true });
    const got = drainSubagentResults(root, "other-session");
    assert.equal(got.length, 1, "one record per id");
    assert.equal(got[0].summary, "parent delivery");
  });

  it("child self-report appends an unobserved record to the repo inbox", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-selfreport-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const sessionFile = writeSessionFixture(root, "child.jsonl");
    const here = process.cwd();
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => {
      saved[k] = process.env[k];
      process.env[k] = v;
    };
    setEnv("PI_SUBAGENT_ID", "self-1");
    setEnv("PI_SUBAGENT_NAME", "Worker-9");
    setEnv("PI_SUBAGENT_TASK", "verify child self-report");
    setEnv("PI_SUBAGENT_SESSION", sessionFile);
    setEnv("PI_SUBAGENT_PARENT_SESSION", "parent-9");
    setEnv("PI_SUBAGENT_START_MS", String(Date.now() - 5000));
    try {
      process.chdir(root);
      appendSelfResult();
    } finally {
      process.chdir(here);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const lines = readFileSync(resultInboxPath(root), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "one self-report record");
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, "self-1");
    assert.equal(rec.observedByParent, false);
    assert.equal(rec.parentSessionId, "parent-9");
    assert.match(rec.summary, /LAST ASSISTANT TEXT/);
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

describe("adoption of previous-session orphans", () => {
  it("finalizes a dead-pane orphan from its session file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adopt-dead-"));
    const sessionFile = writeSessionFixture(dir, "orphan.jsonl");
    const pi = fakePi();
    const orphan = {
      id: "adopt-1",
      name: "Worker-A",
      task: "t",
      sessionFile,
      surface: "%424242",
      startedAt: Date.now() - 60_000,
      detachedAt: Date.now(),
    };
    await withCwd(dir, () =>
      __test__.adoptPendingSubagents(pi as never, [orphan], async () => new Set<string>()));
    assert.equal(pi.sent.length, 1, "synthesized pane_lost delivered");
    assert.match(pi.sent[0].content, /was lost/, "pane_lost presentation");
  });

  it("re-watches a live-pane orphan under its registered name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adopt-live-"));
    const sessionFile = writeSessionFixture(dir, "orphan2.jsonl");
    const pi = fakePi();
    const orphan = {
      id: "adopt-2",
      name: "Worker-B",
      task: "t",
      sessionFile,
      surface: "%111222",
      startedAt: Date.now() - 60_000,
      detachedAt: Date.now(),
    };
    await withCwd(dir, () =>
      __test__.adoptPendingSubagents(pi as never, [orphan], async () => new Set(["%111222"])));
    const found = __test__.resolveRunningByName("Worker-B");
    assert.ok("running" in found, "adopted entry is watchable/steerable by name");
  });
});
