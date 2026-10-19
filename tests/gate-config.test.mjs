#!/usr/bin/env node
/**
 * Config contract tests for the permission-gate rule switches.
 *
 * The gate now reads its on/off state from `config.json`. Two failure modes
 * are silent and dangerous, so both are pinned here:
 *
 *   1. a config key with no matching rule (typo like `toolchainPnmp`) would
 *      never apply — the loader must warn, not swallow it;
 *   2. a rule whose key is missing from `config.json` would silently fall back
 *      to the default — acceptable, but the default itself must always be ON
 *      (fail closed), never off.
 *
 * Also locks the env-override precedence: `PGATE_<KEY>=0` beats the file.
 *
 * Run: node --test tests/gate-config.test.mjs   (exit 0 = all pass)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_DIR = join(ROOT, "extensions", "permission-gate");
const CONFIG_JSON = join(GATE_DIR, "config.json");
const PANEL = join(GATE_DIR, "config.ts");

/** Read RULE_IDS keys without importing the TS module (no jiti dependency). */
function ruleKeysFromSource() {
  const src = readFileSync(PANEL, "utf8");
  const block = src.match(/export const RULE_IDS = \{([\s\S]*?)\} as const;/);
  assert.ok(block, "RULE_IDS block not found in config.ts");
  const keys = [...block[1].matchAll(/^\s*(\w+):\s*"([^"]+)",/gm)].map((m) => ({ key: m[1], id: m[2] }));
  assert.ok(keys.length > 0, "no rule keys parsed from RULE_IDS");
  return keys;
}

/** Evaluate the loader in a child process so env overrides apply cleanly.
 * `rules` (when given) is written to a throwaway config.json so a test can
 * exercise a rule value without touching the tracked file. */
function loadConfig(env = {}, rules) {
  let settingsEnv = {};
  if (rules !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), "pgate-cfg-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ rules }, null, 2));
    settingsEnv = { PGATE_CONFIG: file };
  }
  const script = `
    import { config, RULE_IDS } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({ config, ids: RULE_IDS }));
  `;
  const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...settingsEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) throw new Error(`config load failed: ${res.stderr}`);
  return { ...JSON.parse(res.stdout), stderr: res.stderr };
}

const KEYS = ruleKeysFromSource();

test("every RULE_IDS key is present in config.json", () => {
  const raw = JSON.parse(readFileSync(CONFIG_JSON, "utf8"));
  const missing = KEYS.map((k) => k.key).filter((k) => !(k in (raw.rules ?? {})));
  assert.deepEqual(missing, [], `config.json is missing rule keys: ${missing.join(", ")}`);
});

test("config.json has no unknown rule keys (catches typos)", () => {
  const raw = JSON.parse(readFileSync(CONFIG_JSON, "utf8"));
  const known = new Set(KEYS.map((k) => k.key));
  const unknown = Object.keys(raw.rules ?? {}).filter((k) => !known.has(k));
  assert.deepEqual(unknown, [], `config.json has keys with no matching rule: ${unknown.join(", ")}`);
});

