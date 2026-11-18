// Phase 5 (audit A14): every spawned child's task prompt carries a gate
// brief — composition recipe, rg/fd-first, dash-path hint, no-destructive
// policy — so children stop paying the 12+ gate-event rediscovery tax.
// Asserts the artifact-backed task delivery path (the default for task
// children); fork clones inherit the parent conversation and are out of scope.
import "./test-env.ts";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;
import { __surfaceTest__ } from "../../extensions/subagents/tmux.ts";

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

function freshRoot(agentName?: string): { agentDir: string; projectDir: string; ctx: unknown } {
  const root = mkdtempSync(join(tmpdir(), "gate-brief-"));
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

describe("spawn gate brief (A14)", () => {
  it("the task artifact carries the gate brief paragraph", async () => {
    const { agentDir, projectDir, ctx } = freshRoot("worker");
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    __surfaceTest__.setTmuxRunner(fakeTmux().runner);

    const running = await __test__.launchSubagent(
      { agent: "worker", task: "do the thing", name: "briefed" } as never,
      ctx as never,
    );
    assert.ok(running, "launch succeeds");

    const contextDir = join(projectDir, "artifacts", "parent-sid", "context");
    const taskArtifacts = readdirSync(contextDir).filter(
      (f) => f.endsWith(".md") && !f.includes("sysprompt"),
    );
    assert.ok(taskArtifacts.length >= 1, "a task artifact exists");
    const text = taskArtifacts.map((f) => readFileSync(join(contextDir, f), "utf8")).join("\n");
    assert.match(text, /piread/, "brief names piread");
    assert.match(text, /rg PATTERN path\//, "brief names the rg shape");
    assert.match(text, /fd PATTERN path\//, "brief names the fd shape");
    assert.match(text, /\.\//, "brief carries the dash-path hint");
    assert.match(text, /piedit\/piwrite/, "brief points mutations at piedit/piwrite");
    assert.match(text, /destructive/i, "brief states the no-destructive policy");
    assert.match(text, /stop and ask/i, "brief names the stop-and-ask route");
    assert.match(text, /do the thing/, "the task text itself is preserved");
  });
});
