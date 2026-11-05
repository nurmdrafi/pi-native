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
 * single place the two vocabularies meet. Either spelling is accepted in
 * `rules` (`BY_ID` resolves IDs); env overrides stay key-named.
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

import { BASH_CAP_BYTES, BASH_CAP_LINES } from "./bounds.gen.ts";

/** Config key → rule ID. The only place the two vocabularies meet; keep in
 * sync with the README rule table, the `docs` table in config.json, and each
 * module's header. */
export const RULE_IDS = {
  /** Edits (anchor) — AG: edit blocked when `oldText` misses (exact+fuzzy),
   *  the anchor is non-unique, or anchors overlap within one call. */
  editAnchorGuard: "AG",
  /** Edits (region) — AG2: an edit's target lines must themselves have been
   *  read; "off" downgrades to path-read-this-session parity. */
  editRegionGuard: "AG2",
  /** Writes (binding) — WB: overwrite of an existing file binds like an edit
   *  — never-read, stat drift, or hash drift blocks with a re-read fix. */
  writeBindingGuard: "WB",
  /** Reads (re-read) — R1: a re-read fully covered by certified spans
   *  blocks; partial overlap passes. Resets on compaction/failed edits. */
  reReadGuard: "R1",
  /** Reads (consume) — R1x: ≥50% of a read's rendered lines already
   *  certified — "warn" notes, "error" blocks at call time, "off" disables. */
  reReadConsume: "R1x",
  /** Reads (large window) — R1b: whole-file or ≥500-line read of a >10KB
   *  file blocks with a targeted-window fix. */
  largeReadGuard: "R1b",
  /** Reads (locate-first) — R1c: ≥100-line window on a never-searched path
   *  blocks with the search to run first. */
  locateFirst: "R1c",
  /** Hygiene (native read) — P1: built-in read blocked while piread is
   *  registered; "off" restores the built-in. */
  nativeReadFirst: "P1",
  /** Hygiene (native bash) — P2: built-in bash blocked while pibash is
   *  registered; "off" restores the built-in. */
  nativeBashFirst: "P2",
  /** Hygiene (native write) — P3: built-in write blocked while piwrite is
   *  registered; "off" restores the built-in. */
  nativeWriteFirst: "P3",
  /** Bash (output cap) — H1: non-blocking; output capped at 40 lines / 2KB,
   *  full text spilled to $TMPDIR/pgate-spill with a pointer. */
  outputCap: "H1",
  /** Reads (output cap) — H1b: non-blocking; read results over 300 lines /
   *  8KB truncate to head, full text spilled. */
  readOutputCap: "H1b",
  /** Bash (destructive confirm) — H2: sudo/rm/forced git/package installs/
   *  DB drops need approval; safety floor — cannot configure below "error". */
  destructiveConfirm: "H2",
  /** Git (commit lint) — R9: `git commit -m` checked against the commitlint
   *  pattern; safety floor — cannot configure below "error". */
  commitMessageLint: "R9",
  /** Bash (re-run) — R10: identical re-run ≤10 min after its last success
   *  with no intervening mutation blocks; watchers and retries exempt. */
  rerunGuard: "R10",
  /** Bash (reblock) — RB: verbatim re-send of a just-blocked command
   *  escalates with a dedicated reason. */
  reblockEscalation: "RB",
  /** Toolchain (pnpm pin) — TC1: npm/npx/yarn in a pnpm-pinned repo blocks;
   *  use `pnpm run`/`exec`/`dlx`. */
  toolchainPnpm: "TC1",
  /** Toolchain (node pin) — TC2: node-family binary missing the exact
   *  `.nvmrc`/`engines` pin warns; prefix `nvm use <pin> &&`. */
  toolchainNode: "TC2",
  /** Search (scope) — SS1: recursive grep/rg with no path or glob scope
   *  blocks; scope it (`rg PATTERN path/`). */
  searchScope: "SS1",
  /** Search (mid-pipe) — SS2: a grep segment reached mid-pipe blocks; use
   *  single-process `rg PATTERN path/`. */
  searchMidPipe: "SS2",
  /** Search (replace flag) — SS4: `rg` carrying `-r`/`--replace` (display
   *  substitution) warns; drop the flag. */
  searchReplaceFlag: "SS4",
  /** Search (find-first) — SS3: a find-headed segment warns; use
   *  `fd PATTERN path/`. */
  findFirst: "SS3",
  /** Hygiene (error swallow) — SE1: non-blocking note when a command tails
   *  `|| true`, hiding the real error. */
  errorSwallow: "SE1",
  /** Hygiene (reader-bypass) — SE2: non-blocking note when `sed -n`/`cat`
   *  reads a file — the printed lines still certify. */
  readerBypass: "SE2",
  /** Hygiene (view credit) — VC: printed lines of a mappable view command
   *  (head/tail/sed -n/cat) certify read spans; any non-"off" enables. */
  bashViewCredit: "VC",
  /** Search (portability) — PB1: `grep -P` on darwin warns; use `rg -P`
   *  or `grep -E`. */
  searchPortability: "PB1",
  /** Cadence — CN: non-blocking nudge at ~120 turns / ~150K context tokens;
   *  resets on compaction. */
  cadenceNudge: "CN",
  /** Edits (loop guard) — LG1: note at the 4th same-path edit in a turn,
   *  one-shot block at the 7th ("summarize, then ask"); resets per turn. */
  loopGuard: "LG1",
  /** Bash (failure streak) — R11: ≥5 consecutive tool failures with no
   *  landed mutation block the next shell call. */
  failureLoopGuard: "R11",
  /** Phase (label) — PH1: advisory only, never blocks; labels the turn's
   *  stage, one "recovering" note per turn. */
  phaseNudge: "PH1",
  /** Bash (output scrub) — OS: lossless-or-labeled compaction before the H1
   *  cap — ANSI stripped, passing tests aggregated, failures kept verbatim. */
  outputScrub: "OS",
} as const;

