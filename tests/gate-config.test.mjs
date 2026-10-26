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
const DESTRUCTIVE_TS = join(GATE_DIR, "destructive.ts");

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

/** Parse a `new Set([ "key", ... ])` rule-set literal out of config.ts —
 * same no-import trick as ruleKeysFromSource, so tests track the source sets
 * (HARD_RULES / WARN_BY_DEFAULT / OFF_BY_DEFAULT) without jiti. Empty sets
 * are valid (OFF_BY_DEFAULT is empty since the 2026-10-26 R1x revival). */
function ruleSetFromSource(name) {
  const src = readFileSync(PANEL, "utf8");
  const block = src.match(new RegExp(`export const ${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\] as RuleKey\\[\\]\\)`));
  assert.ok(block, `${name} set not found in config.ts`);
  return [...block[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

/** Evaluate an arbitrary snippet against the loader module in a child
 * process — env overrides and PGATE_CONFIG apply at import time, so an
 * in-process import would be polluted by this file's own environment. */
function runLoader(script, env = {}) {
  const res = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) throw new Error(`config load failed: ${res.stderr}`);
  return { ...JSON.parse(res.stdout), stderr: res.stderr };
}

/** Write an exact config file body — possibly malformed JSON, possibly not
 * even an object — and load against it. The fail-closed contract must hold
 * against garbage, not just valid files. */
function loadConfigBody(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pgate-cfg-"));
  const file = join(dir, "config.json");
  writeFileSync(file, body);
  const script = `
    import { config, RULE_IDS } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({ config, ids: RULE_IDS }));
  `;
  return runLoader(script, { PGATE_CONFIG: file, ...env });
}

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
  const inert = ruleSetFromSource("OFF_BY_DEFAULT");
  const off = Object.entries(config.severity).filter(([, v]) => v === "off").map(([k]) => k);
  assert.deepEqual(off, inert, `only OFF_BY_DEFAULT rules may ship off; off: ${off.join(", ")}`);
});

test("env override disables exactly one rule", () => {
  const { config } = loadConfig({ PGATE_RERUN_GUARD: "0" });
  assert.equal(config.severity.rerunGuard, "off", "PGATE_RERUN_GUARD=0 should disable rerunGuard");
  const inert = new Set(ruleSetFromSource("OFF_BY_DEFAULT"));
  const others = Object.entries(config.severity).filter(([k, v]) => k !== "rerunGuard" && v === "off" && !inert.has(k));
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

// ---- fail-closed: a broken config must never weaken a rule --------------

test("missing config file: every rule at its default, warning on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgate-cfg-"));
  const script = `
    import { config } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({ sev: config.severity.rerunGuard }));
  `;
  const res = runLoader(script, { PGATE_CONFIG: join(dir, "absent.json") });
  assert.equal(res.sev, "warn", "a missing redirected config must fall back to built-in defaults");
  assert.match(res.stderr, /no config\.json/, "a missing redirected config must be reported");
});

test("malformed JSON config: every rule at its default, warning on stderr", () => {
  const res = loadConfigBody('{ "rules": { "rerunGuard": "of');
  assert.equal(res.config.severity.rerunGuard, "warn", "parse failure must fall back to built-in defaults");
  assert.match(res.stderr, /not valid JSON/);
});

test("non-object config (array, scalar, string): rejected with a warning", () => {
  for (const body of ["[1,2,3]", "42", '"nope"']) {
    const res = loadConfigBody(body);
    assert.equal(res.config.severity.rerunGuard, "warn", `body ${body} must not configure anything`);
    assert.match(res.stderr, /must be a JSON object/);
  }
});

test("`rules` section that is not an object is ignored with a warning", () => {
  const res = loadConfigBody(JSON.stringify({ rules: 42 }));
  assert.equal(res.config.severity.rerunGuard, "warn");
  assert.match(res.stderr, /`rules` must be an object/);
});

// ---- precedence: env > config.json > built-in default --------------------

test("env var beats config.json — the documented precedence, both directions", () => {
  const down = loadConfig({ PGATE_RERUN_GUARD: "0" }, { rules: { rerunGuard: "error" } });
  assert.equal(down.config.severity.rerunGuard, "off", "PGATE_RERUN_GUARD=0 must beat rules.rerunGuard: error");
  const up = loadConfig({ PGATE_RERUN_GUARD: "2" }, { rules: { rerunGuard: "off" } });
  assert.equal(up.config.severity.rerunGuard, "error", "PGATE_RERUN_GUARD=2 must beat rules.rerunGuard: off");
});

