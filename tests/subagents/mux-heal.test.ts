/**
 * Multiplexer-death heal (surface layer).
 *
 * Defect: the split heal matched exactly one failure string — `can't find
 * pane`. A dead or restarted multiplexer answers differently: `no server
 * running on <socket>`, `no such session`, or a `duplicate session` race
 * between two parallel first-spawns. Every one of those propagated raw out
 * of surface creation, so a server kill or reboot broke spawning until the
 * extension process restarted — the recurring "can't find pane"-family
 * outages that one-string retries never closed.
 *
 * Fix: surface creation treats multiplexer death as a first-class
 * recoverable state. The heal already re-derives its origin from live state
 * (base-pane cache reset, on-demand detached session) — it only needs to be
 * ENTERED for the death classes, while unrelated failures still propagate.
 * The matched strings are tmux's own, identical on macOS and Linux; only the
 * socket path varies, so it is matched by prefix, never parsed.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createSurface, createSurfaceSplit, __surfaceTest__ } from "../../extensions/subagents/tmux.ts";

function errWith(stderr: string): Error {
  return Object.assign(new Error(`Command failed: tmux split-window\n${stderr}`), {
    code: 1,
    stderr: `${stderr}\n`,
  });
}

/** Fake tmux answering from a script of failure classes, then success. */
function fakeTmux(opts: {
  /** stderr the first split-window fails with. */
  firstSplitFailure?: string;
  /** whether the on-demand agents session exists on the has-session probe. */
  hasSession?: boolean;
  /** fail the first new-session with duplicate-session (parallel race). */
  duplicateNewSession?: boolean;
}) {
  const calls: string[] = [];
  let newSessionCalls = 0;
  // Models the race: the session exists only AFTER the first new-session
  // attempt — before that, both probes see no session; after, the winner's
  // session is live, which is exactly what the duplicate re-probe must find.
  let sessionExists = false;
  const runner = (args: string[]): string => {
    calls.push(args[0]);
    switch (args[0]) {
      case "has-session": {
        if (opts.hasSession || sessionExists) return "";
        throw Object.assign(new Error("tmux exited 1"), { code: 1 });
      }
      case "new-session": {
        newSessionCalls += 1;
        if (opts.duplicateNewSession && newSessionCalls === 1) {
          sessionExists = true;
          throw Object.assign(
            new Error("Command failed: tmux new-session\nduplicate session: pi-agents"),
            { code: 1, stderr: "duplicate session: pi-agents\n" },
          );
        }
        sessionExists = true;
        return "";
      }
      case "list-panes":
        return "%70";
      case "split-window": {
        const tIdx = args.indexOf("-t");
        const target = tIdx >= 0 ? args[tIdx + 1] : null;
        if (opts.firstSplitFailure && calls.filter((c) => c === "split-window").length === 1) {
          throw errWith(opts.firstSplitFailure);
        }
        void target;
        return "%42";
      }
      default:
        return "";
    }
  };
  return { runner, calls };
}

afterEach(() => {
  __surfaceTest__.setTmuxRunner(null);
  delete process.env.TMUX_PANE;
});

describe("multiplexer-death heal", () => {
  it("recovers when the server is gone (no server running)", () => {
    const fake = fakeTmux({ firstSplitFailure: "no server running on /tmp/tmux-1000/default" });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const pane = createSurface("worker");
    assert.equal(pane, "%42", "split heals past a dead server");
    assert.ok(fake.calls.includes("new-session"), "detached session recreated on demand");
  });

  it("recovers when the agents session is gone (no such session)", () => {
    const fake = fakeTmux({ firstSplitFailure: "can't find session: pi-agents" });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const pane = createSurfaceSplit("worker", "right", "%70");
    assert.equal(pane, "%42", "split heals past a dead session");
  });

  it("recovers when two parallel first-spawns race the session creation", () => {
    const fake = fakeTmux({ duplicateNewSession: true });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const pane = createSurface("worker");
    assert.equal(pane, "%42", "duplicate-session race resolves, not crashes");
    const news = fake.calls.filter((c) => c === "new-session").length;
    const hases = fake.calls.filter((c) => c === "has-session").length;
    assert.ok(news >= 1 && hases >= 2, "re-checks existence before treating duplicate as fatal");
  });

  it("still propagates unrelated failures unchanged", () => {
    const fake = fakeTmux({ firstSplitFailure: "unknown command" });
    __surfaceTest__.setTmuxRunner(fake.runner);

    assert.throws(() => createSurface("worker"), /unknown command/);
  });
});
