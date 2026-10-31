/**
 * Pure reader library for the subagent data feeds the extensions write to
 * disk: activity snapshots (stall detection), the durable result inbox, and
 * per-spawner name registries. No server, no network — every function walks
 * the sessions tree (or a repo root) synchronously and never throws on
 * unreadable/corrupt files; bad files are skipped.
 *
 * Layout ground truth (extensions/subagents):
 *   <sessionsDir>/<slug>/artifacts/<sessionId>/subagent-activity/<childId>.json
 *   <sessionsDir>/<slug>/artifacts/<sessionId>/subagent-registry.json
 *   <repoRoot>/.pi/subagent-results.jsonl
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// ── Constants (mirror extensions/subagents/status.ts) ───────────────────────

/** Default phase-"active" stall threshold in ms. */
export const STALL_ACTIVE_MS = 600_000;
/** Default phase-"starting" stall threshold in ms. */
export const STALL_START_MS = 180_000;

/** Number(raw) guarded exactly like extensions/subagents/status.ts: a
 *  positive finite ms value, or the fallback when raw is missing, empty,
 *  NaN, or <= 0. */
function positiveMsFromEnv(raw, fallback) {
  const value = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Stall thresholds read from the environment at call time (mirroring
 *  resolveStallThresholds in extensions/subagents/status.ts, resolved per
 *  call so a running host picks up overrides without a reload):
 *    PI_SUBAGENT_STALL_ACTIVE_MS (default 600_000) — phase "active" silence.
 *    PI_SUBAGENT_STALL_START_MS  (default 180_000) — phase "starting" silence.
 *  Keeps dashboard badges in agreement with extension stall status. */
function resolveStallThresholds(env = process.env) {
  return {
    activeMs: positiveMsFromEnv(env.PI_SUBAGENT_STALL_ACTIVE_MS, STALL_ACTIVE_MS),
    startMs: positiveMsFromEnv(env.PI_SUBAGENT_STALL_START_MS, STALL_START_MS),
  };
}

const KNOWN_PHASES = new Set(["starting", "active", "waiting", "done"]);
const ACTIVITY_DIR = "subagent-activity";
const REGISTRY_FILE = "subagent-registry.json";
const RESULTS_FILE = join(".pi", "subagent-results.jsonl");
const RESULTS_LIMIT = 50;

// ── Shared helpers ──────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Read + JSON.parse a file; null on missing, unreadable, or corrupt. */
function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** List a directory's entries; [] on missing or unreadable. */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ── readChildren ────────────────────────────────────────────────────────────

/**
 * Validate a parsed activity snapshot against the on-disk contract
 * (extensions/subagents/activity.ts): version 1, matching runningChildId,
 * known phase, finite updatedAt. Returns the state or null when invalid.
 */
function validateSnapshot(parsed, childId) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (parsed.runningChildId !== childId) return null;
  if (!KNOWN_PHASES.has(parsed.phase)) return null;
  if (!Number.isFinite(parsed.updatedAt)) return null;
  return parsed;
}

/**
 * Classify a snapshot's freshness, mirroring extension stall semantics:
 * phase "active" stalls past the resolved activeMs threshold of silence,
 * "starting" past startMs; "waiting" is healthy idle and never stalls;
 * "done" is terminal. Boundary: age exactly at the threshold is still
 * healthy.
 */
function classifyStall(phase, updatedAtMs, now, thresholds) {
  const age = now - updatedAtMs;
  if (phase === "active") return age > thresholds.activeMs ? "stalled" : "healthy";
  if (phase === "starting") return age > thresholds.startMs ? "stalled" : "healthy";
  return "healthy";
}

/**
 * A child session file is named `<timestamp>_<childId>-<rand>-<rand>-<rand>.jsonl`,
 * so a registry entry owns the child when its basename contains
 * `_<childId>-`. Returns the display name or null.
 */
function resolveChildName(registry, childId) {
  if (!isPlainObject(registry)) return null;
  for (const [name, entry] of Object.entries(registry)) {
    if (!isPlainObject(entry) || typeof entry.sessionFile !== "string") continue;
    if (basename(entry.sessionFile).includes(`_${childId}-`)) return name;
  }
  return null;
}

/**
 * Walk <sessionsDir>/<slug>/artifacts/<sessionId>/subagent-activity/*.json and
 * return one entry per valid snapshot (corrupt/foreign files are omitted):
 *   { childId, sessionId, name, phase, activeTool, activeScope, activeSinceMs,
 *     waitingSinceMs, turnIndex, updatedAtMs, latestEvent, stallState }
 * sessionId is the spawner session owning the snapshot; name comes from that
 * spawner's registry when resolvable, else null. `options.now` fixes the
 * clock for stall classification (defaults to Date.now()); `options.env`
 * overrides the environment for the PI_SUBAGENT_STALL_* threshold lookup
 * (defaults to process.env). Sorted by updatedAtMs descending (most
 * recently active first).
 */
