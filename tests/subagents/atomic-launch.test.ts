/**
 * Atomic pane launch and push-style completion.
 *
 * Defect 1 (pane race): launch created a pane with split-window (running the
 * user's default shell), slept a fixed shell-ready delay, then delivered the
 * launch script by `respawn-pane -k` against the pane id the split returned.
 * The pane only existed as a live shell between those steps: when that shell
 * exited (fast-exit shell config, window reap, server restart, reload
 * staleness) the respawn hit a dead pane and spawn failed with
 * `can't find pane: %N`. Heal-retries re-ran the same racy sequence.
 *
 * Fix 1: the pane is born running the launch script — one atomic
 * split-window whose command is `bash <script>; exec $SHELL`. No default
 * shell window, no respawn, no shell-ready sleep.
 *
 * Defect 2 (wake latency): completion was detected by a 1s poll scraping the
 * pane screen for the sentinel echo; a clean pi exit was invisible until the
 * next tick, and a child-side crash of the scrape path left only the poll.
 *
 * Fix 2: the sentinel echo is followed by `tmux wait-for -S <channel>`, the
 * child writes a clean-exit `.exit` sidecar on agent_end, and the watcher
 * blocks on `tmux wait-for <channel>` between ticks — wake becomes
 * push-driven, the sidecar makes clean exits scrape-independent.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __surfaceTest__, __pollForExitTest__, createSurfaceRunning } from "../../extensions/subagents/tmux.ts";
import { registerName, writeSubagentLoadout } from "../../extensions/subagents/session.ts";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
const subagentsExtension = subagentsModule.default;
const { pollForExit } = await import("../../extensions/subagents/tmux.ts");

function paneNotFoundErr(target: string): Error {
  return Object.assign(
    new Error(`Command failed: tmux respawn-pane -k -t ${target}\ncan't find pane: ${target}`),
    { code: 1, stderr: `can't find pane: ${target}\n` },
  );
}

/** Fake tmux: records calls; splits hand out panes; respawns fail per config. */
function fakeTmux(opts: {
  splitPanes?: string[];
  failAllRespawns?: boolean;
  failAllSplits?: boolean;
}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const splits: string[] = [];
  const runner = (args: string[]): string => {
    calls.push({ cmd: args[0], args });
    switch (args[0]) {
      case "has-session":
        throw Object.assign(new Error("tmux exited 1"), { code: 1 });
      case "new-session":
        return "";
      case "list-panes":
        return "%70";
      case "split-window": {
        if (opts.failAllSplits) throw paneNotFoundErr(args.join(" "));
        const pane = opts.splitPanes?.[splits.length] ?? `%${100 + splits.length}`;
        splits.push(pane);
        return pane;
      }
      case "respawn-pane": {
        const tIdx = args.indexOf("-t");
        const target = tIdx >= 0 ? args[tIdx + 1] : "?";
        if (opts.failAllRespawns) throw paneNotFoundErr(target);
        return "";
      }
      default:
        return "";
    }
  };
  return {
    runner,
    calls,
    splits,
    of: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  };
}

function freshRoot(agentName?: string): { agentDir: string; projectDir: string; ctx: unknown } {
  const root = mkdtempSync(join(tmpdir(), "atomic-launch-"));
  const agentDir = join(root, "agent-home");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  if (agentName) {
    const agentsDir = join(agentDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, `${agentName}.md`),
      `---\nname: ${agentName}\ntools: piread\n---\n\nBody.\n`,
      "utf8",
    );
  }
  const ctx = {
    cwd: projectDir,
    sessionManager: {
      getSessionFile: () => join(projectDir, "parent.jsonl"),
      getSessionId: () => "parent-sid",
      getSessionDir: () => projectDir,
    },
  };
  return { agentDir, projectDir, ctx };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "1";
  delete process.env.PI_SUBAGENT_ALLOWED;
  delete process.env.PI_SUBAGENT_AGENT;
});

