#!/usr/bin/env node
/** BASH_ENV nvm bootstrap (2026-10-28): non-interactive daemon shells source
 * scripts/env.sh via BASH_ENV so node resolves without per-command `nvm use`
 * prefixes. Pins three things: the script sources twice silently; a
 * scrubbed-PATH shell resolves node from the nvm tree only with BASH_ENV
 * set; the pibash extension injects the repo default when BASH_ENV is unset
 * and keeps any pre-existing value. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_SH = join(ROOT, "scripts", "env.sh");
const NVM_SH = join(homedir(), ".nvm", "nvm.sh");

test("env.sh sources twice silently (idempotent bootstrap)", () => {
  assert.ok(existsSync(ENV_SH), "scripts/env.sh is the BASH_ENV target");
  const q = JSON.stringify(ENV_SH);
  const r = spawnSync("bash", ["-c", `. ${q}; . ${q}; true`], { encoding: "utf8" });
  assert.equal(r.status, 0, `sourcing must succeed: ${r.stderr}`);
  assert.equal(r.stdout, "", "bootstrap must stay silent on stdout");
  assert.equal(r.stderr, "", "bootstrap must stay silent on stderr");
});

test("scrubbed shell resolves node only through BASH_ENV", { skip: !existsSync(NVM_SH) ? "nvm not installed" : false }, () => {
  const run = (env) =>
    spawnSync("/bin/bash", ["-c", "command -v node || true"], {
      encoding: "utf8",
      // SHLVL: node's spawn path (posix_spawn/vfork) needs it present or the
      // bash child exits 0 without ever running -c; daemon shells always
      // inherit it from the copied parent env.
      env: { HOME: homedir(), SHLVL: "1", ...env },
    });
  // /usr/bin:/bin keeps nvm.sh's shell utilities reachable but holds no
  // node on an nvm-managed machine; a system-node machine still cannot gain
  // the nvm bin dir without the bootstrap, which is what the control pins.
  const bare = run({ PATH: "/usr/bin:/bin" });
  assert.equal(bare.status, 0, `control shell must run: ${bare.stderr}`);
  assert.ok(!bare.stdout.includes(".nvm"), "control: no nvm bin without the bootstrap");
  const withEnv = run({ PATH: "/usr/bin:/bin", BASH_ENV: ENV_SH });
  assert.equal(withEnv.status, 0, `shell must run: ${withEnv.stderr}`);
  assert.match(withEnv.stdout.trim(), /\.nvm/, "node resolves through the nvm tree via BASH_ENV");
});

test("pibash buildEnv defaults BASH_ENV to the repo bootstrap", async () => {
  // The extension imports the SDK package: ensure the global link exists
  // (same preflight idea as the gate harness; create-if-missing, idempotent).
  const pkg = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(join(pkg, "package.json"))) {
    const global = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
    const src = join(global, "@earendil-works", "pi-coding-agent");
    assert.ok(existsSync(src), `global package missing at ${src} — run scripts/bootstrap.sh`);
    mkdirSync(dirname(pkg), { recursive: true });
    symlinkSync(src, pkg, "dir");
  }
  const ext = await import("../../extensions/pibash/index.ts");
  const prev = process.env.BASH_ENV;
  try {
    delete process.env.BASH_ENV;
    assert.equal(ext.buildEnv(undefined).BASH_ENV, ENV_SH, "unset BASH_ENV gets the repo default");
    process.env.BASH_ENV = "/somewhere/else.sh";
    assert.equal(ext.buildEnv(undefined).BASH_ENV, "/somewhere/else.sh", "an existing BASH_ENV wins");
  } finally {
    if (prev === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = prev;
  }
});
