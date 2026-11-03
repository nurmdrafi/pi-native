/**
 * Dead-channel containment and the diagnostic surface for every
 * parent <- child notification send.
 *
 * Defect (TUI input flooding): when the ExtensionAPI channel errors —
 * extension reloaded, channel gone, host in an error state — every poll tick
 * and every turn that attempted a send printed its own console.error, and
 * raw stderr lands in the TUI input editor region where the user is typing:
 * one line per second per child, on mac and Linux alike, for the rest of the
 * session. The funnel's comment promised "log a diagnostic and stop"; the
 * stop was never implemented, and the ask_question notify path bypassed the
 * funnel with a raw, unhandled sendMessage.
 *
 * Contract under test:
 * - the send funnel reports a dead channel exactly ONCE per module instance,
 *   on the first failure, then never attempts another send;
 * - a synchronous throw from sendMessage is contained the same way;
 * - after the first failure the instance's 1s status/widget timers disarm;
 * - the ask_question notify (deliverPendingQuestion) rides the funnel: one
 *   attempt per question, one notice when the channel is dead;
 * - diagnostics go to the host UI notify channel when a UI exists — never to
 *   stderr, which corrupts the terminal input line; before any context
 *   answers (or on a stale one) the diagnostic is held in a queue, not
 *   printed.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

const { __test__ } = await import("../../extensions/subagents/index.ts");

type FakePi = {
  sendMessage: (m: unknown, o: unknown) => Promise<void>;
  attempts: () => number;
};

/** Fake ExtensionAPI whose sendMessage fails. mode "throw" fails
 *  synchronously — both failure shapes must be contained. */
function failingPi(mode: "reject" | "throw"): FakePi {
  let n = 0;
  const sendMessage = (_m: unknown, _o: unknown): Promise<void> => {
    n += 1;
    if (mode === "throw") throw new Error("channel gone (sync)");
    return Promise.reject(new Error("channel gone"));
  };
  return { sendMessage, attempts: () => n };
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const DEAD_LINE = /could not be delivered/;

describe("sendMessageContained dead-channel funnel", () => {
  beforeEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
  });
  afterEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
    mock.restoreAll();
  });

  it("reports the dead channel once on async rejection, then stops attempting", async () => {
    const pi = failingPi("reject");
    const err = mock.method(console, "error", () => {});
    __test__.sendMessageContained(
      pi as never,
      { customType: "subagent_result", content: "m0", display: true },
      { triggerTurn: true, deliverAs: "steer" },
    );
    await flushMicrotasks(); // first rejection observed -> channel marked dead
    for (let i = 1; i < 3; i++) {
      __test__.sendMessageContained(
        pi as never,
        { customType: "subagent_result", content: `m${i}`, display: true },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
    await flushMicrotasks();
    assert.equal(err.mock.calls.length, 0, "no stderr while no context has answered");
    const lines = __test__.pendingDiagnostics();
    assert.equal(lines.filter((l) => DEAD_LINE.test(l)).length, 1);
    assert.equal(pi.attempts(), 1);
  });

  it("contains a synchronous throw the same way", () => {
    const pi = failingPi("throw");
    const err = mock.method(console, "error", () => {});
    for (let i = 0; i < 3; i++) {
      __test__.sendMessageContained(
        pi as never,
        { customType: "subagent_result", content: `m${i}`, display: true },
        undefined,
      );
    }
    assert.equal(err.mock.calls.length, 0, "no stderr while no context has answered");
    const lines = __test__.pendingDiagnostics();
    assert.equal(lines.filter((l) => DEAD_LINE.test(l)).length, 1);
    assert.equal(pi.attempts(), 1);
  });

  it("disarms the 1s status and widget timers after the first failure", () => {
    __test__.startWidgetRefresh();
    __test__.startStatusRefresh(failingPi("throw") as never);
    assert.deepEqual(__test__.channelTimersActive(), { status: true, widget: true });
    const err = mock.method(console, "error", () => {});
    try {
      __test__.sendMessageContained(
        failingPi("throw") as never,
        { customType: "subagent_result", content: "m", display: true },
        undefined,
      );
    } finally {
      err.mock.restore();
    }
    assert.deepEqual(__test__.channelTimersActive(), { status: false, widget: false });
  });

  it("routes diagnostics to the host UI notify channel, never stderr, when a UI exists", async () => {
    const notified: string[] = [];
    __test__.setUiContext({
      hasUI: true,
      ui: { notify: (text: string, severity?: string) => void notified.push(`${severity}:${text}`) },
    } as never);
    const err = mock.method(console, "error", () => {});
    __test__.sendMessageContained(
      failingPi("reject") as never,
      { customType: "subagent_result", content: "m", display: true },
      undefined,
    );
    await flushMicrotasks();
    assert.equal(err.mock.calls.length, 0);
    assert.equal(notified.filter((l) => DEAD_LINE.test(l)).length, 1);
    assert.ok(notified[0]!.startsWith("error:"), "severity is error");
  });

  it("a stale UI context whose hasUI read throws holds the diagnostic instead of escaping", async () => {
    // After a reload the old instance's watchers keep polling a torn-down
    // session: reading hasUI on the stale context throws (same shape as the
    // updateWidget guard). That throw must not turn a diagnostic into an
    // unhandled rejection the host prints over the input editor — and the
    // host TUI may still be alive, so the diagnostic is held for the next
    // context rather than raw-printed to stderr.
    __test__.setUiContext({
      get hasUI() {
        throw new Error("stale context");
      },
    } as never);
    const err = mock.method(console, "error", () => {});
    __test__.sendMessageContained(
      failingPi("reject") as never,
      { customType: "subagent_result", content: "m", display: true },
      undefined,
    );
    await flushMicrotasks();
    assert.equal(err.mock.calls.length, 0);
    assert.equal(
      __test__.pendingDiagnostics().filter((l) => DEAD_LINE.test(l)).length,
      1,
    );
  });
});

describe("deliverPendingQuestion rides the funnel", () => {
  beforeEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
  });
  afterEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
    mock.restoreAll();
  });

  it("one attempt per question; a dead channel costs one notice, not one per tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-flood-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      const pi = failingPi("reject");
      __test__.setLatestPi(pi as never);
      const running = {
        name: "w1",
        agent: "worker",
        sessionFile,
        startTime: Date.now(),
      } as unknown as Parameters<typeof __test__.deliverPendingQuestion>[0];
      const askFile = `${sessionFile}.ask`;

      const err = mock.method(console, "error", () => {});
      writeFileSync(askFile, JSON.stringify({ question: "q1" }));
      __test__.deliverPendingQuestion(running);
      await flushMicrotasks();
      // Second question on the now-dead channel: the raw send path would
      // attempt (and reject) again — one flood line per question.
      writeFileSync(askFile, JSON.stringify({ question: "q2" }));
      __test__.deliverPendingQuestion(running);
      await flushMicrotasks();

      assert.equal(err.mock.calls.length, 0);
      const lines = __test__.pendingDiagnostics();
      assert.equal(pi.attempts(), 1);
      assert.equal(lines.filter((l) => DEAD_LINE.test(l)).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