afterEach(() => {
  __surfaceTest__.setTmuxRunner(null);
  __test__.runningSubagents.clear();
  mock.timers.reset();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── fix 1: atomic launch ──

describe("atomic pane launch", () => {
  it("succeeds when every respawn-pane fails: the pane race cannot occur", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Simulates the exact production defect: the pane split-window created
    // dies before respawn-pane targets it. With atomic creation the launch
    // must never call respawn-pane at all.
    const fake = fakeTmux({ splitPanes: ["%100"], failAllRespawns: true });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const running = await __test__.launchSubagent(
      { agent: "worker", task: "atomic launch", name: "racer" } as never,
      ctx as never,
    );

    assert.ok(running, "launch succeeds despite respawn-pane being unusable");
    assert.equal(running.surface, "%100");
    assert.equal(fake.of("respawn-pane").length, 0, "launch never respawns a pane");
    const splits = fake.of("split-window");
    assert.equal(splits.length, 1, "exactly one split-window");
    const cmdArg = splits[0].args.at(-1) ?? "";
    assert.match(cmdArg, /bash .+\.sh/, "the split runs the launch script itself");
  });

  it("does not wait out the shell-ready delay before launching", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "90000";

    const fake = fakeTmux({ splitPanes: ["%100"] });
    __surfaceTest__.setTmuxRunner(fake.runner);

    mock.timers.enable({ apis: ["setTimeout"] });

    let settled = false;
    const launched = __test__
      .launchSubagent({ agent: "worker", task: "no sleep", name: "swift" } as never, ctx as never)
      .then((r: unknown) => {
        settled = true;
        return r;
      })
      .catch((e: unknown) => {
        settled = true;
        throw e;
      });

    // Drain microtasks + real macrotasks. A launch that parks on the mocked
    // shell-ready setTimeout cannot settle here; one with no timer does.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(settled, "launch resolves without waiting on the shell-ready delay");
    mock.timers.reset();
    await launched;
  });

  it("heals a dead split origin while creating the pane atomically", () => {
    const { agentDir } = freshRoot("worker");
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.TMUX_PANE;

    let splitCalls = 0;
    const runner = (args: string[]): string => {
      switch (args[0]) {
        case "has-session":
          return "";
        case "new-session":
          return "";
        case "list-panes":
          return "%70";
        case "split-window": {
          splitCalls += 1;
          const tIdx = args.indexOf("-t");
          const target = tIdx >= 0 ? args[tIdx + 1] : null;
          if (splitCalls === 1 && target && target.startsWith("%")) {
            // First split targets the stale cached base pane.
            throw Object.assign(new Error("tmux exited 1"), {
              code: 1,
              stderr: `can't find pane: ${target}\n`,
            });
          }
          return `%${100 + splitCalls}`;
        }
        default:
          return "";
      }
    };
    __surfaceTest__.setTmuxRunner(runner);

    const pane = createSurfaceRunning("worker", "bash /tmp/x.sh");
    assert.match(pane, /^%\d+$/, "returns the healed pane id");
  });
});

// ── fix 2: push-style completion ──

