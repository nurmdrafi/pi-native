import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "tests/tools/audit/bin-diff.mjs");

/** A stand-in binary that ignores its args and prints one fixed line. */
function stub(dir, name, out) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
  return path;
}

/** A stand-in daemon: echoes stdin, optionally with a suffix per line. */
function serveStub(dir, name, suffix = "") {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nwhile IFS= read -r l; do echo "$l${suffix}"; done\n`, {
    mode: 0o755,
  });
  return path;
}

async function audit(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [TOOL, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("identical binaries report zero diffs and exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-diff-"));
  try {
    const a = stub(dir, "a.sh", "same");
    const r = await audit(["--old", a, "--new", a, "--args", "{file}"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /diffs=0$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("divergent binaries exit 1 and name the first differing case", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-diff-"));
  try {
    const old = stub(dir, "old.sh", "before");
    const neu = stub(dir, "new.sh", "after");
    const r = await audit(["--old", old, "--new", neu, "--args", "{file}"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /DIFF/);
    assert.match(r.stdout, /diffs=[1-9]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve mode compares the whole response stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bin-diff-"));
  try {
    const reqs = join(dir, "reqs.ndjson");
    writeFileSync(reqs, '{"id":1}\n{"id":2}\n');
    const same = serveStub(dir, "same.sh");
    const ok = await audit(["--old", same, "--new", same, "--serve", reqs]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /serve: identical \(2 response lines\)/);

    const other = serveStub(dir, "other.sh", "-x");
    const bad = await audit(["--old", same, "--new", other, "--serve", reqs]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /serve: DIFFERS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
