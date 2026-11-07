#!/usr/bin/env node
/** Safe-bash blocklist depth (2026-11-07 audit, LOW): the worker-subagent
 * wrapper missed three pattern families the permission gate already catches
 * (commit 1f4e67c) — defense-in-depth, not the primary control:
 *   1. heredoc-to-sh: a shell interpreter fed by a heredoc runs its body
 *      (`bash <<EOF … EOF`); the body must not count as data.
 *   2. -e interpreter payloads: inline code the blocklist cannot scan
 *      (`node -e`, `python3 -c`, `perl -e`, `node --eval`).
 *   3. redirects into shell rc files: persistence on next shell start
 *      (`echo x > ~/.bashrc`, `>> $HOME/.zshrc`).
 * Blocked cases assert the tool call throws; benign cases prove the wrapper
 * still delegates to the wrapped bash tool (a real cheap echo runs).
 * Run: node --test tests/extensions/safe-bash-depth.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Preflight (same as tests/gate/native-write-first.test.mjs): the
// extension's bare import `@earendil-works/pi-coding-agent` is not in this
// repo's node_modules — symlink the global install.
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const safeBash = (await import("../../extensions/subagents/tools/safe-bash.ts")).default;

/** The registered tool definition, captured through a stub ExtensionAPI. */
let def;
safeBash({ registerTool: (d) => (def = d) });
assert.ok(def, "extension must register a tool");

/** A blocked command throws the wrapper's danger error before any spawn. */
const blocked = (command) =>
  assert.rejects(
    def.execute("t", { command }, undefined, undefined, {}),
    /Command blocked by safe_bash/,
  );

/** A benign command delegates to the wrapped bash tool and its echo returns. */
async function runs(command, expect) {
  const res = await def.execute("t", { command }, undefined, undefined, {});
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(expect), `expected '${expect}' in: ${JSON.stringify(text)}`);
}

// --- family 1: heredoc-to-sh ------------------------------------------------

test("heredoc-to-sh: unquoted sh heredoc is blocked", () =>
  blocked("sh <<EOF\necho pwned\nEOF"));

test("heredoc-to-sh: quoted bash heredoc is blocked", () =>
  blocked("bash <<'EOF'\necho pwned\nEOF"));

test("heredoc-to-sh: tab-indented dash heredoc is blocked", () =>
  blocked("dash <<-END\necho pwned\nEND"));

test("heredoc-to-sh: heredoc into a non-shell command stays allowed", async () => {
  await runs("cat <<'EOF'\nsafe-bash-depth-heredoc-ok\nEOF", "safe-bash-depth-heredoc-ok");
});

// --- family 2: -e interpreter payloads --------------------------------------

test("interpreter -e: node -e payload is blocked", () =>
  blocked("node -e 'require(\"fs\").writeFileSync(\"/tmp/pwn\", \"x\")'"));

test("interpreter -e: node --eval payload is blocked", () =>
  blocked("node --eval 'process.exit(2)'"));

test("interpreter -e: python3 -c payload is blocked", () =>
  blocked("python3 -c 'import os; os.system(\"id\")'"));

test("interpreter -e: perl -e payload is blocked", () =>
  blocked("perl -e 'print 1'"));

test("interpreter -e: plain interpreter runs and -e on non-interpreters stay allowed", async () => {
  await runs("echo node server && echo python3 script && sed -e s/a/b/ <<< qa", "python3 script");
});

// --- family 3: redirects into shell rc files --------------------------------

test("rc redirect: > ~/.bashrc is blocked", () =>
  blocked("echo evil > ~/.bashrc"));

test("rc redirect: >> $HOME/.zshrc is blocked", () =>
  blocked("printf x >> $HOME/.zshrc"));

test("rc redirect: absolute-path .profile target is blocked", () =>
  blocked("echo x > /home/user/.profile"));

test("rc redirect: ordinary files stay allowed", async () => {
  await runs(
    "echo safe-bash-depth-rc-ok > /tmp/safe-bash-depth-ok.txt && cat /tmp/safe-bash-depth-ok.txt",
    "safe-bash-depth-rc-ok",
  );
});
