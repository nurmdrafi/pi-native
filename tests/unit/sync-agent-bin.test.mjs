import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shellRcCandidates,
  pathPinBlock,
  pinnedBinDirs,
  missingPinnedDirs,
  hasPathPin,
  shDoubleQuoted,
  resolveAgentDir,
  sync,
} from "../../scripts/sync-agent-bin.mjs";

const BIN = "/opt/agent/bin";

test("shell rc candidates cover zsh and bash on macOS and Linux", () => {
  const rc = shellRcCandidates();
  for (const f of [".zshenv", ".zshrc", ".bashrc", ".profile"]) {
    assert.ok(rc.includes(f), `missing ${f}`);
  }
});

test("zsh prefers .zshenv so non-interactive shells see the pin", () => {
  assert.equal(shellRcCandidates("zsh")[0], ".zshenv");
});

test("bash prefers .bashrc", () => {
  assert.equal(shellRcCandidates("bash")[0], ".bashrc");
});

test("unknown shell falls back to the portable list", () => {
  assert.deepEqual(shellRcCandidates("fish"), shellRcCandidates());
});

test("the pin block is POSIX sh, not bash-only", () => {
  const block = pathPinBlock(BIN);
  assert.match(block, /\bcase\b/, "must use POSIX case");
  assert.doesNotMatch(block, /\[\[/, "no bash-only [[ ]]");
});

test("the pin block is idempotent: re-sourcing does not duplicate the entry", () => {
  assert.match(pathPinBlock(BIN), /\*":\/opt\/agent\/bin:"\*\)/, "needs a duplicate guard");
});

test("a pin for a directory that no longer exists is reported, not left to shadow", () => {
  // A bench run pins bench/pi-homes/*/bin, then the bench dir is deleted. The
  // stale entry sits ABOVE the live one in PATH, so `rg`/`piread` resolve to
  // whatever that dead slot leaves visible. The check must name it.
  const stale = [
    `case ":$PATH:" in`,
    `  *":/gone/bench/bin:"*) ;;`,
    `  *) PATH="/gone/bench/bin:$PATH"; export PATH ;;`,
    `esac`,
    ``,
    pathPinBlock(BIN),
  ].join("\n");
  const dirs = pinnedBinDirs(stale);
  assert.deepEqual(dirs, ["/gone/bench/bin", "/opt/agent/bin"], stale);
  const dead = missingPinnedDirs(stale, (p) => p === BIN);
  assert.deepEqual(dead, ["/gone/bench/bin"], "the dead pin must be surfaced");
});

test("pin parsing is OS- and shell-agnostic", () => {
  // The parser scans rc text and never invokes a shell, so zsh/bash on macOS
  // and Linux read identically. Both quote styles and paths with spaces parse.
  const rc = [
    `case ":$PATH:" in`,
    `  *":/srv/agent/bin:"*) ;;`,
    `  *) PATH="/srv/agent/bin:$PATH"; export PATH ;;`,
    `esac`,
    `case ":$PATH:" in`,
    `  *"/a b/bin:"*) ;;`,
    `  *) PATH='/a b/bin':$PATH; export PATH ;;`,
    `esac`,
  ].join("\n");
  assert.deepEqual(pinnedBinDirs(rc), ["/srv/agent/bin", "/a b/bin"]);
  assert.deepEqual(missingPinnedDirs(rc, () => false), ["/srv/agent/bin", "/a b/bin"]);
  assert.deepEqual(missingPinnedDirs(rc, () => true), []);
  assert.deepEqual(pinnedBinDirs(""), []);
  assert.deepEqual(pinnedBinDirs(undefined), []);
});

test("the pin block embeds the given dir, never a hardcoded home path", () => {
  const block = pathPinBlock("/srv/custom/agent/bin");
  assert.ok(block.includes("/srv/custom/agent/bin"));
  assert.doesNotMatch(block, /\.pi\/agent/, "must not assume ~/.pi/agent");
  assert.doesNotMatch(block, /\$HOME/, "must not assume a home-relative layout");
});

test("a dir with spaces stays one PATH entry (no quoting inside the word)", () => {
  const block = pathPinBlock("/a b/bin");
  assert.ok(block.includes('PATH="/a b/bin:$PATH"'), block);
  assert.doesNotMatch(block, /'/, "single quotes would be literal here");
});

test("shDoubleQuoted escapes only what is special in double quotes", () => {
  assert.equal(shDoubleQuoted("/a/b"), "/a/b");
  assert.equal(shDoubleQuoted("/a$b"), "/a\\$b");
  assert.equal(shDoubleQuoted('/a"b'), '/a\\"b');
});

test("resolveAgentDir honours PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/srv/agent" }), "/srv/agent");
});

test("resolveAgentDir falls back to a home-relative default", () => {
  const d = resolveAgentDir({});
  assert.ok(d.endsWith(join(".pi", "agent")), `unexpected default: ${d}`);
});

test("hasPathPin detects an existing pin for the given dir", () => {
  assert.equal(hasPathPin(pathPinBlock(BIN), BIN), true);
  assert.equal(hasPathPin(`export PATH=${BIN}:$PATH`, BIN), true);
  assert.equal(hasPathPin("export PATH=/usr/bin:$PATH", BIN), false);
  assert.equal(hasPathPin("", BIN), false);
});

test("hasPathPin tolerates a non-string", () => {
  assert.equal(hasPathPin(undefined, BIN), false);
  assert.equal(hasPathPin(null, BIN), false);
});

test("a fresh machine with no rc file still gets a pin (.profile is created)", () => {
  const empty = mkdtempSync(join(tmpdir(), "syncbin-"));
  const rcPath = join(empty, ".profile");
  assert.equal(existsSync(rcPath), false);
  const r = sync({ home: empty, shell: "bash", agentDir: join(empty, "agent") });
  assert.ok(existsSync(rcPath), ".profile must be created");
  assert.ok(hasPathPin(readFileSync(rcPath, "utf8"), join(empty, "agent", "bin")));
  assert.ok(r.changes.some((c) => c.kind === "shell-path" && c.status === "fixed"));
  rmSync(empty, { recursive: true, force: true });
});

test("sync does not duplicate an existing pin", () => {
  const home = mkdtempSync(join(tmpdir(), "syncbin-"));
  const agentDir = join(home, "agent");
  writeFileSync(join(home, ".bashrc"), pathPinBlock(join(agentDir, "bin")), "utf8");
  const r = sync({ home, shell: "bash", agentDir });
  assert.ok(r.changes.some((c) => c.kind === "shell-path" && c.status === "ok"));
  const text = readFileSync(join(home, ".bashrc"), "utf8");
  assert.equal((text.match(/^\s*\*\) PATH=/gm) || []).length, 1, "one pin entry");
  rmSync(home, { recursive: true, force: true });
});

test("sync uses the injected agent dir for binary checks", () => {
  const home = mkdtempSync(join(tmpdir(), "syncbin-"));
  const agentDir = join(home, "nested", "agent");
  const r = sync({ home, shell: "bash", agentDir });
  const missing = r.problems.filter((p) => ["piread", "piedit", "pibash", "pidx"].includes(p.kind));
  assert.equal(missing.length, 4, "all four binaries should be reported missing");
  rmSync(home, { recursive: true, force: true });
});
