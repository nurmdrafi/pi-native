/**
 * Tool-surface resolution and its spawn-time guard.
 *
 * Defect 1 (silent drop): an allowlisted non-builtin tool that resolved to no
 * extension path was skipped silently while building the child's launch args,
 * so a typo'd tool name spawned a toolless child with no warning anywhere.
 *
 * Defect 2 (load-order coupling): first-party native tools reached children
 * only via a hardcoded name-to-path map plus a runtime registry whose hook
 * silently no-ops for extensions that load before the subagents extension.
 *
 * Contract under test:
 * - every allowlisted non-builtin tool that resolves to no existing extension
 *   path warns once on stderr at spawn-args build time, naming the tool;
 * - built-in tools never trigger that warning;
 * - tool-to-extension resolution is declarative and load-order independent: a
 *   `pi-tools.json` manifest in an extension directory (or its `tools/`
 *   subdirectory, with an `entry` override) wins, then the directory-naming
 *   convention (`web_search` -> `web-search/index.ts`), then the runtime
 *   registry;
 * - a malformed manifest is skipped loudly without aborting the scan;
 * - control tools force-added by the sandbox builder (ask_question) never
 *   trigger that warning: they resolve from no manifest by design, and every
 *   launch/resume path delivers them via a dedicated `-e subagent-done.ts`
 *   push alongside the sandbox replay.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
const { __test__ } = await import("../../extensions/subagents/index.ts");
const { scanToolManifests } = await import("../../extensions/subagents/tool-manifest.ts");

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

/** Capture console.error lines emitted while `run` executes. */
function captureStderr(run: () => void): string[] {
  const err = mock.method(console, "error", () => {});
  run();
  return err.mock.calls.map((c) => c.arguments.join(" "));
}

function baseLoadout(toolAllowlist: string) {
  return {
    agent: "worker",
    toolAllowlist,
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: false,
    cwd: null,
    agentDir: null,
  };
}

describe("applySandboxToParts unresolvable-tool guard", () => {
  afterEach(() => {
    mock.restoreAll();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  });

  it("warns once per allowlisted tool that resolves to no extension", () => {
    // Point the config dir at an empty tree so nothing resolves by convention.
    const dir = mkdtempSync(join(tmpdir(), "tool-surface-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const parts: string[] = [];
      const lines = captureStderr(() =>
        __test__.applySandboxToParts(parts, baseLoadout("read,bogus_tool"), {
          artifactDir: dir,
          name: "w1",
        }),
      );
      const warnings = lines.filter((l) => l.includes("bogus_tool"));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /resolves to no extension/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never warns about built-in tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-surface-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const parts: string[] = [];
      const lines = captureStderr(() =>
        __test__.applySandboxToParts(parts, baseLoadout("read,write,edit,bash"), {
          artifactDir: dir,
          name: "w1",
        }),
      );
      assert.deepEqual(lines.filter((l) => /resolves to no extension/.test(l)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never warns about control tools — ask_question rides the dedicated -e subagent-done.ts push", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-surface-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const parts: string[] = [];
      const lines = captureStderr(() =>
        __test__.applySandboxToParts(parts, baseLoadout("read,ask_question"), {
          artifactDir: dir,
          name: "w1",
        }),
      );
      assert.deepEqual(lines.filter((l) => /resolves to no extension/.test(l)), []);
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "--tools flag present");
      assert.ok(
        (parts[toolsIdx + 1] ?? "").includes("ask_question"),
        "control tool stays on the allowlist",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanToolManifests", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-manifests-"));
  });
  afterEach(() => {
    mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("maps declared tools to the manifest directory's default entry", () => {
    mkdirSync(join(root, "mine"));
    writeFileSync(join(root, "mine", "pi-tools.json"), JSON.stringify({ tools: ["my_tool"] }));
    writeFileSync(join(root, "mine", "index.ts"), "");
    assert.equal(scanToolManifests(root).get("my_tool"), join(root, "mine", "index.ts"));
  });

  it("honors an entry override in a nested tools/ manifest", () => {
    mkdirSync(join(root, "pkg", "tools"), { recursive: true });
    writeFileSync(
      join(root, "pkg", "tools", "pi-tools.json"),
      JSON.stringify({ tools: ["shell"], entry: "shell.ts" }),
    );
    writeFileSync(join(root, "pkg", "tools", "shell.ts"), "");
    assert.equal(scanToolManifests(root).get("shell"), join(root, "pkg", "tools", "shell.ts"));
  });

  it("skips a malformed manifest loudly and keeps scanning", () => {
    mkdirSync(join(root, "bad"));
    mkdirSync(join(root, "good"));
    writeFileSync(join(root, "bad", "pi-tools.json"), "not json{");
    writeFileSync(join(root, "good", "pi-tools.json"), JSON.stringify({ tools: ["ok_tool"] }));
    const err = mock.method(console, "error", () => {});
    const out = scanToolManifests(root);
    assert.equal(out.get("ok_tool"), join(root, "good", "index.ts"));
    assert.ok(err.mock.calls.some((c) => c.arguments.join(" ").includes("bad")));
    mock.restoreAll();
  });

  it("returns an empty map when the base is missing", () => {
    assert.equal(scanToolManifests(join(root, "nope")).size, 0);
  });
});

describe("getToolExtensionPath declarative resolution", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-resolve-"));
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "extensions"), { recursive: true });
  });
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the directory-naming convention (web_search -> web-search/index.ts)", () => {
    mkdirSync(join(root, "extensions", "web-search"));
    writeFileSync(join(root, "extensions", "web-search", "index.ts"), "");
    assert.equal(
      __test__.getToolExtensionPath("web_search"),
      join(root, "extensions", "web-search", "index.ts"),
    );
  });

  it("prefers a manifest entry over the naming convention", () => {
    mkdirSync(join(root, "extensions", "web-search"));
    writeFileSync(join(root, "extensions", "web-search", "index.ts"), "");
    mkdirSync(join(root, "extensions", "alt"));
    writeFileSync(
      join(root, "extensions", "alt", "pi-tools.json"),
      JSON.stringify({ tools: ["web_search"], entry: "impl.ts" }),
    );
    writeFileSync(join(root, "extensions", "alt", "impl.ts"), "");
    assert.equal(
      __test__.getToolExtensionPath("web_search"),
      join(root, "extensions", "alt", "impl.ts"),
    );
  });

  it("returns undefined for a built-in tool", () => {
    assert.equal(__test__.getToolExtensionPath("read"), undefined);
  });
});