describe("push-style completion signal", () => {
  it("the launch script's final command signals a tmux wait-for channel", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fake = fakeTmux({ splitPanes: ["%100"] });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const running = await __test__.launchSubagent(
      { agent: "worker", task: "wait-for signal", name: "signaler" } as never,
      ctx as never,
    );
    const splits = fake.of("split-window");
    const cmdArg = splits[0]?.args.at(-1) ?? "";
    assert.match(cmdArg, /tmux wait-for -S pi-subagent-/, "sentinel signals the wake channel");
    assert.match(cmdArg, new RegExp(`pi-subagent-${running.id}`), "channel is unique per subagent");
  });

  it("pollForExit wakes on the wait-for channel instead of the interval", async () => {
    const root = mkdtempSync(join(tmpdir(), "poll-wait-"));
    const sessionFile = join(root, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n", "utf8");

    const signals = new Set<string>();
    const screenFn = mock.fn(() => "running…");
    const waitFn = mock.fn(async (args: string[]) => {
      const chan = args[args.length - 1];
      // Block until the channel is signaled; -S callers record and never block.
      if (args.includes("-S")) {
        signals.add(chan);
        return "";
      }
      while (!signals.has(chan)) await new Promise((r) => setTimeout(r, 5));
      return "";
    });

    const pollPromise = pollForExit("%100", new AbortController().signal, {
      interval: 60000,
      sessionFile,
      waitChannel: "pi-subagent-test1",
      deps: { readScreen: () => screenFn(), waitTmux: waitFn },
    } as never);

    // Let the watcher park on wait-for, then signal completion via the
    // sidecar the child writes on clean exit.
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", exitCode: 0 }), "utf8");
    await waitFn(["wait-for", "-S", "pi-subagent-test1"]);

    const result = await Promise.race([
      pollPromise,
      new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), 3000)),
    ]);
    assert.ok(!("timeout" in result), "woke without waiting out the 60s interval");
    assert.deepEqual(
      { reason: result.reason, exitCode: result.exitCode },
      { reason: "done", exitCode: 0 },
    );
  });

  it("falls back to sentinel scraping when wait-for is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "poll-fallback-"));
    const sessionFile = join(root, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n", "utf8");

    let screen = "";
    const waitFn = mock.fn(async () => {
      throw new Error("no server running");
    });
    const screenFn = mock.fn(() => screen);

    const pollPromise = pollForExit("%100", new AbortController().signal, {
      interval: 10,
      sessionFile,
      waitChannel: "pi-subagent-test2",
      deps: { readScreen: () => screenFn(), waitTmux: waitFn },
    } as never);

    await new Promise((r) => setTimeout(r, 25));
    screen = "__SUBAGENT_DONE_0__";
    const result = await Promise.race([
      pollPromise,
      new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), 3000)),
    ]);
    assert.ok(!("timeout" in result), "fallback poll still detects the sentinel");
    assert.equal(result.reason, "sentinel");
    assert.equal(result.exitCode, 0);
  });
});

// ── fix 3: clean-exit sidecar ──

describe("clean-exit sidecar", () => {
  it("child writes a done .exit sidecar on clean agent_end auto-exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "done-sidecar-"));
    const sessionFile = join(root, "child.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "child-sid", cwd: root }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    savedEnv.PI_SUBAGENT_SESSION = process.env.PI_SUBAGENT_SESSION;
    savedEnv.PI_SUBAGENT_AUTO_EXIT = process.env.PI_SUBAGENT_AUTO_EXIT;
    savedEnv.PI_SUBAGENT_TASK = process.env.PI_SUBAGENT_TASK;
    savedEnv.PI_SUBAGENT_ID = process.env.PI_SUBAGENT_ID;
    savedEnv.PI_SUBAGENT_ACTIVITY_FILE = process.env.PI_SUBAGENT_ACTIVITY_FILE;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_TASK = "sidecar test";
    process.env.PI_SUBAGENT_ID = "test1234";
    process.env.PI_SUBAGENT_ACTIVITY_FILE = join(root, "activity.json");
    // Keep this child's durable self-report out of the real repo inbox.
    savedEnv.PI_SUBAGENT_INBOX = process.env.PI_SUBAGENT_INBOX;
    process.env.PI_SUBAGENT_INBOX = join(root, "subagent-inbox.jsonl");

    const handlers: Record<string, Function[]> = {};
    const fakePi = {
      on: (event: string, fn: Function) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(fn);
      },
      registerShortcut: () => {},
      registerCommand: () => {},
      registerTool: () => {},
    };
    const subagentDone = (await import("../../extensions/subagents/subagent-done.ts")).default;
    subagentDone(fakePi as never);

    const fired = { shutdown: false };
    handlers["agent_end"][0](
      { messages: [{}, {}] },
      { shutdown: () => (fired.shutdown = true) },
    );

    assert.ok(fired.shutdown, "auto-exit still shuts the child down");
    const exitPath = `${sessionFile}.exit`;
    assert.ok(existsSync(exitPath), "clean exit writes the .exit sidecar");
    const payload = JSON.parse(readFileSync(exitPath, "utf8"));
    assert.equal(payload.type, "done");
    assert.equal(payload.exitCode, 0);
  });
});
