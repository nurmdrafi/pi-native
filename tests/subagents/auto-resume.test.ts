/**
 * Transient-provider-error auto-resume: bounded and de-noised.
 *
 * Defect: a 429/5xx from a child's provider triggered an automatic resume
 * whose only user-facing trace was an error-severity diagnostic ("...hit a
 * transient provider error"), and whose attempt count was invisible — the
 * parent could not tell a first resume from a loop, and the one-attempt cap
 * surfaced only as a generic "auto-retry exhausted" failure text.
 *
 * Contract under test:
 * - each automatic resume reports an informational notice (severity info,
 *   never an error line) stating "attempt N of MAX" (default MAX 2,
 *   env-tunable via PI_SUBAGENT_MAX_AUTO_RESUMES);
 * - once the budget is spent the child fails with a final message naming
 *   the child, the provider error, and the resume count;
 * - the counter is per child entry: a fresh spawn starts at attempt 1 even
 *   after a sibling spent its own budget;
 * - the loss-restart gates still apply, and the one-shot pane-loss restart
 *   semantics are unchanged (canRestartLostPane keeps refusing any prior
 *   restart; only the transient path is budget-based).
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
delete process.env.PI_SUBAGENT_MAX_AUTO_RESUMES;
const { __test__ } = await import("../../extensions/subagents/index.ts");
const { createStatusState } = await import("../../extensions/subagents/status.ts");

const flushMicrotasks = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function recordingPi() {
  const sent: { msg: Record<string, unknown>; opts: Record<string, unknown> | undefined }[] = [];
  return {
    sent,
    sendMessage(msg: Record<string, unknown>, opts?: Record<string, unknown>) {
      sent.push({ msg, opts });
    },
    registerMessageRenderer() {},
  };
}

let dir: string;
let sessionFile: string;

function fakeRunning(overrides: Record<string, unknown> = {}): any {
  return {
    id: "resume-1",
    name: "Worker-1",
    task: "resume after transient provider errors",
    agent: "worker",
    surface: "%999999",
    startTime: Date.now() - 60_000,
    sessionFile,
    parentSessionId: "parent-sess",
    interactive: false,
    autoExit: true,
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() - 60_000 }),
    ...overrides,
  };
}

function transientResult(running: { name: string; task: string }) {
  return {
    name: running.name,
    task: running.task,
    summary: "",
    exitCode: 1,
    elapsed: 5_000,
    errorMessage: "429 Too Many Requests: rate limit reached",
  };
}

/** Capture ui.notify rows while a UI context is installed; restores null. */
async function withNotifiedUi(fn: (notified: { text: string; severity?: string }[]) => Promise<void>) {
  const notified: { text: string; severity?: string }[] = [];
  __test__.setUiContext({
    hasUI: true,
    ui: { notify: (text: string, severity?: string) => notified.push({ text, severity }) },
  } as never);
  try {
    await fn(notified);
  } finally {
    __test__.setUiContext(null);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auto-resume-"));
  sessionFile = join(dir, "child.jsonl");
  // Minimal session fixture: header + one assistant turn (restart-gate proof
  // of resumable progress).
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "sess-fixture-1", cwd: dir }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Partial analysis done." }],
          usage: { cost: { total: 0.01 } },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
});

afterEach(() => {
  __test__.setUiContext(null);
  __test__.runningSubagents.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveMaxAutoResumes", () => {
  it("defaults to 2 and accepts a positive integer override", () => {
    assert.equal(__test__.resolveMaxAutoResumes({}), 2);
    assert.equal(__test__.resolveMaxAutoResumes({ PI_SUBAGENT_MAX_AUTO_RESUMES: "3" }), 3);
    for (const bad of ["", "0", "-1", "abc"]) {
      assert.equal(
        __test__.resolveMaxAutoResumes({ PI_SUBAGENT_MAX_AUTO_RESUMES: bad }),
        2,
        `${JSON.stringify(bad)} falls back to the default`,
      );
    }
  });
});

