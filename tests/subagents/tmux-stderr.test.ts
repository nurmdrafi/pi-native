/**
 * tmux child stderr must never leak into the parent terminal.
 *
 * Defect under test: execFileSync forwards a failed child's stderr to the
 * parent's own stderr unless stdio is pinned, so the dead-pane sweep that
 * every session start runs printed `error connecting to <socket> (No such
 * file or directory)` straight into the user's terminal whenever no tmux
 * server was running (fresh boot, or the server exiting with its last
 * session) — even though the failure was already classified server-gone and
 * swallowed by the sweep's catch.
 *
 * Contract under test: every synchronous tmux call captures the child's
 * stderr instead of inheriting it, while the captured text keeps feeding
 * error classification. Verified end to end: a probe child process calls
 * the real reapDeadAgentPanes against a fake tmux that fails exactly like
 * a missing server — the probe must exit 0 with empty stderr.
 */
import "./test-env.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("tmux child stderr capture", () => {
  it("reapDeadAgentPanes against a server-less tmux prints nothing to stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tmux-stderr-"));
    try {
      const fakeTmux = join(dir, "tmux");
      writeFileSync(
        fakeTmux,
        "#!/bin/sh\n" +
          "echo 'error connecting to /tmp/tmux-1000/default (No such file or directory)' >&2\n" +
          "exit 1\n",
        { mode: 0o755 },
      );
      const probe =
        `import { reapDeadAgentPanes } from ${JSON.stringify(
          pathToFileURL(join(import.meta.dirname, "../../extensions/subagents/tmux.ts")).href,
        )};\n` + "reapDeadAgentPanes();\n";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      assert.equal(child.status, 0, `probe crashed: ${child.stderr}`);
      assert.equal(
        child.stderr,
        "",
        "tmux child stderr leaked into the parent terminal — " +
          "sync tmux calls must pin stdio so stderr stays captured on the error",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
