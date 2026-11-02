/**
 * tmux error classification and recovery.
 *
 * Defects under test (from the tmux-hardening effort):
 * - only two ad-hoc regexes classified tmux failures, so `can't find window`,
 *   `can't find client`, `server exited unexpectedly`, `lost server`,
 *   `server version is too old for client`, `no space for a new pane`,
 *   `create pane failed` and `pane too small` were all fatal or misrouted;
 * - a split refused for geometry (`no space for a new pane`) never retried
 *   after growing the dedicated session's window;
 * - a split refused in the parent's own pane tried to heal by re-splitting
 *   the same cramped window instead of moving to the dedicated session;
 * - kill-pane on an already-reaped pane surfaced an error instead of being
 *   the idempotent success tmux semantics make it;
 * - `duplicate session` was raced around, not prevented, by `new-session`.
 *
 * Contract under test:
 * - classifyTmuxError maps verbatim tmux wordings (macOS and Linux alike) to
 *   pane-gone / server-gone / size / duplicate-race / unknown, from either
 *   an error's stderr property or its message;
 * - isPaneNotFound stays true for pane/window/client loss, false for
 *   session loss; isMuxRecoverableError covers pane-gone + server-gone +
 *   duplicate-race, never size;
 * - ensureAgentsSessionPane creates the session with `new-session -A -d`
 *   (attach-if-exists, killing the parallel first-spawn duplicate race);
 * - a size-refused split in the dedicated session grows the window
 *   (window-size manual + resize-window) and retries the split once;
 * - a size-refused split in the parent's pane never resizes the user's
 *   window — it falls back to the dedicated session;
 * - at the largest supported window size a still-refused split fails with
 *   an explicit capacity error naming the limit;
 * - closeSurface treats pane-gone as success (idempotent close);
 * - sendLongCommand retries a size-refused respawn once after growing.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  __surfaceTest__,
  classifyTmuxError,
  closeSurface,
  createSurfaceRunning,
  isPaneNotFound,
  isMuxRecoverableError,
  pollForExit,
  reapDeadAgentPanes,
  sendLongCommand,
} from "../../extensions/subagents/tmux.ts";

delete process.env.TMUX_PANE;

function tmuxFail(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error(`Command failed: tmux\n${stderr}`), { stderr }) as Error & {
    stderr: string;
  };
}

describe("classifyTmuxError — verbatim wordings", () => {
  const cases: Array<[string, string]> = [
    ["can't find pane: %12", "pane-gone"],
    ["can't find window: 1", "pane-gone"],
    ["can't find client: %2", "pane-gone"],
    ["no such pane", "pane-gone"],
    ["no server running on /tmp/tmux-1000/default", "server-gone"],
    ["error connecting to /tmp/tmux-1000/default (No such file or directory)", "server-gone"],
    ["server exited unexpectedly", "server-gone"],
    ["lost server", "server-gone"],
    ["protocol version mismatch (client 8, server 7)", "server-gone"],
    ["server version is too old for client", "server-gone"],
    ["no space for a new pane", "size"],
    ["no space for new pane", "size"],
    ["create pane failed: layout", "size"],
    ["pane too small", "size"],
    ["size is too big or too small", "size"],
    ["change is too big or too small", "size"],
    ["size too small or too big", "size"],
    ["duplicate session: pi-agents", "duplicate-race"],
    ["can't find session: pi-agents", "pane-gone"],
    ["no such session: pi-agents", "pane-gone"],
  ];
  for (const [stderr, expected] of cases) {
    it(`stderr "${stderr}" -> ${expected}`, () => {
      assert.equal(classifyTmuxError(tmuxFail(stderr)), expected);
    });
    it(`message "${stderr}" -> ${expected}`, () => {
      assert.equal(classifyTmuxError(new Error(stderr)), expected);
    });
  }
  it("unrelated error -> unknown", () => {
    assert.equal(classifyTmuxError(new Error("write EPIPE")), "unknown");
    assert.equal(classifyTmuxError("not an error object"), "unknown");
  });
});

describe("legacy classifier wrappers", () => {
  it("isPaneNotFound: pane/window/client yes, session no", () => {
    assert.equal(isPaneNotFound(tmuxFail("can't find pane: %1")), true);
    assert.equal(isPaneNotFound(tmuxFail("can't find window: 2")), true);
    assert.equal(isPaneNotFound(tmuxFail("can't find client: x")), true);
    assert.equal(isPaneNotFound(tmuxFail("can't find session: pi-agents")), false);
    assert.equal(isPaneNotFound(tmuxFail("no space for a new pane")), false);
  });
  it("isMuxRecoverableError: pane/server/race yes, size never", () => {
    assert.equal(isMuxRecoverableError(tmuxFail("can't find pane: %1")), true);
    assert.equal(isMuxRecoverableError(tmuxFail("no server running on /tmp/tmux-1000/default")), true);
    assert.equal(isMuxRecoverableError(tmuxFail("server exited unexpectedly")), true);
    assert.equal(isMuxRecoverableError(tmuxFail("server version is too old for client")), true);
    assert.equal(isMuxRecoverableError(tmuxFail("duplicate session: pi-agents")), true);
    assert.equal(isMuxRecoverableError(tmuxFail("no space for a new pane")), false);
    assert.equal(isMuxRecoverableError(tmuxFail("pane too small")), false);
  });
});

/** Stateful fake tmux: routes by argv shape, lets a test inject one-time
 *  failures for split-window / respawn-pane / kill-pane. */
