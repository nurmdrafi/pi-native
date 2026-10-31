/**
 * Pane-creation self-heal (surface layer).
 *
 * Defect: every pane split targeted a fixed "from-pane" — the parent pane id
 * from the environment, or a cached pane id in the dedicated detached agents
 * session. Once that from-pane died (its window reaped, or the parent pane
 * replaced by a reload), every subsequent spawn and steer failed with
 * `can't find pane: %NN` until the extension process itself restarted.
 *
 * Fix: a split whose from-pane tmux reports as missing retries exactly once
 * against a live pane of the dedicated agents session, re-derived from live
 * tmux state (never the stale cache). Any other failure propagates unchanged.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  createSurface,
  createSurfaceSplit,
  pollForExit,
  __surfaceTest__,
} from "../../extensions/subagents/tmux.ts";

/** Fake tmux binary: records every invocation and answers from a script. */
function fakeTmux(opts: {
  /** split-window targets that fail with `can't find pane`. */
  deadTargets?: string[];
  /** Whether `has-session -t <agents-session>` succeeds. */
  hasSession?: boolean;
  /** Pane ids reported by `list-panes -t <agents-session>`. */
  sessionPanes?: string[];
  /** Pane ids handed out by successive successful split-window calls. */
  newPanes?: string[];
}) {
  const calls: string[][] = [];
  const attempts: { args: string[]; target: string | null }[] = [];
  const splits: string[] = [];
  const runner = (args: string[]): string => {
    calls.push(args);
    switch (args[0]) {
      case "has-session":
        if (!opts.hasSession) {
          throw Object.assign(new Error("tmux exited 1"), { code: 1 });
        }
        return "";
      case "new-session":
        return "";
      case "list-panes":
        return (opts.sessionPanes ?? ["%70"]).join("\n");
      case "split-window": {
        const tIdx = args.indexOf("-t");
        const target = tIdx >= 0 ? args[tIdx + 1] : null;
        if (target && (opts.deadTargets ?? []).includes(target)) {
          attempts.push({ args, target });
          throw Object.assign(new Error("tmux exited 1"), {
            code: 1,
            stderr: `can't find pane: ${target}\n`,
          });
        }
        const pane = opts.newPanes?.[splits.length] ?? `%${100 + splits.length}`;
        attempts.push({ args, target });
        splits.push(pane);
        return pane;
      }
      default:
        return "";
    }
  };
  return { calls, attempts, splits, runner };
}

function splitTarget(call: { target: string | null }): string | null {
  return call.target;
}

afterEach(() => {
  __surfaceTest__.setTmuxRunner(null);
  delete process.env.TMUX_PANE;
});

describe("isPaneNotFound", () => {
  it("matches tmux's can't-find-pane failure on stderr or message", () => {
    assert.equal(
      __surfaceTest__.isPaneNotFound(Object.assign(new Error("tmux exited 1"), { stderr: "can't find pane: %5\n" })),
      true,
    );
    assert.equal(__surfaceTest__.isPaneNotFound(new Error("error on line 0: can't find pane: %12")), true);
  });

  it("rejects unrelated failures", () => {
    assert.equal(__surfaceTest__.isPaneNotFound(Object.assign(new Error("tmux exited 1"), { stderr: "no server running\n" })), false);
    assert.equal(__surfaceTest__.isPaneNotFound(new Error("spawn tmux ENOENT")), false);
    assert.equal(__surfaceTest__.isPaneNotFound("not an error"), false);
  });
});