test("built-in defaults: OFF_BY_DEFAULT off, WARN_BY_DEFAULT warn, rest error", () => {
  const { config, stderr } = loadConfigBody("{}"); // nothing configured: pure built-ins
  const off = ruleSetFromSource("OFF_BY_DEFAULT");
  const warn = ruleSetFromSource("WARN_BY_DEFAULT");
  for (const { key } of KEYS) {
    const want = off.includes(key) ? "off" : warn.includes(key) ? "warn" : "error";
    assert.equal(config.severity[key], want, `built-in default for ${key}`);
  }
  // Absent optional sections (outputCap/confirm) are not problems: nothing
  // may be "ignored" when the file simply does not mention them.
  assert.doesNotMatch(stderr, /ignoring/, "absent optional sections must not warn");
});

test("safety rules cannot be demoted by env either", () => {
  const res = loadConfig({
    PGATE_DESTRUCTIVE_CONFIRM: "0",
    PGATE_EDIT_ANCHOR_GUARD: "warn",
    PGATE_COMMIT_MESSAGE_LINT: "off",
  });
  for (const key of ruleSetFromSource("HARD_RULES")) {
    assert.equal(res.config.severity[key], "error", `${key} must stay error under env demotion`);
  }
  assert.match(res.stderr, /safety rule/, "demotion attempts must be reported");
});

test("camelCase key → PGATE_SCREAMING_SNAKE (multi-boundary keys)", () => {
  const a = loadConfig({ PGATE_RE_READ_GUARD: "0" });
  assert.equal(a.config.severity.reReadGuard, "off", "reReadGuard → PGATE_RE_READ_GUARD");
  const b = loadConfig({ PGATE_LARGE_READ_GUARD: "0" });
  assert.equal(b.config.severity.largeReadGuard, "off", "largeReadGuard → PGATE_LARGE_READ_GUARD");
});

test("outputCap/confirm: valid overrides apply, garbage keeps documented defaults", () => {
  const good = loadConfigBody(JSON.stringify({ outputCap: { maxLines: 7 }, confirm: { timeoutMs: 1234 } }));
  assert.equal(good.config.outputCap.maxLines, 7);
  assert.equal(good.config.confirm.timeoutMs, 1234);
  const bad = loadConfigBody(JSON.stringify({ outputCap: { maxLines: "lots" }, confirm: { timeoutMs: -5 } }));
  assert.equal(bad.config.outputCap.maxLines, 40, "documented default maxLines");
  assert.equal(bad.config.confirm.timeoutMs, 300000, "documented default timeoutMs");
  assert.match(bad.stderr, /positive integer/, "rejected overrides must be reported");
});

test("ruleEnabled/ruleBlocks expose the warn-vs-error distinction", () => {
  const script = `
    import { ruleEnabled, ruleBlocks } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({
      warn: [ruleEnabled("rerunGuard"), ruleBlocks("rerunGuard")],
      error: [ruleEnabled("editAnchorGuard"), ruleBlocks("editAnchorGuard")],
    }));
  `;
  const res = runLoader(script);
  assert.deepEqual(res.warn, [true, false], "warn: runs but does not block");
  assert.deepEqual(res.error, [true, true], "error: runs and blocks");
  // off row moved to env: reReadConsume no longer ships off (2026-10-26)
  const off = runLoader(`
    import { ruleEnabled, ruleBlocks } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({
      off: [ruleEnabled("reReadConsume"), ruleBlocks("reReadConsume")],
    }));
  `, { PGATE_RE_READ_CONSUME: "0" });
  assert.deepEqual(off.off, [false, false], "off: skipped entirely");
});

test("reReadConsume ships warn: enabled, non-blocking (R1x note tier)", () => {
  const script = `
    import { ruleEnabled, ruleBlocks } from ${JSON.stringify(PANEL)};
    process.stdout.write(JSON.stringify({
      d: [ruleEnabled("reReadConsume"), ruleBlocks("reReadConsume")],
    }));
  `;
  const res = runLoader(script);
  assert.deepEqual(res.d, [true, false], "R1x default = warn (note, no block)");
});