function fakeTmux(overrides: {
  windowSize?: string;
  windowIds?: Record<string, string>;
  panes?: string;
  onSplit?: () => Error;
  onSplitN?: number;
  onRespawn?: () => Error;
  onKill?: () => Error;
}) {
  const calls: string[][] = [];
  let splitFailures = overrides.onSplitN ?? 0;
  let respawnFailed = false;
  let killFailed = false;
  const runner = (args: string[]): string => {
    calls.push(args);
    const argv = args.join(" ");
    if (argv.startsWith("has-session")) throw tmuxFail("no such session: pi-agents-test");
    if (argv.startsWith("new-session")) return "";
    if (args[0] === "list-panes" && !args.includes("-a")) {
      if (argv.includes("#{pane_created}")) return overrides.panes ?? "%1 500\n";
      return "%1\n";
    }
    if (argv.startsWith("split-window")) {
      if (overrides.onSplit && splitFailures > 0) {
        splitFailures--;
        throw overrides.onSplit();
      }
      return "%9";
    }
    if (argv.startsWith("display-message")) {
      const target = args[args.indexOf("-t") + 1] ?? "";
      if (argv.includes("#{window_id}")) return overrides.windowIds?.[target] ?? "@1";
      return overrides.windowSize ?? "220x55";
    }
    if (argv.startsWith("respawn-pane")) {
      if (overrides.onRespawn && !respawnFailed) {
        respawnFailed = true;
        throw overrides.onRespawn();
      }
      return "";
    }
    if (argv.startsWith("kill-pane")) {
      if (overrides.onKill && !killFailed) {
        killFailed = true;
        throw overrides.onKill();
      }
      return "";
    }
    return "";
  };
  return { calls, argv: () => calls.map((c) => c.join(" ")), runner };
}

describe("session creation kills the duplicate race", () => {
  beforeEach(() => __surfaceTest__.setTmuxRunner(fakeTmux({}).runner));
  afterEach(() => __surfaceTest__.setTmuxRunner(null));

  it("new-session runs without -A (no detached-attach watcher detach)", () => {
    const fx = fakeTmux({});
    __surfaceTest__.setTmuxRunner(fx.runner);
    createSurfaceRunning("w", "true", "pi-agents-test");
    const ns = fx.argv().find((a) => a.startsWith("new-session"));
    assert.ok(ns, "new-session issued");
    assert.doesNotMatch(ns ?? "", /(^| )-A( |$)/);
  });

  it("duplicate session from the race loses once, then re-probe proceeds", () => {
    let raced = false;
    let probed = 0;
    const runner = (args: string[]): string => {
      const argv = args.join(" ");
      if (argv.startsWith("has-session")) {
        probed++;
        if (probed === 1) throw tmuxFail("no such session: pi-agents-test");
        return "";
      }
      if (argv.startsWith("new-session")) {
        if (!raced) {
          raced = true;
          throw tmuxFail("duplicate session: pi-agents-test");
        }
        return "";
      }
      if (args[0] === "list-panes" && !args.includes("-a")) return "%1\n";
      if (args[0] === "split-window") return "%9";
      return "";
    };
    __surfaceTest__.setTmuxRunner(runner);
    const pane = createSurfaceRunning("w", "true", "pi-agents-test");
    assert.equal(pane, "%9");
    assert.ok(raced, "the race fired exactly once");
  });
});

