import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  config,
  parseProjectTrustMode,
  projectTrustMode,
} from "../../extensions/permission-gate/loader.ts";
import { freshGate } from "../gate/harness/stub.mjs";

/** Startup project-trust ask: pi-core emits `project_trust` before loading a
 * project's .pi/ resources and asks the user unless an extension answers.
 * The gate answers for the user when config.json says `"projectTrust":
 * "auto"` — no ask, nothing remembered to disk (the vendor trust.json store
 * stays gone; every run decides fresh in-process). Anything else — key
 * missing, misspelled, or PGATE_PROJECT_TRUST=ask — fails closed to asking.
 * Not a rule severity: it gates a startup ask, not a tool call. */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOADER = join(ROOT, "extensions", "permission-gate", "loader.ts");

/** Evaluate the loader in a child process so env overrides and throwaway
 * configs apply cleanly (same pattern as tests/gate/config.test.mjs). */
function loadMode(env = {}, extraConfig = undefined) {
  let cfgEnv = {};
  if (extraConfig !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), "pgate-trust-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(extraConfig));
    cfgEnv = { PGATE_CONFIG: file };
  }
  const script = `
    import { projectTrustMode } from ${JSON.stringify(LOADER)};
    process.stdout.write(projectTrustMode());
  `;
  const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...cfgEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) throw new Error(`config load failed: ${res.stderr}`);
  return res.stdout.trim();
}

test("parseProjectTrustMode: only an explicit affirmative means auto; everything else asks", () => {
  assert.equal(parseProjectTrustMode("auto"), "auto");
  assert.equal(parseProjectTrustMode("AUTO"), "auto");
  assert.equal(parseProjectTrustMode(true), "auto");
  assert.equal(parseProjectTrustMode(undefined), "ask");
  assert.equal(parseProjectTrustMode("ask"), "ask");
  assert.equal(parseProjectTrustMode(false), "ask");
  // garbage warns on stderr and fails closed to asking
  assert.equal(parseProjectTrustMode("garbage"), "ask");
});

test("shipped config.json answers the startup trust ask automatically", () => {
  assert.equal(config.projectTrust, "auto");
  assert.equal(projectTrustMode(), "auto");
});

test("missing or malformed projectTrust asks (fail closed)", () => {
  assert.equal(loadMode({}, {}), "ask");
  assert.equal(loadMode({}, { projectTrust: "garbage" }), "ask");
});

test("PGATE_PROJECT_TRUST overrides the file value in both directions", () => {
  assert.equal(loadMode({ PGATE_PROJECT_TRUST: "ask" }), "ask");
  assert.equal(loadMode({ PGATE_PROJECT_TRUST: "auto" }, { projectTrust: "ask" }), "auto");
});

test("the gate answers pi-core's project_trust event yes, remembering nothing", async () => {
  const pi = freshGate();
  const answer = await pi.invoke("project_trust", { type: "project_trust", cwd: "/tmp/anywhere" }, {});
  assert.deepEqual(answer, { trusted: "yes", remember: false });
});
