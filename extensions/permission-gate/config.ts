/**
 * Permission-gate configuration — one file decides which rules are active.
 *
 * Rules used to be toggled ad-hoc: a couple of bespoke env reads, the
 * native-tool rules piggybacking on the opt-out variables owned by the
 * extensions that provide those tools, and a dozen rules that could not be
 * turned off at all without editing the source. This module makes the whole
 * surface configurable from `config.json` next to this file.
 *
 * Named keys over rule IDs (2026-10-16): the config is read by developers
 * deciding what to switch off, so keys are descriptive (`rerunGuard`) rather
 * than the terse source cross-reference (`R10`). The IDs remain in the module
 * headers and the README rule table for grepping; `RULE_IDS` below is the
 * single place the two vocabularies meet.
 *
 * Precedence (highest first):
 *   1. `PGATE_<SCREAMING_SNAKE_KEY>=0|false` env var, e.g. `PGATE_RERUN_GUARD=0`
 *      or `PGATE_DESTRUCTIVE_CONFIRM=false` — one-off debugging without
 *      editing a tracked file
 *   2. `config.json` `rules.<key>`
 *   3. built-in default (every rule on — the safe state)
 *
 * Fail closed. A missing, unreadable, or malformed config leaves every rule at
 * its default (on) and reports the problem on stderr; it never silently
 * disables enforcement. An unknown key is reported the same way, so a typo
 * (`toolchainPnmp`) is loud instead of a rule that quietly never applies.
 *
 * Scalar knobs (`outputCap`, `confirm`) live beside the
 * switches and validate their own ranges.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Config key → rule ID. The only place the two vocabularies meet; keep in
 * sync with the README rule table and each module's header. */
export const RULE_IDS = {
  editAnchorGuard: "AG",
  editRegionGuard: "AG2",
  reReadGuard: "R1",
  reReadConsume: "R1x",
  largeReadGuard: "R1b",
  locateFirst: "R1c",
  nativeReadFirst: "P1",
  nativeBashFirst: "P2",
  outputCap: "H1",
  readOutputCap: "H1b",
  destructiveConfirm: "H2",
  commitMessageLint: "R9",
  rerunGuard: "R10",
  reblockEscalation: "RB",
  toolchainPnpm: "TC1",
  toolchainNode: "TC2",
  searchScope: "SS1",
  searchMidPipe: "SS2",
  findFirst: "SS3",
  searchPortability: "PB1",
  cadenceNudge: "CN",
  outputScrub: "OS",
} as const;

export type RuleKey = keyof typeof RULE_IDS;

/**
 * ESLint-style severity. `error` blocks the call; `warn` lets the call
 * proceed; `off` skips the rule entirely.
 *
 * The distinction exists because a rule is a *default*, not always an absolute.
 * Preference rules (search hygiene, toolchain pins, re-run, big-read) encode a
 * convention the gate cannot know is wrong for the task at hand, so blocking
 * there buys a certain retry to avoid a speculative saving. Safety rules keep
 * their bite: `HARD_RULES` below cannot be configured below `error`.
 */
export type Severity = "off" | "warn" | "error";

/** Safety rules whose severity is never below `error`, whatever config says. */
export const HARD_RULES: ReadonlySet<RuleKey> = new Set([
  "editAnchorGuard",
  "destructiveConfirm",
  "commitMessageLint",
] as RuleKey[]);

/** Preference rules ship as `warn`: taught, counted, not blocked. */
export const WARN_BY_DEFAULT: ReadonlySet<RuleKey> = new Set([
  "toolchainPnpm",
  "toolchainNode",
  "searchScope",
  "searchMidPipe",
  "findFirst",
  "searchPortability",
  "rerunGuard",
  "largeReadGuard",
] as RuleKey[]);

/** Behavior modifiers that ship OFF: enabling changes what a block DOES
 * rather than whether it fires, so the safe default is inert. */
export const OFF_BY_DEFAULT: ReadonlySet<RuleKey> = new Set([
  "reReadConsume",
] as RuleKey[]);

/** Defaults are fail-closed: active rules block unless demoted above. */
const DEFAULTS: Record<RuleKey, Severity> = Object.fromEntries(
  (Object.keys(RULE_IDS) as RuleKey[]).map((k) => [k, OFF_BY_DEFAULT.has(k) ? "off" : WARN_BY_DEFAULT.has(k) ? "warn" : "error"]),
) as Record<RuleKey, Severity>;

export interface GateConfig {
  rules: Record<RuleKey, Severity>;
  severity: Record<RuleKey, Severity>;
  outputCap: { maxLines: number; maxBytes: number };
  confirm: { timeoutMs: number };

}