describe("size-refused split: grow window, retry once (dedicated session)", () => {
  beforeEach(() => __surfaceTest__.setTmuxRunner(fakeTmux({}).runner));
  afterEach(() => __surfaceTest__.setTmuxRunner(null));

  it("grows via window-size manual + resize-window, then retries the split", () => {
    const fx = fakeTmux({
      windowSize: "220x55",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const pane = createSurfaceRunning("w", "true", "pi-agents-test");
    assert.equal(pane, "%9");
    const argv = fx.argv();
    const manual = argv.find((a) => a.startsWith("set-option") && a.includes("window-size manual"));
    assert.ok(manual, "window-size manual set");
    const resize = argv.find((a) => a.startsWith("resize-window"));
    assert.ok(resize, "resize-window issued");
    assert.match(resize, /-x 280 -y 70/);
    assert.equal(argv.filter((a) => a.startsWith("split-window")).length, 2, "split retried once");
  });

  it("at max window size the failure names the capacity limit", () => {
    const fx = fakeTmux({
      windowSize: "480x120",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    assert.throws(
      () => createSurfaceRunning("w", "true", "pi-agents-test"),
      /capacity|480x120/i,
    );
    assert.equal(fx.argv().filter((a) => a.startsWith("split-window")).length, 1, "no blind retry");
  });

  it("a window larger than the ladder is never shrunk - capacity error names it", () => {
    const fx = fakeTmux({
      windowSize: "600x300",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    assert.throws(
      () => createSurfaceRunning("w", "true", "pi-agents-test"),
      /capacity|600x300/i,
    );
    assert.ok(!fx.argv().some((a) => a.startsWith("resize-window")), "no resize-window issued");
    assert.equal(fx.argv().filter((a) => a.startsWith("split-window")).length, 1, "no blind retry");
  });

  it("unparseable window size: window-size manual only, split retried un-grown", () => {
    const fx = fakeTmux({
      windowSize: "not-a-size",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const pane = createSurfaceRunning("w", "true", "pi-agents-test");
    assert.equal(pane, "%9");
    const argv = fx.argv();
    assert.ok(!argv.some((a) => a.startsWith("resize-window")), "no resize-window issued");
    assert.equal(argv.filter((a) => a.startsWith("split-window")).length, 2, "split retried once");
  });
});

describe("size-refused split from the parent's pane: redirect, never resize", () => {
  beforeEach(() => {
    process.env.TMUX_PANE = "%0";
    __surfaceTest__.setTmuxRunner(fakeTmux({}).runner);
  });
  afterEach(() => {
    delete process.env.TMUX_PANE;
    __surfaceTest__.setTmuxRunner(null);
  });

  it("falls back to the dedicated session without resizing the parent window", () => {
    const fx = fakeTmux({
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const pane = createSurfaceRunning("w", "true", "pi-agents-test");
    assert.equal(pane, "%9");
    const argv = fx.argv();
    const splits = argv.filter((a) => a.startsWith("split-window"));
    assert.ok(splits[0].includes("-t %0"), "first split targets parent pane");
    assert.ok(!splits[1].includes("-t %0"), "retry does not target parent pane");
    const resize = argv.find((a) => a.startsWith("resize-window"));
    assert.ok(resize, "dedicated window grown instead");
    assert.ok(!resize.includes("-t %0"), "resize does not target the parent pane");
  });
});

describe("closeSurface is idempotent", () => {
  beforeEach(() => __surfaceTest__.setTmuxRunner(fakeTmux({}).runner));
  afterEach(() => __surfaceTest__.setTmuxRunner(null));

  it("kill-pane refused with can't find pane is a silent success", () => {
    const fx = fakeTmux({ onKill: () => tmuxFail("can't find pane: %9") });
    __surfaceTest__.setTmuxRunner(fx.runner);
    closeSurface("%9"); // must not throw
    assert.ok(fx.argv().some((a) => a.startsWith("kill-pane")));
  });
});

describe("sendLongCommand retries a size-refused respawn after growing", () => {
  it("pane too small once -> grow window, respawn again", () => {
    const fx = fakeTmux({ onRespawn: () => tmuxFail("pane too small") });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const dir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
    try {
      sendLongCommand("%9", "true", { scriptPath: join(dir, "cmd.sh") });
      const argv = fx.argv();
      assert.equal(argv.filter((a) => a.startsWith("respawn-pane")).length, 2, "respawn retried");
      assert.ok(argv.some((a) => a.startsWith("resize-window")), "window grown before retry");
    } finally {
      __surfaceTest__.setTmuxRunner(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sendLongCommand never grows the user's window", () => {
  beforeEach(() => {
    process.env.TMUX_PANE = "%0";
    __surfaceTest__.setTmuxRunner(fakeTmux({}).runner);
  });
  afterEach(() => {
    delete process.env.TMUX_PANE;
    __surfaceTest__.setTmuxRunner(null);
  });

  it("size-refused respawn in the parent's window -> clear error, no resize", () => {
    const fx = fakeTmux({ onRespawn: () => tmuxFail("pane too small") });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const dir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
    try {
      assert.throws(
        () => sendLongCommand("%9", "true", { scriptPath: join(dir, "cmd.sh") }),
        /enlarge/,
      );
      assert.ok(!fx.argv().some((a) => a.startsWith("resize-window")), "no resize-window issued");
      assert.equal(fx.argv().filter((a) => a.startsWith("respawn-pane")).length, 1, "no blind retry");
    } finally {
      delete process.env.TMUX_PANE;
      __surfaceTest__.setTmuxRunner(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("poll reports dead panes with their true exit status", () => {
  it("Pane is dead + status 127 -> gone with not-found message", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const result = await pollForExit("%9", ac.signal, {
      interval: 10,
      deps: {
        readScreen: async () => "Pane is dead",
        paneDeadState: async () => ({ dead: true, status: 127 }),
      },
    });
    assert.equal(result.reason, "gone");
    assert.equal(result.exitCode, 127);
    assert.match(result.errorMessage ?? "", /127/);
  });

  it("live screen keeps polling (no dead-state call)", async () => {
    const ac = new AbortController();
    let deadCalls = 0;
    let ticks = 0;
    const poll = pollForExit("%9", ac.signal, {
      interval: 5,
      deps: {
        readScreen: async () => "working...",
        paneDeadState: async () => {
          deadCalls++;
          return null;
        },
      },
      onTick: () => {
        ticks++;
        if (ticks >= 2) ac.abort();
      },
    });
    await assert.rejects(poll, /Aborted/);
    assert.equal(deadCalls, 0, "dead state only queried for dead screens");
  });
});


describe("sendLongCommand window identity decides grow vs enlarge", () => {
  it("pane in a different window than the parent grows that window", () => {
    process.env.TMUX_PANE = "%0";
    const fx = fakeTmux({
      onRespawn: () => tmuxFail("pane too small"),
      windowIds: { "%0": "@2", "%9": "@1" },
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const dir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
    try {
      sendLongCommand("%9", "true", { scriptPath: join(dir, "cmd.sh") });
      const argv = fx.argv();
      assert.equal(argv.filter((a) => a.startsWith("respawn-pane")).length, 2);
      assert.ok(argv.some((a) => a.startsWith("resize-window")), "grew the pane's own window");
    } finally {
      delete process.env.TMUX_PANE;
      __surfaceTest__.setTmuxRunner(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pane sharing the parent's window asks the user to enlarge", () => {
    process.env.TMUX_PANE = "%0";
    const fx = fakeTmux({
      onRespawn: () => tmuxFail("pane too small"),
      windowIds: { "%0": "@1", "%9": "@1" },
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const dir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
    try {
      assert.throws(
        () => sendLongCommand("%9", "true", { scriptPath: join(dir, "cmd.sh") }),
        /enlarge/,
      );
      assert.ok(!fx.argv().some((a) => a.startsWith("resize-window")), "no resize of user window");
    } finally {
      delete process.env.TMUX_PANE;
      __surfaceTest__.setTmuxRunner(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reapDeadAgentPanes cleans agents sessions only", () => {
  it("kills dead panes in pi-agents sessions, leaves everything else", () => {
    const calls: string[] = [];
    const runner = (args: string[]): string => {
      calls.push(args.join(" "));
      if (args[0] === "list-panes" && args.includes("-a")) {
        return "%1 1 pi-agents-proj-abcd12\n%2 0 pi-agents-proj-abcd12\n%3 1 other-session\n";
      }
      return "";
    };
    __surfaceTest__.setTmuxRunner(runner);
    try {
      reapDeadAgentPanes();
      const kills = calls.filter((c) => c.startsWith("kill-pane"));
      assert.deepEqual(kills, ["kill-pane -t %1"]);
    } finally {
      __surfaceTest__.setTmuxRunner(null);
    }
  });
});


describe("capacity eviction: kill oldest pane when growth cannot help", () => {
  beforeEach(() => __surfaceTest__.setTmuxRunner(fakeTmux({}).runner));
  afterEach(() => __surfaceTest__.setTmuxRunner(null));

  it("at max size, evicts the oldest non-base pane and retries the split", () => {
    const fx = fakeTmux({
      windowSize: "480x120",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
      panes: "%1 500\n%5 100\n%6 200\n",
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    const pane = createSurfaceRunning("w", "true", "pi-agents-test");
    assert.equal(pane, "%9");
    const argv = fx.argv();
    const kills = argv.filter((a) => a.startsWith("kill-pane"));
    assert.deepEqual(kills, ["kill-pane -t %5"], "oldest non-base pane evicted");
    assert.equal(argv.filter((a) => a.startsWith("split-window")).length, 2, "split retried once");
  });

  it("only the base pane left: capacity error propagates, nothing killed", () => {
    const fx = fakeTmux({
      windowSize: "480x120",
      onSplit: () => tmuxFail("no space for a new pane"),
      onSplitN: 1,
      panes: "%1 500\n",
    });
    __surfaceTest__.setTmuxRunner(fx.runner);
    assert.throws(() => createSurfaceRunning("w", "true", "pi-agents-test"), /capacity/);
    assert.ok(!fx.argv().some((a) => a.startsWith("kill-pane")), "base pane never evicted");
  });
});
