// Phase 7 (audit A10): the tool loadout is deny-by-default. An agent
// definition without `tools:` frontmatter must no longer yield an
// unrestricted child (null allowlist) — it yields the control-tools-only
// allowlist ("ask_question"). `tools: all` is the single explicit
// unrestricted route and must warn at spawn time. Declared lists and the
// grantSpawning path keep their exact previous output.
//
// Unit cases exercise buildSubagentToolAllowlist directly (exported through
// __test__); the spawn cases run the full launchSubagent path (fakeTmux
// harness, same shape as gate-brief.test.ts) and read the loadout sidecar
// written beside the child session file.
import "./test-env.ts";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";
import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";
import { readSubagentLoadout } from "../../extensions/subagents/session.ts";

const savedEnv: Record<string, string | undefined> = {};
const roots: string[] = [];

beforeEach(() => {
  for (const key of [
    "PI_SUBAGENT_SHELL_READY_DELAY_MS",
    "PI_SUBAGENT_ALLOWED",
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_EXTRA_EXTENSIONS",
    "PI_CODING_AGENT_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "1";
  delete process.env.PI_SUBAGENT_ALLOWED;
  delete process.env.PI_SUBAGENT_AGENT;
  delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
  __test__.resetChannelState();
  __test__.setUiContext(null);
  __test__.clearAgentDefCache();
});

afterEach(() => {
  __surfaceTest__.setTmuxRunner(null);
  __test__.runningSubagents.clear();
  mock.timers.reset();
  mock.restoreAll();
  __test__.resetChannelState();
  __test__.setUiContext(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fakeTmux() {
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
        const pane = `%${100 + splits.length}`;
        splits.push(pane);
        return pane;
      }
      case "respawn-pane":
        return "";
      default:
        return "";
    }
  };
  return { runner, of: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

/** Fresh temp root with an optional agent definition under its config dir. */
function freshRoot(agent?: { name: string; frontmatter: string }): {
  agentDir: string;
  projectDir: string;
  ctx: unknown;
} {
  const root = mkdtempSync(join(tmpdir(), "loadout-default-"));
  roots.push(root);
  const agentDir = join(root, "agent-home");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  if (agent) {
    const agentsDir = join(agentDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${agent.name}.md`), agent.frontmatter, "utf8");
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

/** Capture console.error lines emitted while `run` executes. Diagnostics
 *  reported while no UI context exists are held in a queue, not printed —
 *  materialize them the way a confirmed-headless context would (same shape
 *  as extra-ext-guard.test.ts). */
function captureStderr(run: () => void): string[] {
  const err = mock.method(console, "error", () => {});
  try {
    run();
    if (__test__.pendingDiagnostics().length > 0) {
      __test__.setUiContext({ hasUI: false } as never);
    }
    return err.mock.calls.map((c) => c.arguments.join(" "));
  } finally {
    err.mock.restore();
    __test__.setUiContext(null);
  }
}

describe("buildSubagentToolAllowlist deny-by-default (A10)", () => {
  it("undeclared or empty tools yield the control-tools-only allowlist, not null", () => {
    assert.equal(__test__.buildSubagentToolAllowlist(undefined), "ask_question");
    assert.equal(__test__.buildSubagentToolAllowlist(""), "ask_question");
    assert.equal(__test__.buildSubagentToolAllowlist("   "), "ask_question");
  });

  it("a declared list keeps its order and gains the control lane", () => {
    assert.equal(
      __test__.buildSubagentToolAllowlist("ls, piread, pibash"),
      "ls,piread,pibash,ask_question",
    );
  });

  it("undeclared + grantSpawning preserves the spawning grant plus control lane", () => {
    assert.equal(
      __test__.buildSubagentToolAllowlist(undefined, { grantSpawning: true }),
      "subagent,subagent_message,subagents_list,ask_question",
    );
  });

  it("`tools: all` (trimmed, case-insensitive, single token) is the only unrestricted route", () => {
    assert.equal(__test__.buildSubagentToolAllowlist("all"), null);
    assert.equal(__test__.buildSubagentToolAllowlist("  ALL  "), null);
    assert.notEqual(
      __test__.buildSubagentToolAllowlist("all,read"),
      null,
      "multi-token value is a declared list, not the all-token",
    );
  });
});

/** Async variant of captureStderr: the diagnostic fires mid-launch, so the
 *  console.error mock must stay attached across the awaited launch. */
async function captureStderrAsync(run: () => Promise<unknown>): Promise<string[]> {
  const err = mock.method(console, "error", () => {});
  try {
    await run();
    if (__test__.pendingDiagnostics().length > 0) {
      __test__.setUiContext({ hasUI: false } as never);
    }
    return err.mock.calls.map((c) => c.arguments.join(" "));
  } finally {
    err.mock.restore();
    __test__.setUiContext(null);
  }
}

describe("spawn loadout default (A10)", () => {
  it("a definition without tools: spawns control-tools-only (deny-by-default)", async () => {
    const { agentDir, ctx } = freshRoot({
      name: "bare",
      frontmatter: "---\nname: bare\ndescription: no tools line\n---\n\nBody.\n",
    });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __surfaceTest__.setTmuxRunner(fakeTmux().runner);

    const running = await __test__.launchSubagent(
      { agent: "bare", task: "do work", name: "denied" } as never,
      ctx as never,
    );
    assert.ok(running, "launch succeeds");
    const loadout = readSubagentLoadout(running.sessionFile);
    assert.ok(loadout, "loadout sidecar written");
    assert.equal(
      loadout.toolAllowlist,
      "ask_question",
      "undeclared tools must deny everything except the control lane",
    );
  });

  it("`tools: all` spawns unrestricted and warns at spawn time", async () => {
    const { agentDir, ctx } = freshRoot({
      name: "omni",
      frontmatter: "---\nname: omni\ntools: all\n---\n\nBody.\n",
    });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __surfaceTest__.setTmuxRunner(fakeTmux().runner);

    let launched: Awaited<ReturnType<typeof __test__.launchSubagent>> | undefined;
    const stderr = await captureStderrAsync(async () => {
      launched = await __test__.launchSubagent(
        { agent: "omni", task: "do work", name: "unleashed" } as never,
        ctx as never,
      );
    });
    const running = launched;
    assert.ok(running, "launch succeeds");
    const loadout = readSubagentLoadout(running.sessionFile);
    assert.ok(loadout, "loadout sidecar written");
    assert.equal(loadout.toolAllowlist, null, "tools: all is the explicit unrestricted route");
    assert.ok(
      stderr.some((line) => /unrestricted/i.test(line) && /tools: all/.test(line)),
      `expected an unrestricted-spawn diagnostic naming tools: all, got: ${stderr.join(" | ")}`,
    );
  });
});