export function readChildren(sessionsDir, options = {}) {
  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  const thresholds = resolveStallThresholds(options?.env);
  const children = [];
  for (const slug of listDir(sessionsDir)) {
    if (!slug.isDirectory()) continue;
    const artifactsRoot = join(sessionsDir, slug.name, "artifacts");
    for (const sessionEntry of listDir(artifactsRoot)) {
      if (!sessionEntry.isDirectory()) continue;
      const artifactDir = join(artifactsRoot, sessionEntry.name);
      const activityDir = join(artifactDir, ACTIVITY_DIR);
      let registry = null;
      let registryRead = false;
      for (const file of listDir(activityDir)) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const childId = file.name.slice(0, -".json".length);
        const parsed = readJson(join(activityDir, file.name));
        const state = validateSnapshot(parsed, childId);
        if (!state) continue;
        if (!registryRead) {
          registry = readJson(join(artifactDir, REGISTRY_FILE));
          registryRead = true;
        }
        children.push({
          childId,
          sessionId: sessionEntry.name,
          name: resolveChildName(registry, childId),
          phase: state.phase,
          activeTool: state.toolActive === true ? state.toolName ?? null : null,
          activeScope: typeof state.activeScope === "string" ? state.activeScope : null,
          activeSinceMs: Number.isFinite(state.activeSince) ? state.activeSince : null,
          waitingSinceMs: Number.isFinite(state.waitingSince) ? state.waitingSince : null,
          turnIndex: Number.isInteger(state.turnIndex) ? state.turnIndex : null,
          updatedAtMs: state.updatedAt,
          latestEvent: typeof state.latestEvent === "string" ? state.latestEvent : null,
          stallState: classifyStall(state.phase, state.updatedAt, now, thresholds),
        });
      }
    }
  }
  children.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.childId.localeCompare(b.childId));
  return children;
}

// ── readSubagentResults ─────────────────────────────────────────────────────

/** Parsed-inbox cache keyed like sessionSignalsCache in scripts/data.mjs:
 *  the server polls every few seconds but the file grows one line per
 *  subagent run forever — an unchanged stat (mtimeMs + size) must reuse the
 *  cached parse instead of re-reading the whole file. */
const subagentResultsCache = new Map();

/**
 * Read the last RESULTS_LIMIT records from `<repoRoot>/.pi/subagent-results.jsonl`.
 * Corrupt lines and a truncated (partial) last line are skipped; a missing
 * file yields []. Each record maps to:
 *   { id, ts, name, agent, exitCode, elapsedMs, costUsd, summary, error }
 * costUsd comes from stats.cost when finite; error prefers record.error and
 * falls back to record.errorMessage. Results are cached by stat — an
 * unchanged file (same mtimeMs + size) returns the cached array. The
 * optional `options.parseCalls` is a `{ parses }` tally incremented on each
 * real parse (test hook for the stat cache).
 */
export function readSubagentResults(repoRoot, options = {}) {
  const file = join(repoRoot, RESULTS_FILE);
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const hit = subagentResultsCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.results;
  if (isPlainObject(options?.parseCalls)) options.parseCalls.parses += 1;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const results = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // corrupt or truncated tail line
    }
    if (!isPlainObject(record)) continue;
    const stats = isPlainObject(record.stats) ? record.stats : {};
    results.push({
      id: typeof record.id === "string" ? record.id : null,
      ts: Number.isFinite(record.ts) ? record.ts : null,
      name: typeof record.name === "string" ? record.name : null,
      agent: typeof record.agent === "string" ? record.agent : null,
      exitCode: Number.isFinite(record.exitCode) ? record.exitCode : null,
      elapsedMs: Number.isFinite(record.elapsed) ? record.elapsed : null,
      costUsd: Number.isFinite(stats.cost) ? stats.cost : null,
      summary: typeof record.summary === "string" ? record.summary : null,
      error: typeof record.error === "string" ? record.error
        : typeof record.errorMessage === "string" ? record.errorMessage
        : null,
    });
  }
  const capped = results.slice(-RESULTS_LIMIT);
  subagentResultsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, results: capped });
  return capped;
}

// ── readRegistries ──────────────────────────────────────────────────────────

/**
 * Collect every spawner name registry under the sessions tree:
 *   [{ sessionId, entries: Record<name, { sessionFile, sessionId }> }]
 * sessionId is the spawner session (the artifact dir name). Corrupt or
 * non-object registries are skipped; none found yields []. Sorted by
 * sessionId for a stable order.
 */
export function readRegistries(sessionsDir) {
  const registries = [];
  for (const slug of listDir(sessionsDir)) {
    if (!slug.isDirectory()) continue;
    const artifactsRoot = join(sessionsDir, slug.name, "artifacts");
    for (const sessionEntry of listDir(artifactsRoot)) {
      if (!sessionEntry.isDirectory()) continue;
      const file = join(artifactsRoot, sessionEntry.name, REGISTRY_FILE);
      const parsed = readJson(file);
      if (!isPlainObject(parsed)) continue;
      registries.push({ sessionId: sessionEntry.name, entries: parsed });
    }
  }
  registries.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return registries;
}