/** Redirectable so a test can exercise a config without touching the tracked
 * file. */
const CONFIG_PATH =
  process.env.PGATE_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "config.json");

const DEFAULT_OUTPUT_CAP = { maxLines: 40, maxBytes: 2048 };
const DEFAULT_CONFIRM = { timeoutMs: 300_000 };


function warn(msg: string): void {
  process.stderr.write(`permission-gate config: ${msg}\n`);
}

/**
 * Coerce a config value to a severity, ESLint style: `"off"|"warn"|"error"`
 * or the numeric `0|1|2`. Booleans keep working (`true` → error, `false` → off)
 * so existing configs and `PGATE_<RULE>=0/1` keep their meaning.
 */
function asSeverity(v: unknown, where: string): Severity | undefined {
  if (typeof v === "boolean") return v ? "error" : "off";
  if (v === 0) return "off";
  if (v === 1) return "warn";
  if (v === 2) return "error";
  const s = String(v).trim().toLowerCase();
  if (s === "off" || s === "0" || s === "false" || s === "no") return "off";
  if (s === "warn" || s === "1") return "warn";
  if (s === "error" || s === "2" || s === "true" || s === "on" || s === "yes") return "error";
  warn(`ignoring ${where}=${JSON.stringify(v)} (severity must be off/warn/error or 0/1/2)`);
  return undefined;
}

/** Positive integer within bounds, else undefined (caller keeps the default). */
function asPosInt(v: unknown, where: string, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    warn(`ignoring ${where}=${JSON.stringify(v)} (expected a positive integer ≤ ${max})`);
    return undefined;
  }
  return n;
}

function readConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    warn(`no config.json at ${CONFIG_PATH} — every rule stays at its default (on)`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("config.json must be a JSON object — every rule stays at its default (on)");
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warn(`config.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — every rule stays at its default (on)`);
    return {};
  }
}

function loadGateConfig(): GateConfig {
  const raw = readConfigFile();

  const rules = { ...DEFAULTS };
  const rawRules = raw.rules;

  if (rawRules !== undefined && (rawRules === null || typeof rawRules !== "object" || Array.isArray(rawRules))) {
    warn("`rules` must be an object — every rule stays at its default (on)");
  } else if (rawRules) {
    for (const [key, value] of Object.entries(rawRules as Record<string, unknown>)) {
      if (!(key in RULE_IDS)) {
        warn(`unknown rule "${key}" in config.json — ignored (see RULE_IDS in config.ts for valid keys)`);
        continue;
      }
      const b = asSeverity(value, `rules.${key}`);
      if (b !== undefined) rules[key as RuleKey] = b;
    }
  }

  // Env overrides last: one-off debugging must not require editing a tracked file.
  for (const key of Object.keys(RULE_IDS) as RuleKey[]) {
    const env = process.env[`PGATE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`];
    if (env === undefined) continue;
    const b = asSeverity(env, `PGATE_${key}`);
    if (b !== undefined) rules[key] = b;
  }

  const oc = (raw.outputCap ?? {}) as Record<string, unknown>;
  const cf = (raw.confirm ?? {}) as Record<string, unknown>;

  // Hard rules are clamped: no config value can lower them below `error`.
  const severity = { ...rules };
  for (const key of HARD_RULES) {
    if (severity[key] !== "error") {
      warn(`rule "${key}" is a safety rule and cannot be set to "${severity[key]}" — kept at "error"`);
      severity[key] = "error";
    }
  }

  return {
    rules: severity,
    severity,
    outputCap: {
      maxLines: asPosInt(oc.maxLines, "outputCap.maxLines", 10_000) ?? DEFAULT_OUTPUT_CAP.maxLines,
      maxBytes: asPosInt(oc.maxBytes, "outputCap.maxBytes", 10_000_000) ?? DEFAULT_OUTPUT_CAP.maxBytes,
    },
    confirm: {
      timeoutMs: asPosInt(cf.timeoutMs, "confirm.timeoutMs", 3_600_000) ?? DEFAULT_CONFIRM.timeoutMs,
    },
  };
}

/** Loaded once per process; the gate reads `config.rules.<key>` at each check. */
export const config: GateConfig = loadGateConfig();

/** True when the rule runs at all (warn or error). `ruleEnabled("rerunGuard")`. */
export function ruleEnabled(key: RuleKey): boolean {
  return config.severity[key] !== "off";
}

/** The rule's severity: `off` skips it, `warn` records and proceeds, `error` blocks. */
export function ruleSeverity(key: RuleKey): Severity {
  return config.severity[key];
}

/** True only when the rule should BLOCK (severity `error`). */
export function ruleBlocks(key: RuleKey): boolean {
  return config.severity[key] === "error";
}
