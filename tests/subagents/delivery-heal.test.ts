/**
 * Launch-delivery self-heal (spawn + resume flows).
 *
 * Defect: creating a subagent pane self-heals a dead split origin, but the
 * very next step — delivering the launch script with `tmux respawn-pane`
 * against the pane id the split just returned — had no recovery of its own.
 * A pane that died inside the shell-settling window between split and
 * respawn made spawn re-throw the raw `Command failed: tmux respawn-pane
 * ... can't find pane: %N` error, and resume throw it out of an execute
 * body with no catch at all.
 *
 * Fix: all three delivery sites (spawn claude, spawn pi, resume) share one
 * heal — on a pane-not-found failure the surface is re-created (createSurface
 * re-derives a live split origin) and the script is delivered once to the
 * replacement pane. A final failure throws a contextual error, the spawn
 * execute wraps whatever still escapes, and the resume execute converts
 * unexpected throws into actionable { error } results.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";
import { registerName, writeSubagentLoadout } from "../../extensions/subagents/session.ts";

// The spawn allowlist is captured when the extension module loads; scrub it
// BEFORE importing the extension so these fixtures are not gated by whatever
// allowlist the environment running this suite inherited.
delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
const subagentsExtension = subagentsModule.default;

// ── tmux error shapes, as the real binary reports them ──

function paneNotFoundErr(target: string): Error {
  // Mirrors real execFileSync errors: stderr is appended to the message.
  return Object.assign(
    new Error(`Command failed: tmux respawn-pane -k -t ${target}\ncan't find pane: ${target}`),
    { code: 1, stderr: `can't find pane: ${target}\n` },
  );
}

function noServerErr(cmd: string): Error {
  return Object.assign(new Error(`Command failed: tmux ${cmd}\nno server running`), {
    code: 1,
    stderr: "no server running\n",
  });
}

function targetOf(args: string[]): string | null {
  const i = args.indexOf("-t");
  return i >= 0 ? args[i + 1] : null;
}

/** Fake tmux: hands out successive split panes; fails respawns per target. */
function fakeTmux(opts: {
  splitPanes?: string[];
  /** Fail every split-window from the Nth call on (0-based) with this error. */
  failSplitFrom?: number;
  failSplitWith?: Error;
  /** respawn-pane targets that fail, first occurrence each. */
  failRespawnOn?: string[];
  /** Fail EVERY respawn-pane (final-failure paths). */
  failAllRespawns?: boolean;
  respawnErr?: (target: string) => Error;
}) {
  const calls: { cmd: string; target: string | null }[] = [];
  let splits = 0;
  const runner = (args: string[]): string => {
    const target = targetOf(args);
    calls.push({ cmd: args[0], target });
    switch (args[0]) {
      case "has-session":
        throw Object.assign(new Error("tmux exited 1"), { code: 1 });
      case "new-session":
        return "";
      case "list-panes":
        return "%70";
      case "split-window":
        if (opts.failSplitFrom !== undefined && splits >= opts.failSplitFrom) {
          throw opts.failSplitWith ?? noServerErr("split-window");
        }
        {
          const pane = opts.splitPanes?.[splits] ?? `%${100 + splits}`;
          splits += 1;
          return pane;
        }
      case "respawn-pane":
        if (target && (opts.failAllRespawns || (opts.failRespawnOn ?? []).includes(target))) {
          throw (opts.respawnErr ?? paneNotFoundErr)(target);
        }
        return "";
      default:
        return "";
    }
  };
  const targets = (cmd: string): (string | null)[] =>
    calls.filter((c) => c.cmd === cmd).map((c) => c.target);
  return { runner, calls, targets };
}

// ── fixtures ──

function writeAgentFile(agentsDir: string, name: string, frontmatter: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\nBody.\n`, "utf8");
}

function writeSessionFixture(dir: string, name: string): string {
  const file = join(dir, name);
  const lines = [
    JSON.stringify({ type: "session", id: "sess-fixture", cwd: dir }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Partial work." }] },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Isolated env: tmp agent home (with one agent def), tmp project cwd. */
function freshRoot(agentName?: string): { agentDir: string; projectDir: string; ctx: unknown } {
  const root = mkdtempSync(join(tmpdir(), "delivery-heal-"));
  const agentDir = join(root, "agent-home");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  if (agentName) writeAgentFile(join(agentDir, "agents"), agentName, `name: ${agentName}\ntools: piread`);
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
const PINNED_ENV: [string, string][] = [
  ["PI_SUBAGENT_SHELL_READY_DELAY_MS", "1"],
];

beforeEach(() => {
  for (const [key, value] of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  for (const key of ["PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  __surfaceTest__.setTmuxRunner(null);
  __test__.runningSubagents.clear();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── the shared delivery heal ──

describe("deliverLaunchScript (shared by spawn-claude, spawn-pi, resume)", () => {
  it("heals a pane lost mid-delivery and returns the replacement pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-heal-unit-"));
    const sends: { surface: string; preamble: string }[] = [];
    let created = 0;

    const surface = __test__.deliverLaunchScript(
      "worker",
      "cmd-x",
      { surface: "%100", scriptPath: join(dir, "launch.sh"), preamble: (s) => `# Surface: ${s}` },
      {
        create: (name) => {
          created += 1;
          assert.equal(name, "worker");
          return "%101";
        },
        send: (surface, _command, opts) => {
          sends.push({ surface, preamble: opts?.scriptPreamble ?? "" });
          if (surface === "%100") throw paneNotFoundErr(surface);
        },
      },
    );

    assert.equal(surface, "%101", "returns the healed surface so callers track the live pane");
    assert.equal(created, 1, "re-splits exactly once");
    assert.deepEqual(
      sends.map((s) => s.surface),
      ["%100", "%101"],
      "delivers to the original pane, then the replacement",
    );
    assert.match(sends[1].preamble, /# Surface: %101/, "preamble reflects the replacement pane");
  });

  it("propagates unrelated tmux failures without re-splitting", () => {
    const sends: string[] = [];
    assert.throws(
      () =>
        __test__.deliverLaunchScript(
          "worker",
          "cmd-x",
          { surface: "%100", scriptPath: "/tmp/x.sh", preamble: () => "" },
          {
            create: () => {
              throw new Error("create must not run");
            },
            send: (surface) => {
              sends.push(surface);
              throw noServerErr("respawn-pane");
            },
          },
        ),
      /no server running/,
    );
    assert.deepEqual(sends, ["%100"], "no retry for non-pane failures");
  });

  it("throws a contextual error when the healed delivery also fails", () => {
    assert.throws(
      () =>
        __test__.deliverLaunchScript(
          "worker",
          "cmd-x",
          { surface: "%100", scriptPath: "/tmp/x.sh", preamble: () => "" },
          {
            create: () => "%101",
            send: (surface) => {
              throw paneNotFoundErr(surface);
            },
          },
        ),
      (err: Error) => {
        assert.match(err.message, /Failed to deliver the launch script to subagent "worker"/);
        assert.match(err.message, /retry/i);
        assert.doesNotMatch(err.message, /^Command failed/, "not a verbatim tmux error");
        return true;
      },
    );
  });
});