describe("transient auto-resume notices and budget", () => {
  it("a first transient error resumes with an informational notice stating attempt 1 of 2", async () => {
    await withNotifiedUi(async (notified) => {
      const restartCalls: string[] = [];
      const pi = recordingPi();
      const running = fakeRunning();
      __test__.deliverSubagentResult(pi as never, running as never, transientResult(running), undefined, {
        restart: async (r) => {
          restartCalls.push(r.id);
          return true;
        },
      });
      await flushMicrotasks();

      assert.equal(restartCalls.length, 1, "the transient error triggers one resume");
      assert.equal(running.autoResumeCount, 1, "the attempt is claimed on the entry");
      assert.equal(pi.sent.length, 0, "no result is delivered while the child resumes");

      const notice = notified.find((n) => /transient provider error/.test(n.text));
      assert.ok(notice, "the resume surfaces a notice");
      assert.equal(notice!.severity, "info", "the notice is informational, not an error line");
      assert.match(notice!.text, /"Worker-1"/, "the notice names the child");
      assert.match(notice!.text, /attempt 1 of 2/, "the notice states the attempt and the cap");
      assert.doesNotMatch(notice!.text, /^Error:/, "no Error: prefix");
    });
  });

  it("a second transient error still resumes, stating attempt 2 of 2", async () => {
    await withNotifiedUi(async (notified) => {
      const restartCalls: string[] = [];
      const pi = recordingPi();
      const running = fakeRunning({ autoResumeCount: 1 });
      __test__.deliverSubagentResult(pi as never, running as never, transientResult(running), undefined, {
        restart: async (r) => {
          restartCalls.push(r.id);
          return true;
        },
      });
      await flushMicrotasks();

      assert.equal(restartCalls.length, 1, "the second attempt is allowed");
      assert.equal(running.autoResumeCount, 2);
      const notice = notified.find((n) => /transient provider error/.test(n.text));
      assert.ok(notice);
      assert.match(notice!.text, /attempt 2 of 2/);
      assert.equal(pi.sent.length, 0);
    });
  });

  it("a third transient error delivers a final failure naming the child, the provider error, and the resume count", async () => {
    const restartCalls: string[] = [];
    const pi = recordingPi();
    const running = fakeRunning({ autoResumeCount: 2 });
    __test__.deliverSubagentResult(pi as never, running as never, transientResult(running), undefined, {
      restart: async (r) => {
        restartCalls.push(r.id);
        return true;
      },
    });
    await flushMicrotasks();

    assert.equal(restartCalls.length, 0, "the spent budget triggers no further resume");
    assert.equal(pi.sent.length, 1, "the failure delivers exactly once");
    const msg = pi.sent[0]!.msg as { customType?: string; content?: string };
    assert.equal(msg.customType, "subagent_result");
    assert.match(msg.content!, /Sub-agent "Worker-1"/, "names the child");
    assert.match(msg.content!, /429 Too Many Requests/, "surfaces the provider error");
    assert.match(msg.content!, /persisted after 2 automatic resumes/, "states the resume count");
    assert.equal(running.autoResumeCount, 2, "the count is not incremented past the cap");
  });

  it("a refused resume attempt still consumes the budget and delivers the failure", async () => {
    const pi = recordingPi();
    const running = fakeRunning();
    __test__.deliverSubagentResult(pi as never, running as never, transientResult(running), undefined, {
      restart: async () => false,
    });
    await flushMicrotasks();

    assert.ok(running.delivered, "the failure path completes");
    assert.equal(pi.sent.length, 1);
    const msg = pi.sent[0]!.msg as { content?: string };
    assert.match(msg.content!, /automatic resumes/, "the final failure carries the resume count");
  });
});

describe("per-child reset", () => {
  it("a fresh child entry starts at attempt 1 even after a sibling spent its budget", async () => {
    await withNotifiedUi(async (notified) => {
      // Sibling A: budget already spent -> final failure.
      const piA = recordingPi();
      const a = fakeRunning({ id: "sibling-a", name: "Worker-A", autoResumeCount: 2 });
      __test__.deliverSubagentResult(piA as never, a as never, transientResult(a));
      await flushMicrotasks();
      assert.equal(piA.sent.length, 1, "spent sibling delivers a failure");

      // Sibling B: fresh entry -> first attempt.
      const restartCalls: string[] = [];
      const piB = recordingPi();
      const b = fakeRunning({ id: "sibling-b", name: "Worker-B" });
      __test__.deliverSubagentResult(piB as never, b as never, transientResult(b), undefined, {
        restart: async (r) => {
          restartCalls.push(r.id);
          return true;
        },
      });
      await flushMicrotasks();

      assert.equal(restartCalls.length, 1, "the fresh child still earns a resume");
      assert.equal(b.autoResumeCount, 1);
      const notice = notified.find((n) => /"Worker-B".*transient provider error|transient provider error/.test(n.text) && /Worker-B/.test(n.text));
      assert.ok(notice, "the fresh child's notice names it");
      assert.match(notice!.text, /attempt 1 of 2/);
    });
  });
});

describe("canAutoResume gates", () => {
  it("a qualifying fresh entry passes; spent budgets and in-flight restarts refuse", () => {
    assert.equal(__test__.canAutoResume(fakeRunning()), true, "fresh entry qualifies");

    assert.equal(
      __test__.canAutoResume(fakeRunning({ autoResumeCount: 2 })),
      false,
      "spent budget",
    );

    assert.equal(
      __test__.canAutoResume(fakeRunning({ restart: { attemptedAt: Date.now() } })),
      false,
      "a restart attempt in flight (or already failed) blocks",
    );

    assert.equal(
      __test__.canAutoResume(fakeRunning({ restart: { attemptedAt: Date.now(), respawnedAt: Date.now() } })),
      true,
      "a completed respawn alone does not disqualify — the budget bounds this path",
    );

    assert.equal(__test__.canAutoResume(fakeRunning({ delivered: true })), false, "already delivered");
    assert.equal(__test__.canAutoResume(fakeRunning({ cancelledAt: Date.now() })), false, "cancelled");
    assert.equal(__test__.canAutoResume(fakeRunning({ interactive: true })), false, "interactive");
  });

  it("keeps the one-shot pane-loss restart semantics unchanged", () => {
    // Any prior restart — even a completed respawn — still blocks the
    // pane-loss restart path; only the transient path is budget-based.
    assert.equal(
      __test__.canRestartLostPane(fakeRunning({ restart: { attemptedAt: Date.now(), respawnedAt: Date.now() } })),
      false,
      "pane-loss restart stays one-shot",
    );
    assert.equal(__test__.canRestartLostPane(fakeRunning()), true, "fresh entry still qualifies");
  });
});