test("R1x error tier: PGATE_RE_READ_CONSUME=2 blocks a >=50% overlap re-read at call time", () => {
  const dir = mkdtempSync(join(tmpdir(), "r1x-err-"));
  const f = join(dir, "f.md");
  writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const INDEX = join(GATE_DIR, "index.ts");
  const script = `
    const f = ${JSON.stringify(f)};
    const lists = new Map();
    const pi = {
      on: (event, handler) => {
        const l = lists.get(event) ?? [];
        l.push(handler);
        lists.set(event, l);
      },
      invoke: async (event, ev) => {
        let result;
        for (const h of lists.get(event) ?? []) {
          const r = await h(ev, ev);
          if (r !== undefined) result = r;
        }
        return result;
      },
    };
    const gate = (await import(${JSON.stringify(INDEX)})).default;
    gate(pi);
    const body = Array.from({ length: 40 }, (_, i) => \`line \${i + 1}\`).join("\\n");
    const cycle = async (id, offset) => {
      const input = { path: f, offset, limit: 40 };
      const block = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "piread", toolCallId: id, input,
      });
      if (block) return { block, res: undefined };
      const res = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "piread", toolCallId: id, input,
        content: [{ type: "text", text: body }],
        details: { truncation: { truncated: false, outputLines: 40, totalLines: 100 } },
        isError: false,
      });
      return { block: undefined, res };
    };
    const one = await cycle("e1", 10);
    const two = await cycle("e2", 30); // 20/40 = 50% overlap with 10–49
    process.stdout.write(JSON.stringify({
      firstBlocked: !!one.block, secondBlocked: !!two.block,
      reason: two.block?.reason?.slice(0, 120) ?? null,
    }));
  `;
  const res = runLoader(script, { PGATE_RE_READ_CONSUME: "2" });
  assert.equal(res.firstBlocked, false, "first read must pass");
  assert.equal(res.secondBlocked, true, "error tier must block the >=50% overlap re-read");
  assert.match(res.reason ?? "", /Re-read/, "block must carry the Re-read family");
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

// ---- 1a — managed destructive command list (2026-10-26) ----
// config.json `destructive.remove` / `destructive.extra` manage which
// commands the H2 confirm set covers without regex surgery in destructive.ts.
// Matcher behavior is asserted in a subprocess: PGATE_CONFIG applies at import
// time, so an in-process import would be polluted by this file's environment.
function loadDestructive(section, probes) {
  const dir = mkdtempSync(join(tmpdir(), "pgate-destr-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ destructive: section }));
  const script = `
    import { segmentDestructive, confirmEntryIds } from ${JSON.stringify(DESTRUCTIVE_TS)};
    process.stdout.write(JSON.stringify({
      ids: confirmEntryIds(),
      probe: ${JSON.stringify(probes)}.map((c) => segmentDestructive(c)),
    }));
  `;
  return runLoader(script, { PGATE_CONFIG: file });
}

test("destructive.remove drops entries by id (brew-install)", () => {
  const { ids, probe } = loadDestructive(
    { remove: ["brew-install"] },
    ["brew install ripgrep", "rm -f /tmp/x"],
  );
  assert.ok(!ids.includes("brew-install"), "brew-install still in entry ids");
  assert.equal(probe[0], false, "brew install must no longer confirm");
  assert.equal(probe[1], true, "rm must still confirm");
});

test("destructive.extra adds a managed entry (docker rm)", () => {
  const { ids, probe } = loadDestructive(
    { extra: [{ id: "docker-rm", pattern: "docker\\s+rm\\b" }] },
    ["docker rm -f pg1", "docker ps"],
  );
  assert.ok(ids.includes("docker-rm"), "extra entry missing from ids");
  assert.equal(probe[0], true, "docker rm must confirm");
  assert.equal(probe[1], false, "docker ps must pass");
});

test("unknown remove ids warn and are ignored", () => {
  const { ids, probe, stderr } = loadDestructive(
    { remove: ["no-such-entry"] },
    ["rm -f /tmp/x"],
  );
  assert.match(stderr, /no-such-entry/, "no warning for unknown id");
  assert.ok(ids.includes("rm"), "builtin rm vanished");
  assert.equal(probe[0], true, "rm must still confirm");
});

test("malformed extra entries are skipped with a warning, set intact", () => {
  const { probe, stderr } = loadDestructive(
    { extra: [{ id: "bad-paren", pattern: "(" }] },
    ["rm -f /tmp/x", "docker rm x"],
  );
  assert.match(stderr, /bad-paren/, "no warning for malformed pattern");
  assert.equal(probe[0], true, "builtin set must stay intact");
  assert.equal(probe[1], false, "broken extra must not match everything");
});
