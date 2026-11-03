/**
 * Load-time assertion for extra extensions in sandboxed child spawns.
 *
 * Defect: an entry in PI_SUBAGENT_EXTRA_EXTENSIONS that did not exist on disk
 * was silently skipped while building the child's launch args — most commonly
 * a `.ts` suffix pointing at a file inside the gate's directory-based layout,
 * which dropped the permission gate from every allowlisted spawn with no
 * warning anywhere.
 *
 * Contract under test:
 * - an entry ending in .ts/.js/.mjs whose file is absent but whose parent
 *   directory exists self-heals to that directory (no drop, no warning);
 * - an entry with no existing target is dropped loudly: one stderr warning
 *   per dropped path per spawn, naming the path;
 * - the shipped default (env unset) never warns on a healthy install, and
 *   warns the same way when the default gate directory itself is missing.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
const { __test__ } = await import("../../extensions/subagents/index.ts");

const savedExtraExt = process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;

beforeEach(() => {
  delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
  __test__.resetChannelState();
  __test__.setUiContext(null);
});

afterEach(() => {
  mock.restoreAll();
  __test__.resetChannelState();
  __test__.setUiContext(null);
  if (savedExtraExt === undefined) delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
  else process.env.PI_SUBAGENT_EXTRA_EXTENSIONS = savedExtraExt;
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "extra-ext-guard-"));
}

function baseLoadout() {
  return {
    agent: "worker",
    toolAllowlist: "read",
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

/** Capture console.error lines emitted while `run` executes. Diagnostics
 *  reported while no UI context exists are held in a queue, not printed —
 *  materialize them the way a confirmed-headless context would so the
 *  assertions below still see exactly what a headless run would print. */
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
  }
}

describe("resolveExtraExtensions", () => {
  it("heals a .ts entry whose parent directory exists into that directory", () => {
    const dir = makeTempDir();
    try {
      const gate = join(dir, "gate");
      mkdirSync(gate); // directory layout: no index.ts file is created on purpose
      const { kept, dropped } = __test__.resolveExtraExtensions([join(gate, "index.ts")]);
      assert.deepEqual(kept, [gate]);
      assert.deepEqual(dropped, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("heals .js and .mjs suffixes the same way as .ts", () => {
    const dir = makeTempDir();
    try {
      const gate = join(dir, "gate");
      mkdirSync(gate);
      const { kept, dropped } = __test__.resolveExtraExtensions([
        join(gate, "index.js"),
        join(gate, "index.mjs"),
      ]);
      assert.deepEqual(kept, [gate, gate]);
      assert.deepEqual(dropped, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps entries that exist and drops entries with no existing target", () => {
    const dir = makeTempDir();
    try {
      const gate = join(dir, "gate");
      mkdirSync(gate);
      const orphanFile = join(dir, "nowhere", "index.ts"); // parent also missing
      const orphanDir = join(dir, "nowhere-dir");
      const { kept, dropped } = __test__.resolveExtraExtensions([gate, orphanFile, orphanDir, "  "]);
      assert.deepEqual(kept, [gate]);
      assert.deepEqual(dropped, [orphanFile, orphanDir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a dropped path once even when the entry repeats", () => {
    const dir = makeTempDir();
    try {
      const orphan = join(dir, "ghost");
      const { dropped } = __test__.resolveExtraExtensions([orphan, orphan]);
      assert.deepEqual(dropped, [orphan]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applySandboxToParts extra-extension guard", () => {
  it("loads <gate>/index.ts as the directory when the directory exists, without warning", () => {
    const dir = makeTempDir();
    try {
      const gate = join(dir, "gate");
      mkdirSync(gate);
      process.env.PI_SUBAGENT_EXTRA_EXTENSIONS = join(gate, "index.ts");
      const parts: string[] = [];
      const stderr = captureStderr(() => {
        __test__.applySandboxToParts(parts, baseLoadout(), { artifactDir: dir, name: "worker" });
      });
      const loaded = parts.filter((p, i) => parts[i - 1] === "-e" && p.replace(/'/g, "") === gate);
      assert.equal(loaded.length, 1, `expected -e ${gate} in launch args: ${parts.join(" ")}`);
      assert.deepEqual(stderr, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on stderr naming an entry that cannot be resolved, and omits it from launch args", () => {
    const dir = makeTempDir();
    try {
      const orphan = join(dir, "missing", "gate");
      process.env.PI_SUBAGENT_EXTRA_EXTENSIONS = orphan;
      const parts: string[] = [];
      const stderr = captureStderr(() => {
        __test__.applySandboxToParts(parts, baseLoadout(), { artifactDir: dir, name: "worker" });
      });
      assert.equal(stderr.length, 1, `expected exactly one warning, got: ${stderr.join(" | ")}`);
      assert.match(
        stderr[0],
        /PI_SUBAGENT_EXTRA_EXTENSIONS entry not found, dropping: .*missing.*gate/,
      );
      assert.ok(
        !parts.some((p) => p.replace(/'/g, "").includes(orphan)),
        `dropped entry leaked into launch args: ${parts.join(" ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unset env with a healthy default never warns; a missing default gate warns loudly instead", () => {
    const dir = makeTempDir();
    try {
      delete process.env.PI_SUBAGENT_EXTRA_EXTENSIONS;
      const defaultGate = join(homedir(), ".pi", "agent", "extensions", "permission-gate");
      const parts: string[] = [];
      const stderr = captureStderr(() => {
        __test__.applySandboxToParts(parts, baseLoadout(), { artifactDir: dir, name: "worker" });
      });
      if (existsSync(defaultGate)) {
        assert.deepEqual(stderr, [], `healthy install must not warn: ${stderr.join(" | ")}`);
      } else {
        assert.equal(stderr.length, 1, `missing default gate must warn: ${stderr.join(" | ")}`);
        assert.match(stderr[0], new RegExp(`entry not found, dropping: ${defaultGate.replace(/[/\\]/g, "\\$&")}`));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
