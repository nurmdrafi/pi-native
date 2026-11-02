/**
 * Resume must rebuild a child's sandbox from its launch artifacts when the
 * `.loadout.json` sidecar is gone.
 *
 * The sidecar sits next to the session file, so anything that drops or
 * truncates it (a copied session tree, a cleanup, a crash between the sidecar
 * write and the pane launch) made resume refuse to ever continue that child.
 * The launch script under `subagent-scripts/<name>-*.sh` records the same
 * sandbox (cwd, tool allowlist, model, agent dir, spawn whitelist, system
 * prompt file), and `context/<name>-sysprompt-*.md` still holds the identity
 * text — so the sandbox can be rebuilt instead of refused.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";
import {
  findLaunchScript,
  loadoutFromLaunchScript,
  resolveResumeLoadout,
  slugifySubagentName,
} from "../../extensions/subagents/launch-artifacts.ts";
import { writeSubagentLoadout } from "../../extensions/subagents/session.ts";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "resume-loadout-"));
  roots.push(root);
  return root;
}

/** Write a launch script shaped like the extension's own pi-path script. */
function writeLaunchScript(
  artifactDir: string,
  opts: {
    name?: string;
    file?: string;
    cwd?: string | null;
    tools?: string | null;
    model?: string | null;
    identityPath?: string | null;
    identityMode?: "append" | "replace";
    agent?: string | null;
    agentDir?: string | null;
    spawnable?: string[] | null;
    autoExit?: boolean;
    claude?: boolean;
    mtime?: number;
  } = {},
): string {
  const name = opts.name ?? "scout";
  const file = opts.file ?? `${slugifySubagentName(name)}-ab12cd34.sh`;
  const dir = join(artifactDir, "subagent-scripts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const env: string[] = [];
  if (opts.agentDir) env.push(`PI_CODING_AGENT_DIR=${quote(opts.agentDir)}`);
  if (opts.spawnable) env.push(`PI_SUBAGENT_ALLOWED=${quote(opts.spawnable.join(","))}`);
  env.push(`PI_SUBAGENT_NAME=${quote(name)}`);
  if (opts.agent) env.push(`PI_SUBAGENT_AGENT=${quote(opts.agent)}`);
  if (opts.autoExit) env.push("PI_SUBAGENT_AUTO_EXIT=1");
  env.push(`PI_SUBAGENT_SESSION=${quote(join(artifactDir, "child.jsonl"))}`);
  env.push("PI_SUBAGENT_ID='ab12cd34'");
  env.push("PI_SUBAGENT_SURFACE=\"${TMUX_PANE}\"");
  if (opts.claude) {
    writeFileSync(path, `# Claude Code subagent launch script for ${name}\nclaude --print\n`, "utf8");
    return path;
  }
  const parts = ["pi", "--session", quote(join(artifactDir, "child.jsonl")), "-e", quote("/x/subagent-done.ts")];
  if (opts.model) parts.push("--model", quote(opts.model));
  if (opts.identityPath) {
    parts.push(opts.identityMode === "replace" ? "--system-prompt" : "--append-system-prompt");
    parts.push(quote(opts.identityPath));
  }
  if (opts.tools) {
    parts.push("--no-extensions", "--tools", quote(opts.tools));
    parts.push("-e", quote("/x/extensions/piread/index.ts"));
  }
  const cdPrefix = opts.cwd ? `cd ${quote(opts.cwd)} && ` : "";
  writeFileSync(
    path,
    `#!/bin/sh\n${cdPrefix}${env.join(" ")} ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'\n`,
    "utf8",
  );
  if (opts.mtime !== undefined) utimesSync(path, opts.mtime, opts.mtime);
  return path;
}

function writeSysprompt(artifactDir: string, name: string, body: string): string {
  const dir = join(artifactDir, "context");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slugifySubagentName(name)}-sysprompt-2026-01-01T00-00-00.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("resume loadout rebuild from launch artifacts", () => {
  beforeEach(() => {
    __test__.runningSubagents.clear();
  });

  afterEach(() => {
    __test__.runningSubagents.clear();
    __test__.setLatestPi(null);
    __test__.resetChannelState();
    __test__.setUiContext(null);
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds cwd, tools, model, agent dir, whitelist and identity from the script", () => {
    const artifactDir = freshRoot();
    const identityPath = writeSysprompt(artifactDir, "scout", "You are the scout.\n");
    const script = writeLaunchScript(artifactDir, {
      cwd: "/work/project",
      tools: "ls,piread,pibash,ask_question",
      model: "claude-sonnet-4:high",
      identityPath,
      agent: "scout",
      agentDir: "/home/agent",
      spawnable: ["scout", "worker"],
      autoExit: true,
    });

    const loadout = loadoutFromLaunchScript(script);
    assert.ok(loadout, "script parsed");
    assert.equal(loadout.cwd, "/work/project");
    assert.equal(loadout.toolAllowlist, "ls,piread,pibash,ask_question");
    assert.equal(loadout.model, "claude-sonnet-4:high", "model replayed verbatim, thinking included");
    assert.equal(loadout.agent, "scout");
    assert.equal(loadout.agentDir, "/home/agent");
    assert.deepEqual(loadout.spawnable, ["scout", "worker"]);
    assert.equal(loadout.autoExit, true);
    assert.equal(loadout.systemPromptMode, "append");
    assert.equal(loadout.identity, "You are the scout.\n", "identity text recovered from the sysprompt file");
  });

  it("records replace mode from --system-prompt", () => {
    const artifactDir = freshRoot();
    const identityPath = writeSysprompt(artifactDir, "scout", "Replacement identity.\n");
    const script = writeLaunchScript(artifactDir, {
      identityPath,
      identityMode: "replace",
    });

    assert.equal(loadoutFromLaunchScript(script)?.systemPromptMode, "replace");
  });

  it("keeps an unrestricted spawn unrestricted", () => {
    const artifactDir = freshRoot();
    const script = writeLaunchScript(artifactDir, { cwd: "/work/project" });
    const loadout = loadoutFromLaunchScript(script);
    assert.ok(loadout, "script parsed");
    assert.equal(loadout.toolAllowlist, null, "no --tools means full toolset, replayed as-is");
    assert.equal(loadout.identity, null);
  });

  it("refuses to rebuild from a non-pi launch script", () => {
    const artifactDir = freshRoot();
    const script = writeLaunchScript(artifactDir, { claude: true });
    assert.equal(loadoutFromLaunchScript(script), null);
  });

  it("returns null for a missing or unreadable script", () => {
    assert.equal(loadoutFromLaunchScript(join(freshRoot(), "nope.sh")), null);
  });

  it("finds the newest script for a name and ignores other names", () => {
    const artifactDir = freshRoot();
    const old = writeLaunchScript(artifactDir, { name: "scout", file: "scout-aaaa.sh", mtime: 1_600_000_000 });
    const recent = writeLaunchScript(artifactDir, { name: "scout", file: "scout-bbbb.sh", mtime: 1_700_000_000 });
    writeLaunchScript(artifactDir, { name: "worker", file: "worker-cccc.sh", mtime: 1_800_000_000 });

    assert.equal(findLaunchScript(artifactDir, "scout"), recent);
    assert.notEqual(findLaunchScript(artifactDir, "scout"), old);
    assert.equal(findLaunchScript(artifactDir, "nobody"), null);
  });

  it("prefers the sidecar and falls back to the launch script", () => {
    const artifactDir = freshRoot();
    const sessionFile = join(artifactDir, "child.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    const identityPath = writeSysprompt(artifactDir, "scout", "You are the scout.\n");
    writeLaunchScript(artifactDir, { tools: "piread", cwd: "/work/project", identityPath });

    const rebuilt = resolveResumeLoadout(artifactDir, "scout", sessionFile);
    assert.equal(rebuilt?.source, "launch-script");
    assert.equal(rebuilt?.loadout.toolAllowlist, "piread");

    writeSubagentLoadout(sessionFile, {
      agent: "scout",
      toolAllowlist: "ls",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: null,
      agentDir: null,
    });
    const fromSidecar = resolveResumeLoadout(artifactDir, "scout", sessionFile);
    assert.equal(fromSidecar?.source, "sidecar");
    assert.equal(fromSidecar?.loadout.toolAllowlist, "ls", "sidecar wins over the script");
  });

  it("returns null when neither the sidecar nor a script exists", () => {
    const artifactDir = freshRoot();
    const sessionFile = join(artifactDir, "child.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    assert.equal(resolveResumeLoadout(artifactDir, "scout", sessionFile), null);
  });

  it("names both sources when resume still refuses for a missing sandbox", async () => {
    const sessionDir = freshRoot();
    const sessionId = "spawner-sid";
    const artifactDir = join(sessionDir, "artifacts", sessionId);
    mkdirSync(artifactDir, { recursive: true });
    const sessionFile = join(artifactDir, "child.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    const { appendSessionIndex } = await import("../../extensions/subagents/session.ts");
    appendSessionIndex(artifactDir, { name: "scout", sessionFile, sessionId: "child-sid" });
    __test__.setLatestPi({} as never);

    const res = await __test__.resumeSubagentByName(
      { name: "scout", message: "keep going" },
      {
        cwd: sessionDir,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionDir: () => sessionDir,
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
        },
      } as never,
    );
    const err = res.details.error as string;
    assert.match(err, /sandbox/i);
    assert.match(err, /launch script/i, "refusal names the launch-script fallback");
  });
});