/** Rule ID → config key (the inverse of RULE_IDS): `config.json` accepts
 * either spelling in `rules` — keys read naturally (`rerunGuard`), IDs grep
 * against the rule tables in index.ts and extensions/README.md (`R10`). */
const BY_ID = Object.fromEntries(
  Object.entries(RULE_IDS).map(([k, id]) => [id, k]),
) as Record<string, RuleKey>;

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

/** Safety rules whose severity is never below `error`, whatever config says.
 * editAnchorGuard left this set 2026-10-28 by user direction: the edit
 * pipeline itself enforces oldText existence/uniqueness/overlap, so AG is
 * a teaching layer — warn notes carry the fix; content match decides. */
export const HARD_RULES: ReadonlySet<RuleKey> = new Set([
  "destructiveConfirm",
  "commitMessageLint",
] as RuleKey[]);



export interface DestructiveExtra {
  id: string;
  pattern: string;
  label?: string;
}
export interface DestructiveOverrides {
  remove: string[];
  extra: DestructiveExtra[];
}

export interface GateConfig {
  rules: Record<RuleKey, Severity>;
  severity: Record<RuleKey, Severity>;
  outputCap: { maxLines: number; maxBytes: number };
  confirm: { timeoutMs: number };
  destructive: DestructiveOverrides;
}

/** Redirectable so a test can exercise a config without touching the tracked
 * file. */
const CONFIG_PATH =
  process.env.PGATE_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "config.json");

const DEFAULT_OUTPUT_CAP = { maxLines: BASH_CAP_LINES, maxBytes: BASH_CAP_BYTES };
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
  if (v === undefined) return undefined; // absent ≠ invalid: keep the default, silently
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    warn(`ignoring ${where}=${JSON.stringify(v)} (expected a positive integer ≤ ${max})`);
    return undefined;
  }
  return n;
}

/** 1a (2026-10-26): managed destructive list — `remove` drops builtin entry
 * ids from the confirm set, `extra` adds {id, pattern, label?} entries.
 * Fail-closed: malformed items warn and are skipped; they never widen the
 * set, narrow it unexpectedly, or throw. File-managed only (no env form). */
function parseDestructive(raw: unknown): DestructiveOverrides {
  if (raw === undefined) return { remove: [], extra: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warn("`destructive` must be an object — ignored");
    return { remove: [], extra: [] };
  }
  const o = raw as Record<string, unknown>;
  const remove = Array.isArray(o.remove)
    ? o.remove.filter((x): x is string => {
        if (typeof x === "string") return true;
        warn(`destructive.remove item ${JSON.stringify(x)} is not a string — skipped`);
        return false;
      })
    : [];
  const extra = Array.isArray(o.extra)
    ? o.extra.filter((x): x is DestructiveExtra => {
        const e = (x ?? {}) as { id?: unknown; pattern?: unknown };
        if (typeof e.id === "string" && typeof e.pattern === "string") return true;
        warn(`destructive.extra item ${JSON.stringify(x)} needs string id+pattern — skipped`);
        return false;
      })
    : [];
  return { remove, extra };
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

  // config.json is the single home for severities: anything it omits or
  // garbles fails closed to `error` rather than consulting a shadow table.
  const rules = Object.fromEntries(
    (Object.keys(RULE_IDS) as RuleKey[]).map((k) => [k, "error" as Severity]),
  ) as Record<RuleKey, Severity>;
  const rawRules = raw.rules;

  if (rawRules !== undefined && (rawRules === null || typeof rawRules !== "object" || Array.isArray(rawRules))) {
    warn("`rules` must be an object — every rule stays at its default (on)");
  } else if (rawRules) {
    for (const [key, value] of Object.entries(rawRules as Record<string, unknown>)) {
      // key or ID ("editRegionGuard" or "AG2") — both address the same rule
      const ruleKey = (key in RULE_IDS ? key : BY_ID[key]) as RuleKey | undefined;
      if (ruleKey === undefined) {
        warn(`unknown rule "${key}" in config.json — ignored (see RULE_IDS in loader.ts for valid keys and IDs)`);
        continue;
      }
      const b = asSeverity(value, `rules.${key}`);
      if (b !== undefined) rules[ruleKey] = b;
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
  const de = raw.destructive;

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
    destructive: parseDestructive(de),
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