describe("createSurfaceSplit self-heal", () => {
  it("retries a dead from-pane once against a live agents-session pane", () => {
    const tmux = fakeTmux({ deadTargets: ["%5"], hasSession: true, sessionPanes: ["%70"] });
    __surfaceTest__.setTmuxRunner(tmux.runner);

    const pane = createSurfaceSplit("worker", "right", "%5");
    assert.equal(pane, "%100");
    assert.equal(tmux.splits.length, 1, "exactly one successful split");
    assert.equal(tmux.attempts.length, 2, "one attempt plus one retry");
    assert.equal(splitTarget(tmux.attempts[0]), "%5", "first split targets the dead from-pane");
    assert.equal(splitTarget(tmux.attempts[1]), "%70", "retry targets a live agents-session pane");
  });

  it("re-derives the fallback pane when the cached base pane itself is dead", () => {
    // The cache held %80; its window was reaped, so the whole session is gone.
    const tmux = fakeTmux({ deadTargets: ["%80"], hasSession: false, sessionPanes: ["%70"] });
    __surfaceTest__.setTmuxRunner(tmux.runner);
    // Seed the stale cache the way a previous successful spawn would have.
    assert.equal(createSurfaceSplit("worker", "right", "%80"), "%100");
    assert.equal(tmux.splits.length, 1);
    assert.equal(splitTarget(tmux.attempts[0]), "%80");
    assert.equal(splitTarget(tmux.attempts[1]), "%70");
    assert.ok(
      tmux.calls.some((c) => c[0] === "new-session"),
      "the gone agents session is recreated before the retry",
    );
  });

  it("propagates failures that are not a missing pane", () => {
    const calls: string[][] = [];
    __surfaceTest__.setTmuxRunner((args) => {
      calls.push(args);
      if (args[0] === "split-window") {
        throw Object.assign(new Error("tmux exited 1"), { code: 1, stderr: "no server running\n" });
      }
      return "";
    });
    assert.throws(() => createSurfaceSplit("worker", "right", "%5"));
    assert.equal(calls.filter((c) => c[0] === "split-window").length, 1, "no retry for unrelated errors");
  });

  it("propagates after one failed retry instead of looping", () => {
    const tmux = fakeTmux({ deadTargets: ["%5", "%70"], hasSession: true, sessionPanes: ["%70"] });
    __surfaceTest__.setTmuxRunner(tmux.runner);
    assert.throws(() => createSurfaceSplit("worker", "right", "%5"));
    assert.equal(tmux.splits.length, 0, "all split attempts failed");
    assert.equal(tmux.attempts.length, 2, "exactly one attempt plus one retry");
  });
});

describe("createSurface self-heal", () => {
  it("falls back to the agents session when the parent pane id is dead", () => {
    const tmux = fakeTmux({ deadTargets: ["%5"], hasSession: true, sessionPanes: ["%70"] });
    __surfaceTest__.setTmuxRunner(tmux.runner);
    process.env.TMUX_PANE = "%5";

    const pane = createSurface("worker");
    assert.equal(pane, "%100");
    assert.equal(splitTarget(tmux.attempts[0]), "%5", "parent pane tried first");
    assert.equal(splitTarget(tmux.attempts[1]), "%70", "agents session pane as fallback");
  });
});

describe("sentinel scrape anchoring (pollForExit)", () => {
  it("ignores the marker mid-sentence but still matches the standalone echo line", async () => {
    // A subagent whose TASK TEXT mentions the sentinel must not be declared
    // finished — only the echo, which prints the marker alone on its own
    // line, may complete the poll. Regression: the old match hit the marker
    // anywhere on screen, so live panes were reaped on a false positive.
    let screen = "the task says: echo `__SUBAGENT_DONE_0__` when finished\nrunning…\n";
    const poll = pollForExit("%100", new AbortController().signal, {
      interval: 5,
      deps: { readScreen: () => screen },
    } as never);

    const early = await Promise.race([
      poll,
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 60)),
    ]);
    assert.equal(early, "pending", "a marker inside prose is not completion");

    screen = "the task says: echo `__SUBAGENT_DONE_0__` when finished\n__SUBAGENT_DONE_0__\n";
    const result = await poll;
    assert.equal(result.reason, "sentinel");
    assert.equal(result.exitCode, 0);
  });
});
