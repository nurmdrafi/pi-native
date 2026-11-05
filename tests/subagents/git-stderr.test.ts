/**
 * git child stderr must never leak into the parent terminal.
 *
 * Defect under test: same class as the tmux one — execFileSync forwards a
 * failed child's stderr to the parent's own stderr unless stdio is pinned.
 * The subagent result-delivery path runs sync git (files_changed delta,
 * diff) whose failures — not a git repo, stale index lock, timeout kill —
 * would print raw `fatal:` lines straight into the user's terminal even
 * though every consumer treats git failure as fail-soft.
 *
 * Contract under test: both sync git runners capture the child's stderr
 * instead of inheriting it — inbox's runGitSync (reached through
 * computeFilesChanged's default) and the delivery path's boundedGitSync.
 * Each is verified end to end: a probe child process runs it against a
 * fake git that fails like a missing repo; the probe must exit 0 with
 * empty stderr.
 */
import "./test-env.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { __test__ } from "../../extensions/subagents/index.ts";

function moduleUrl(rel: string): string {
  return pathToFileURL(join(import.meta.dirname, rel)).href;
}

/** Spawn a probe child running `bodyTemplate` (with %DIR% = temp dir JSON)
 *  against a fake git that fails like a missing repo, and assert the child
 *  exits 0 with empty stderr. */
function probeWithFailingGit(bodyTemplate: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-stderr-"));
  try {
    writeFileSync(
      join(dir, "git"),
      "#!/bin/sh\n" +
        "echo 'fatal: not a git repository (or any of the parent directories): .git' >&2\n" +
        "exit 1\n",
      { mode: 0o755 },
    );
    const body = bodyTemplate.split("%DIR%").join(JSON.stringify(dir));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(child.status, 0, `probe crashed: ${child.stderr}`);
    assert.equal(
      child.stderr,
      "",
      "git child stderr leaked into the parent terminal — " +
        "sync git calls must pin stdio so stderr stays captured on the error",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("git child stderr capture", () => {
  it("computeFilesChanged's default sync runner prints nothing to stderr", () => {
    probeWithFailingGit(
      'import { writeFileSync } from "node:fs";\n' +
        `import { computeFilesChanged } from ${JSON.stringify(
          moduleUrl("../../extensions/subagents/inbox.ts"),
        )};\n` +
        'const dir = %DIR%;\n' +
        'const baseline = dir + "/baseline.json";\n' +
        'writeFileSync(baseline, JSON.stringify({ repoRoot: dir, porcelain: "" }));\n' +
        "computeFilesChanged(baseline);\n",
    );
  });

  it("boundedGitSync (delivery path) prints nothing to stderr", () => {
    assert.equal(
      typeof __test__.boundedGitSync,
      "function",
      "boundedGitSync must stay exposed on __test__",
    );
    probeWithFailingGit(
      `import { __test__ } from ${JSON.stringify(
        moduleUrl("../../extensions/subagents/index.ts"),
      )};\n` + 'try { __test__.boundedGitSync(["status"]); } catch {}\n',
    );
  });
});
