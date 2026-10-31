/**
 * Atomic launch and launch-failure containment (spawn + resume flows).
 *
 * The old delivery model created a pane running the user's default shell,
 * slept a fixed shell-ready delay, and delivered the launch script with
 * `tmux respawn-pane -k` against the pane id the split returned. A pane that
 * died inside that window made spawn re-throw raw `Command failed: tmux
 * respawn-pane ... can't find pane: %N` errors, and resume throw out of an
 * execute body with no catch at all.
 *
 * Fix: the pane is BORN running the launch script — one atomic split-window
 * whose command runs the script, signals the wait-for channel, and keeps an
 * interactive shell. No default-shell window ever exists, so respawn-pane is
 * never called on launch and the pane race cannot occur (dead-split-origin
 * healing is exercised by the surface suite). What remains observable from
 * the outside: the spawn execute wraps launch failures with context instead
 * of re-throwing verbatim tmux errors, and the resume execute converts
 * unexpected throws into actionable { error } results.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";
import { registerName, writeSubagentLoadout } from "../../extensions/subagents/session.ts";
import { appendSubagentResult } from "../../extensions/subagents/inbox.ts";

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
  const calls: { cmd: string; target: string | null; args: string[] }[] = [];
  let splits = 0;
  const runner = (args: string[]): string => {
    const target = targetOf(args);
    calls.push({ cmd: args[0], target, args });
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
  /** Last argv element of the Nth call to cmd — where split-window carries
   *  the pane command the new pane is born running. */
  const paneCommandOf = (cmd: string, n = 0): string =>
    calls.filter((c) => c.cmd === cmd)[n]?.args.at(-1) ?? "";
  return { runner, calls, targets, paneCommandOf };
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

// ── spawn flow: the pi launch site, end to end through launchSubagent ──

describe("launchSubagent atomic pane launch (pi flow)", () => {
  it("succeeds with zero respawn-pane even when every respawn fails", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // The exact production defect shape: with atomic creation the launch
    // never routes through respawn-pane, so respawn being unusable — the
    // old pane race — cannot affect it at all.
    const fake = fakeTmux({ splitPanes: ["%100"], failAllRespawns: true });
    __surfaceTest__.setTmuxRunner(fake.runner);

    const running = await __test__.launchSubagent(
      { agent: "worker", task: "verify atomic launch", name: "atomic-pi" } as never,
      ctx as never,
    );

    assert.ok(running, "launch succeeds despite respawn-pane being unusable");
    assert.equal(running.surface, "%100", "surface is the pane the split returned");
    assert.equal(fake.targets("respawn-pane").length, 0, "launch never respawns a pane");
    assert.equal(fake.targets("split-window").length, 1, "exactly one split-window");
    const paneCommand = fake.paneCommandOf("split-window");
    assert.match(paneCommand, /bash '.+\.sh'/, "the pane is born running the launch script");
    assert.match(paneCommand, /tmux wait-for -S pi-subagent-/, "signals the wake channel");
    assert.ok(
      paneCommand.includes(`bash '${running.launchScriptFile}'`),
      "runs the archived launch script",
    );
  });
});

// ── spawn tool: final failure must not re-throw verbatim ──

describe("subagent tool final-failure wrap", () => {
  it("wraps launch failures with context instead of re-throwing raw tmux errors", async () => {
    const { agentDir, ctx } = freshRoot("worker");
    savedEnv["PI_CODING_AGENT_DIR"] = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Atomic creation means launch failures come from the split itself.
    const fake = fakeTmux({ failSplitFrom: 0, failSplitWith: noServerErr("split-window") });
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
  it("returns an actionable error result when pane creation fails", async () => {
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

    // The atomic pane creation itself fails — the worst case the execute
    // must contain.
    const fake = fakeTmux({ failSplitFrom: 0, failSplitWith: noServerErr("split-window") });
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

// ── durable inbox drain: stale dead-parent records must not task-steer ──

describe("inbox drain delivery", () => {
  it("delivers a dead-parent record to an unrelated session context-only (no trigger, no steer)", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-unrelated-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const savedInbox = process.env.PI_SUBAGENT_INBOX;
    delete process.env.PI_SUBAGENT_INBOX;
    appendSubagentResult({
      id: "stale-1",
      ts: Date.now(),
      name: "Worker-old",
      task: "old task",
      sessionFile: "/tmp/old.jsonl",
      parentSessionId: "dead-parent",
      repoRoot: root,
      summary: "stale result body",
      exitCode: 0,
      elapsed: 1,
      observedByParent: false,
    });

    const handlers: Record<string, Function> = {};
    const sent: { msg: any; opts: any }[] = [];
    subagentsExtension({
      on: (ev: string, fn: Function) => {
        handlers[ev] = fn;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerShortcut: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg: any, opts: any) => {
        sent.push({ msg, opts });
      },
      getAllTools: () => [],
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as never);

    try {
      handlers["session_start"]?.(null, {
        cwd: root,
        sessionManager: { getSessionId: () => "fresh-session" },
      });
    } finally {
      if (savedInbox === undefined) delete process.env.PI_SUBAGENT_INBOX;
      else process.env.PI_SUBAGENT_INBOX = savedInbox;
    }

    const inboxSent = sent.filter((s) => s.msg?.details?.fromInbox);
    assert.equal(inboxSent.length, 1, "record surfaced once");
    const { msg, opts } = inboxSent[0];
    assert.equal(msg.customType, "subagent_result");
    assert.equal(msg.details.contextOnly, true, "marked context-only");
    assert.ok(!opts?.triggerTurn, "must not force a turn");
    assert.ok(!opts?.deliverAs, "must not queue as steer/followUp/nextTurn");
    assert.match(msg.content, /Informational/i, "phrased as informational");
  });

  it("still steers an unobserved record into its own resumed parent", () => {
    const root = mkdtempSync(join(tmpdir(), "inbox-own-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const savedInbox = process.env.PI_SUBAGENT_INBOX;
    delete process.env.PI_SUBAGENT_INBOX;
    appendSubagentResult({
      id: "own-1",
      ts: Date.now(),
      name: "Worker-own",
      task: "my task",
      sessionFile: "/tmp/own.jsonl",
      parentSessionId: "parent-1",
      repoRoot: root,
      summary: "result the parent never saw",
      exitCode: 0,
      elapsed: 1,
      observedByParent: false,
    });

    const handlers: Record<string, Function> = {};
    const sent: { msg: any; opts: any }[] = [];
    subagentsExtension({
      on: (ev: string, fn: Function) => {
        handlers[ev] = fn;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerShortcut: () => {},
      sendUserMessage: () => {},
      sendMessage: (msg: any, opts: any) => {
        sent.push({ msg, opts });
      },
      getAllTools: () => [],
      registerTool: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as never);

    try {
      handlers["session_start"]?.(null, {
        cwd: root,
        sessionManager: { getSessionId: () => "parent-1" },
      });
    } finally {
      if (savedInbox === undefined) delete process.env.PI_SUBAGENT_INBOX;
      else process.env.PI_SUBAGENT_INBOX = savedInbox;
    }

    const inboxSent = sent.filter((s) => s.msg?.details?.fromInbox);
    assert.equal(inboxSent.length, 1, "record surfaced once");
    const { msg, opts } = inboxSent[0];
    assert.equal(opts?.triggerTurn, true, "parent reclaims via a triggered turn");
    assert.equal(opts?.deliverAs, "steer");
    assert.ok(!msg.details.contextOnly, "not marked context-only");
  });
});