test("rule IDs are unique", () => {
  const ids = KEYS.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule IDs: ${ids.join(", ")}`);
});

test("defaults are fail-closed: every rule on", () => {
  const { config } = loadConfig();
  // Fail closed = every rule runs at least as `warn`. Only explicit config
  // lowers one to `off`.
  const off = Object.entries(config.severity).filter(([, v]) => v === "off").map(([k]) => k);
  assert.deepEqual(off, [], `rules defaulting to off: ${off.join(", ")}`);
});

test("env override disables exactly one rule", () => {
  const { config } = loadConfig({ PGATE_RERUN_GUARD: "0" });
  assert.equal(config.severity.rerunGuard, "off", "PGATE_RERUN_GUARD=0 should disable rerunGuard");
  const others = Object.entries(config.severity).filter(([k, v]) => k !== "rerunGuard" && v === "off");
  assert.deepEqual(others, [], "env override must not affect other rules");
});

test("env override accepts 2 to raise a rule to blocking severity", () => {
  const { config } = loadConfig({ PGATE_RERUN_GUARD: "2" });
  assert.equal(config.severity.rerunGuard, "error");
});

test("rejected scalar falls back to the documented default", () => {
  const { config } = loadConfig();
  assert.ok(Number.isInteger(config.outputCap.maxLines) && config.outputCap.maxLines > 0);
  assert.ok(Number.isInteger(config.confirm.timeoutMs) && config.confirm.timeoutMs > 0);
});

// ---- ESLint-style severity: off / warn / error --------------------------
// A rule is a default, not always an absolute: preference rules (search
// hygiene, toolchain pins, re-run, big-read) should teach without costing a
// retry. `error` blocks, `warn` records and proceeds, `off` is silent.

test("severity strings parse like ESLint (off/warn/error)", () => {
  // One child per row is wasteful and fragile; drive the whole matrix in a
  // single process by rewriting a throwaway config between loads.
  const dir = mkdtempSync(join(tmpdir(), "pgate-cfg-"));
  const file = join(dir, "config.json");
  const script = `
    import { readFileSync } from "node:fs";
    const cfgPath = process.env.PGATE_CONFIG;
    const out = {};
    const rows = ["off", "warn", "error", 0, 1, 2, false, true];
    for (const value of rows) {
      const fs = await import("node:fs");
      fs.writeFileSync(cfgPath, JSON.stringify({ rules: { rerunGuard: value } }));
      const mod = await import(${JSON.stringify(PANEL)} + "?v=" + encodeURIComponent(String(value)));
      out[JSON.stringify(value)] = mod.config.severity.rerunGuard;
    }
    process.stdout.write(JSON.stringify(out));
  `;
  writeFileSync(file, "{}");
  const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PGATE_CONFIG: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  const got = JSON.parse(res.stdout);
  const expected = {
    '"off"': "off",
    '"warn"': "warn",
    '"error"': "error",
    "0": "off",
    "1": "warn",
    "2": "error",
    "false": "off",
    "true": "error",
  };
  assert.deepEqual(got, expected);
});

test("an invalid severity keeps the rule at its default and warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgate-cfg-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ rules: { rerunGuard: "loud" } }));
  const script = `
    import { config } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({ sev: config.severity.rerunGuard }));
  `;
  const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PGATE_CONFIG: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  // rerunGuard is a preference rule, so its DEFAULT is `warn`, not `error`.
  assert.equal(JSON.parse(res.stdout).sev, "warn", "fallback is the rule's default severity");
  assert.match(res.stderr, /severity/i, "a bad value must be reported, not silently ignored");
});

test("PGATE_<RULE> env var accepts a severity too", () => {
  const { config } = loadConfig({ PGATE_RERUN_GUARD: "warn" });
  assert.equal(config.severity.rerunGuard, "warn");
});

test("safety rules cannot be configured away", () => {
  const { config } = loadConfig({}, { rules: { editAnchorGuard: "off", destructiveConfirm: "off" } });
  assert.equal(config.severity.editAnchorGuard, "error", "anchor guard must not be disableable by config");
  assert.equal(config.severity.destructiveConfirm, "error", "destructive confirm must not be disableable");
});

test("rule IDs match the documented README rule table", () => {
  const readme = readFileSync(join(ROOT, "extensions", "README.md"), "utf8");
  // Every config key's ID should appear somewhere in the README rule catalog,
  // so a rule cannot be configurable yet undocumented.
  const missing = KEYS.filter(({ id }) => !new RegExp(`\\b${id}\\b`).test(readme)).map(({ key, id }) => `${key}/${id}`);
  assert.deepEqual(missing, [], `rules absent from extensions/README.md: ${missing.join(", ")}`);
});