// ── spawn flow: the pi delivery site, end to end through launchSubagent ──

describe("launchSubagent delivery heal (pi flow)", () => {
  it("re-splits and redelivers when the fresh pane dies before respawn", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fake = fakeTmux({ splitPanes: ["%100", "%101"], failRespawnOn: ["%100"] });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const running = await __test__.launchSubagent(
      { agent: "worker", task: "verify delivery heal", name: "heal-pi" } as never,
      ctx as never,
    );

    assert.equal(running.surface, "%101", "tracks the replacement pane after the heal");
    assert.deepEqual(fake.targets("respawn-pane"), ["%100", "%101"], "delivered to both panes");
    assert.equal(fake.targets("split-window").length, 2, "split once, healed split once");
  });
});

// ── spawn tool: final failure must not re-throw verbatim ──

describe("subagent tool final-failure wrap", () => {
  it("wraps launch failures with context instead of re-throwing raw tmux errors", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const fake = fakeTmux({
      splitPanes: ["%100"],
      failAllRespawns: true,
      respawnErr: (t) => noServerErr(`respawn-pane -k -t ${t}`),
    });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const tools: Record<string, unknown>[] = [];
    subagentsExtension({
      on: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerShortcut: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      getAllTools: () => [],
      registerTool: (t: Record<string, unknown>) => {
        tools.push(t);
      },
      getActiveTools: () => ["subagent"],
      setActiveTools: () => {},
    } as never);
    const tool = tools.find((t) => t.name === "subagent") as { execute: Function };
    assert.ok(tool, "subagent tool registered");

    const validate = (err: Error) => {
      assert.match(err.message, /Failed to launch subagent "w1"/);
      assert.doesNotMatch(err.message, /^Command failed/, "no verbatim tmux re-throw");
      return true;
    };
    await assert.rejects(
      tool.execute("tc1", { agent: "worker", task: "t", name: "w1" }, undefined, undefined, ctx),
      validate,
    );
    // The name/queue reservations the failed launch held must be released:
    // a second spawn reaches its own failure instead of hanging.
    await assert.rejects(
      tool.execute("tc2", { agent: "worker", task: "t", name: "w2" }, undefined, undefined, ctx),
      /Failed to launch subagent "w2"/,
    );
  });
});

// ── resume flow: unexpected throws become actionable error results ──

describe("resume error containment", () => {
  it("returns an actionable error result when the pane is lost and recovery fails", async () => {
    const { agentDir, projectDir, ctx } = freshRoot("worker");
    savedEnv["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const sessionFile = writeSessionFixture(projectDir, "child.jsonl");
    writeSubagentLoadout(sessionFile, {
      agent: "worker",
      toolAllowlist: "piread",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: projectDir,
      agentDir: null,
    });
    registerName(join(projectDir, "artifacts", "parent-sid"), "resumee", {
      sessionFile,
      sessionId: "child-sid",
    });

    // Split succeeds (%100), the pane dies before respawn, and the healing
    // re-split also fails — the worst case the execute must contain.
    const fake = fakeTmux({
      splitPanes: ["%100"],
      failSplitFrom: 1,
      failSplitWith: noServerErr("split-window"),
      failRespawnOn: ["%100"],
    });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const result = (await __test__.resumeSubagentByName(
      { name: "resumee", message: "continue" },
      ctx as never,
    )) as { content: { text: string }[]; details: { error?: string } };

    const error = result?.details?.error ?? "";
    assert.ok(error, "returns an error result instead of throwing");
    assert.match(error, /resumee/, "names the subagent");
    assert.match(error, /again|retry/i, "tells the user what to do next");
    assert.doesNotMatch(error, /^Command failed/, "no raw tmux stderr");
    assert.match(result.content[0].text, /resumee/);
  });
});
