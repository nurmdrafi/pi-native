import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  agentsSessionNameFor,
  isMuxAvailable,
  muxSetupHint,
  createSurfaceRunning,
  sendCommand,
  pollForExit,
  closeSurface,
  sendInterrupt,
  shellEscape,
  readScreen,
  isPaneNotFound,
  listLiveSurfaces,
  reapDeadAgentPanes,
} from "./tmux.ts";

import {
  type SessionEntry,
  appendSessionIndex,
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  knownSubagentNames,
  listRegisteredSubagents,
  readNameRegistry,
  registerName,
  resolveNameInIndex,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  summarizeStatsFromEntries,
  getSessionIdFromEntries,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import { resolveResumeLoadout } from "./launch-artifacts.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  BUDGET_GRACE_MS,
  checkBudgetExceeded,
  createBudgetStopper,
  createSessionBudgetMeter,
  resolveBudget,
  parseBudgetFrontmatter,
  type BudgetBreach,
  type BudgetDims,
  type EnforcedBudget,
} from "./budget.ts";
import { sweepRunningSubagents } from "./reconcile.ts";
import { scanToolManifests } from "./tool-manifest.ts";
import { appendSubagentResult, buildPriorWorkBlock, computeFilesChanged, drainSubagentResults, extractFilesRead, gitDiffForBaseline, prepareGitBaseline, readRecentResults, repoRootFor, resultInboxPath, subagentHistoryPath, usageTokens, type AsyncGitRunner, type GitRunner, type SubagentHistoryExtra, type SubagentHistoryRecord } from "./inbox.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  SpawnQueue,
  declareScope,
  findConflicts,
  releaseScope,
  resetScopeRegistry,
  resolveMaxConcurrent,
  scopedChildren,
  setScopeDrainHook,
} from "./spawn-queue.ts";
import { deriveScope, intersectFilesChanged, parseTaskPaths, type SubagentScope } from "./scope.ts";
import { dismissPendingDetached, findPendingDetached, writePendingDetachedSubagents, type PendingDetachedSubagent } from "./pending.ts";
export { dismissPendingDetached, findPendingDetached, writePendingDetachedSubagents } from "./pending.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent to spawn (e.g. 'worker', 'scout'). Loads that agent's fixed profile — model, tool loadout, system prompt. " +
      "Must be one of the listed agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Cosmetic label for the subagent's pane and widget row; defaults to the agent name. " +
        "Does not select which agent runs.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory; the sub-agent starts there and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. " +
        "Use for role-specific subfolders.",
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 100,
      description:
        "Files or directories this sub-agent will WRITE, repo-relative to cwd. Declares write ownership: " +
        "while it runs (or waits), other spawns declaring overlapping paths queue behind it instead of racing it. " +
        "NOT existence-checked — name deliverables that do not exist yet.",
    }),
  ),
  budget: Type.Optional(
    Type.Object(
      {
        wallClockSec: Type.Optional(Type.Number({ description: "Ceiling in seconds." })),
        turns: Type.Optional(Type.Number({ description: "Ceiling on assistant turns." })),
        costUsd: Type.Optional(Type.Number({ description: "Ceiling on cumulative USD cost." })),
      },
      {
        description:
          "May only LOWER the effective ceiling (role budget, else config default); with no ceiling, the override is the cap. " +
          "On breach: child interrupted, then killed after grace period; result reports budget_exceeded.",
      },
    ),
  ),
});

/** subagent_control parameters: a verb plus the target's display name. */
const SubagentControlParams = Type.Object({
  action: Type.Union([Type.Literal("cancel"), Type.Literal("restart")], {
    description:
      "`cancel` stops a running sub-agent (interrupt, then kill after a grace period) or removes a queued one before it launches; " +
      "`restart` re-dispatches a running sub-agent into a fresh pane resuming its session.",
  }),
  name: Type.String({
    description:
      "Exact display name of the sub-agent — the spawn acknowledgement's name or the live-children lines of subagents_list.",
  }),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  /** Per-role budget ceilings; undeclared dimensions fall back to config/builtin defaults. */
  budget?: BudgetDims | "none";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
] as const;

/**
 * In top-level sessions the spawning tools are registered but NOT active
 * (zero prompt tokens) until a trigger activates them: `/subagents on`, any
 * `/subagents <agent> [task]` spawn, or PI_SUBAGENTS=1 at process start.
 * Subagent sessions (PI_SUBAGENT_NAME set) always register active — the
 * child's `--tools` sandbox governs what it may actually use.
 */
const SPAWN_TOOLS_GATED =
  !process.env.PI_SUBAGENT_NAME && process.env.PI_SUBAGENTS !== "1";

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Tool-extension resolution ────────────────────────────────────────────────
// Shipped tools resolve declaratively, with no load order involved: a
// `pi-tools.json` manifest inside the extension directory (tool-manifest.ts),
// then the directory-naming convention (`web_search` → `web-search/index.ts`).
// This runtime registry is the last-resort layer for OTHER pi extensions that
// bundle a bespoke tool (e.g. a project-local extension): they register name →
// extension-file path here at load/session_start time so a child process can
// be launched with `--no-extensions` + an explicit `-e <path>` for it.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a non-built-in tool name to the pi-extension file that registers it.
 * Used to build the child's `--extension` whitelist after `--no-extensions`
 * disables global discovery. Resolution is declarative and load-order
 * independent — nothing depends on an extension having already run:
 *   1. a shipped `pi-tools.json` manifest (tool-manifest.ts) naming the tool;
 *   2. the directory-naming convention: tool `web_search` →
 *      `<extensions base>/web-search/index.ts` when that file exists;
 *   3. a runtime-registered extension path (registerToolExtension).
 * Returns undefined for built-in tools and for unknown names — the spawn-time
 * guard in applySandboxToParts warns about those instead of dropping them
 * silently.
 */
function getToolExtensionPath(tool: string, manifestIndex?: Map<string, string>): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // The spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  // Tools bundled by THIS extension itself (a hardened shell for sandboxed
  // children) resolve from its own directory, independent of any agent tree.
  const bundled = join(SUBAGENTS_DIR, "tools", `${tool.replace(/_/g, "-")}.ts`);
  if (existsSync(bundled)) return bundled;
  const extBase = join(getAgentConfigDir(), "extensions");
  const manifestPath = (manifestIndex ?? scanToolManifests(extBase)).get(tool);
  if (manifestPath && existsSync(manifestPath)) return manifestPath;
  const conventional = join(extBase, tool.replace(/_/g, "-"), "index.ts");
  if (existsSync(conventional)) return conventional;
  // Fall back to a runtime-registered extension when nothing on disk
  // resolves (e.g. a project-local extension exposing a bespoke tool).
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/** Closest known tool name (edit distance ≤ 2) for a warning that has to name
 * the fix, not only the typo. Known names come from the manifest scan plus the
 * builtin, spawning and control tool sets. */
export function closestToolName(
  tool: string,
  known: Iterable<string>,
): string | undefined {
  const dist = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = Math.min(
          row[j] + 1,
          row[j - 1] + 1,
          diag + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        diag = above;
      }
    }
    return row[b.length];
  };
  let best: { name: string; d: number } | undefined;
  for (const name of known) {
    if (name === tool) continue;
    const d = dist(tool, name);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

/** Provider failures worth one automatic resume: the session file already
 * holds the child's context, so a fresh spawn would re-pay for it from zero.
 * Matches the shapes that reach result.errorMessage (HTTP status, provider
 * wording, socket/transport errors) and nothing else — a task-shaped failure
 * (refusal, tsc error, budget breach) must still deliver. */
export function isTransientProviderError(message: string): boolean {
  return /\b(?:429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|capacity|temporarily unavailable|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(
    message,
  );
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    budget: parseBudgetFrontmatter(frontmatter),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Parsed agent definitions cached per file, invalidated by mtime — agent
 *  discovery re-ran a full readdir+readFileSync sweep over up to three
 *  directories on every spawn (validation + launch), none of which changes
 *  between spawns in a normal session. */
const agentDefCache = new Map<string, { mtimeMs: number; def: ListedAgentDefinition | null }>();

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const fullPath = join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch {
        continue;
      }
      const cached = agentDefCache.get(fullPath);
      if (cached && cached.mtimeMs === mtimeMs) {
        if (cached.def) agents.set(cached.def.name, cached.def);
        continue;
      }
      const parsed = parseAgentDefinition(
        readFileSync(fullPath, "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) {
        agentDefCache.set(fullPath, { mtimeMs, def: null });
        continue;
      }
      const listed: ListedAgentDefinition = { ...parsed, source };
      agentDefCache.set(fullPath, { mtimeMs, def: listed });
      agents.set(listed.name, listed);
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require tmux. ${muxSetupHint()}`,
      },
    ],
    details: { error: "tmux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

// ── live child metrics (subagents_list + widget) ──

/** Per-child live metrics: elapsed, the live status phase, and — only when
 *  a budget meter is attached — its live usage. Unmetered children omit
 *  turns/tokens/costUsd rather than faking zeros; queued children carry
 *  just name+agent+phase (no start time exists yet). `pastP90Min` is set by
 *  annotatePastP90 when the child outran its agent's history baseline. */
export interface ChildMetrics {
  name: string;
  agent?: string;
  phase: string;
  elapsedSec?: number;
  turns?: number;
  tokens?: number;
  costUsd?: number;
  pastP90Min?: number;
}

function runningChildMetrics(running: RunningSubagent): ChildMetrics {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - running.startTime) / 1000));
  const phase = classifyStatus(running.statusState, Date.now()).kind;
  if (!running.budgetMeter) return { name: running.name, agent: running.agent, phase, elapsedSec };
  // O(delta) incremental read — the same meter the poll loop enforces with.
  const usage = running.budgetMeter.update();
  const stats = summarizeSessionStats(running.sessionFile);
  return {
    name: running.name,
    agent: running.agent,
    phase,
    elapsedSec,
    turns: usage.turns,
    ...(stats ? { tokens: usageTokens(stats) } : {}),
    costUsd: Number(usage.costUsd.toFixed(4)),
  };
}

function queuedChildMetrics(pending: PendingSpawn): ChildMetrics {
  return {
    name: pending.params.name ?? pending.reservedName ?? pending.params.agent,
    agent: pending.params.agent,
    phase: "queued",
  };
}

/** Compact line: `worker-1 · 842s · active · 12t · 84k tok · $0.42 · past p90 (14m)` —
 *  absent fields are trimmed, never zero-filled. */
function formatChildMetricsLine(m: ChildMetrics): string {
  if (m.phase === "queued") return `${m.name} · queued`;
  const parts = [m.name, `${m.elapsedSec ?? 0}s`, m.phase];
  if (m.turns !== undefined) parts.push(`${m.turns}t`);
  if (m.tokens !== undefined) parts.push(`${formatTokens(m.tokens)} tok`);
  if (m.costUsd !== undefined) parts.push(`$${m.costUsd.toFixed(2)}`);
  if (m.pastP90Min !== undefined) parts.push(`past p90 (${m.pastP90Min}m)`);
  return parts.join(" · ");
}

// ── history baselines and duplicate-spawn detection (spawn ack + list) ──

/** Recover the agent role from a history row's child name: defaulted names
 *  are `agent` or `agent-N` (uniqueRunningName), so exactly one trailing
 *  `-<digits>` suffix is stripped. Custom spawn names may not encode the
 *  agent — those rows simply never match, which only silences a warn-only
 *  hint. */
function agentOfHistoryName(name: string): string {
  return name.replace(/-\d+$/, "");
}

/** Nearest-rank quantile over an ascending-sorted list. */
function quantile(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** Per-agent baseline over history rows carrying a usable duration: count,
 *  median/p90 elapsed (nearest-rank), and median cost when any row carried
 *  one. Agents with fewer than MIN_BASELINE_ROWS usable rows get none —
 *  three points is the floor below which "typical" is noise. */
export interface AgentBaseline {
  count: number;
  medianMs: number;
  p90Ms: number;
  medianCostUsd?: number;
}

const MIN_BASELINE_ROWS = 3;

function agentBaselines(records: SubagentHistoryRecord[]): Map<string, AgentBaseline> {
  const byAgent = new Map<string, { durations: number[]; costs: number[] }>();
  for (const r of records) {
    if (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs <= 0) continue;
    const bucket = byAgent.get(agentOfHistoryName(r.name)) ?? { durations: [], costs: [] };
    bucket.durations.push(r.durationMs);
    if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) bucket.costs.push(r.costUsd);
    byAgent.set(agentOfHistoryName(r.name), bucket);
  }
  const out = new Map<string, AgentBaseline>();
  for (const [agent, b] of byAgent) {
    if (b.durations.length < MIN_BASELINE_ROWS) continue;
    const d = [...b.durations].sort((x, y) => x - y);
    const n = d.length;
    const medianMs = n % 2 === 1 ? d[(n - 1) / 2] : (d[n / 2 - 1] + d[n / 2]) / 2;
    const c = [...b.costs].sort((x, y) => x - y);
    const medianCostUsd =
      c.length === 0
        ? undefined
        : c.length % 2 === 1
          ? c[(c.length - 1) / 2]
          : (c[c.length / 2 - 1] + c[c.length / 2]) / 2;
    out.set(agent, {
      count: n,
      medianMs,
      p90Ms: quantile(d, 0.9),
      ...(medianCostUsd !== undefined ? { medianCostUsd } : {}),
    });
  }
  return out;
}

function agentBaselineFor(records: SubagentHistoryRecord[], agent: string): AgentBaseline | null {
  return agentBaselines(records).get(agent) ?? null;
}

function formatBaselineMinutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Spawn-ack time-sense line: `typical for `worker`: median 5m · p90 15m · $0.34`.
 *  The cost figure is the median; it is omitted when no history row carried
 *  one. Sub-minute figures clamp up to 1m so the line never reads "0m". */
function formatBaselineLine(agent: string, b: AgentBaseline): string {
  const cost = b.medianCostUsd !== undefined ? ` · $${b.medianCostUsd.toFixed(2)}` : "";
  return `typical for \`${agent}\`: median ${formatBaselineMinutes(b.medianMs)} · p90 ${formatBaselineMinutes(b.p90Ms)}${cost}`;
}

function normalizeTaskText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Warn-only duplicate heuristic: true when two texts are equal after
 *  normalization, near-equal by token overlap (Jaccard ≥ 0.8), or one
 *  contains the other (≥ 40 normalized chars). Used task-vs-task against
 *  running children and task-vs-summary against history rows — history
 *  stores no task text, and completed summaries restate their task. */
const NEAR_IDENTICAL_JACCARD = 0.8;
const MIN_CONTAINMENT_CHARS = 40;

function tasksNearIdentical(a: string, b: string): boolean {
  const na = normalizeTaskText(a);
  const nb = normalizeTaskText(b);
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= MIN_CONTAINMENT_CHARS && long.includes(short)) return true;
  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= NEAR_IDENTICAL_JACCARD;
}

function formatAgo(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3_600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3_600)} h ago`;
  return `${Math.floor(sec / 86_400)} d ago`;
}

const DUPLICATE_SUMMARY_HEAD = 120;

/** Warn-only duplicate-spawn note for the ack: a same-agent child already
 *  running a near-identical task (steerable, so it wins), or the newest
 *  same-agent history row whose summary matches the task — citing how long
 *  ago it ran and its result's head. Null when nothing matches; the
 *  orchestrator always decides whether the re-run is legitimate. */
function findDuplicateSpawn(
  params: { agent: string; task: string },
  running: Iterable<Pick<RunningSubagent, "name" | "agent" | "task" | "startTime">>,
  history: SubagentHistoryRecord[],
  now: number = Date.now(),
): string | null {
  for (const r of running) {
    if (r.agent !== params.agent || !tasksNearIdentical(r.task, params.task)) continue;
    return (
      `NOTE: this looks like a duplicate — a near-identical task is already running as "${r.name}" ` +
      `(started ${formatAgo(r.startTime, now)}). Steer that child instead of respawning, unless this run is intentional. `
    );
  }
  let match: SubagentHistoryRecord | null = null;
  for (const r of history) {
    if (agentOfHistoryName(r.name) !== params.agent || !tasksNearIdentical(params.task, r.summary)) continue;
    if (!match || r.ts > match.ts) match = r;
  }
  if (!match) return null;
  const head = normalizeTaskText(match.summary).slice(0, DUPLICATE_SUMMARY_HEAD);
  return (
    `NOTE: this looks like a duplicate — an identical task ran ${formatAgo(match.ts, now)} — ` +
    `result: ${head}. Re-check that result before respawning. `
  );
}

/** Flag running children whose elapsed time exceeds their agent's p90
 *  baseline (from history) with `pastP90Min`. Queued children and agents
 *  without a baseline are returned untouched. */
function annotatePastP90(metrics: ChildMetrics[], history: SubagentHistoryRecord[]): ChildMetrics[] {
  const baselines = agentBaselines(history);
  return metrics.map((m) => {
    if (m.phase === "queued" || m.elapsedSec === undefined) return m;
    const b = baselines.get(m.agent ?? agentOfHistoryName(m.name));
    if (!b || m.elapsedSec * 1_000 <= b.p90Ms) return m;
    return { ...m, pastP90Min: Math.max(1, Math.round(b.p90Ms / 60_000)) };
  });
}

/** Widget usage tail: ` · 12t · $0.42`, empty when unmetered. */
function formatUsageTail(usage: { turns: number; costUsd: number } | undefined): string {
  return usage ? ` · ${usage.turns}t · $${usage.costUsd.toFixed(2)}` : "";
}

function formatWidgetRightLabel(snapshot: StatusSnapshot, usage?: { turns: number; costUsd: number }): string {
  if (snapshot.kind === "starting") return ` starting…${formatUsageTail(usage)} `;
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText}${formatUsageTail(usage)} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    const tail = formatUsageTail(usage);
    return label ? ` active · ${label}${duration}${tail} ` : ` active${tail} `;
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail}${formatUsageTail(usage)} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration}${formatUsageTail(usage)} `;
}

/** Cap on the child's final message embedded in the delivered result. The
 * full text stays in the child's session; the parent sees at most this many
 * characters, so a wave of verbose children cannot flood orchestrator
 * context through result delivery. */
const RESULT_SUMMARY_CHAR_LIMIT = 2000;

/** Cut an oversized child summary to a line boundary near the limit, ending
 * with a marker naming the shown and total sizes. Short summaries pass
 * through untouched. */
function capResultSummary(summary: string): string {
  if (summary.length <= RESULT_SUMMARY_CHAR_LIMIT) return summary;
  const cut = summary.slice(0, RESULT_SUMMARY_CHAR_LIMIT);
  const lastBreak = cut.lastIndexOf("\n");
  const head = lastBreak > RESULT_SUMMARY_CHAR_LIMIT / 2 ? cut.slice(0, lastBreak) : cut;
  return `${head}\n\n… [summary truncated: first ${head.length} of ${summary.length} chars — resume the child by name for the full text]`;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage" | "error"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;

  if (result.error === "pane_lost") {
    // Pane vanished before the child could report (group reap, external
    // kill). The session file survives; resume or inspect it directly.
    return (
      `Sub-agent "${name}" was lost before it could report — its pane vanished (reaped or killed).\n\n` +
      `${capResultSummary(result.summary)}${sessionRef}`
    );
  }

  if (result.error === "budget_exceeded") {
    // Budget stop: the child was interrupted (killed after the grace period).
    // The session file is intact, so resume or a narrower re-spawn are both
    // viable; spawn overrides may only lower ceilings, so raising one needs a
    // role/config change.
    return (
      `Sub-agent "${name}" was stopped after ${formatElapsed(result.elapsed)} — budget exceeded.\n\n` +
      `${result.errorMessage}\n\n` +
      `The run was cut short; its session is preserved. Resume it with subagent_message ` +
      `(wall clock restarts; cost re-meters from the session file) or re-spawn with a narrower task.` +
      sessionRef
    );
  }

  if (result.error === "cancelled_by_parent") {
    // Parent-initiated stop (subagent_control cancel). The session file
    // survives; resume the child if the work still matters.
    return (
      `Sub-agent "${name}" was cancelled by its parent after ${formatElapsed(result.elapsed)}.\n\n` +
      `${capResultSummary(result.summary)}${sessionRef}`
    );
  }

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    const transient = isTransientProviderError(result.errorMessage);
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result, but its session file is intact. ` +
      (transient
        ? `This is a transient provider failure (rate limit or 5xx): resume the same session with ` +
          `subagent_message instead of spawning a fresh subagent — a fresh spawn re-pays the whole ` +
          `context the child had already built.`
        : `Resume it with subagent_message to keep its context; spawn a fresh subagent only when the ` +
          `task itself must change.`) +
      sessionRef
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${capResultSummary(result.summary)}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${capResultSummary(result.summary)}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  /** Repo-relative paths added/removed/status-changed since the spawn-time git
   * baseline (sorted, cap 200) — populated at delivery time when a baseline
   * exists; absent when git was unavailable or the child cwd was not a repo. */
  files_changed?: string[];
  /** Provenance marker: files_changed came from a git status delta. */
  files_changed_source?: "git_status_delta";
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  parentArtifactDir?: string;
  /** Spawn-time git baseline snapshot (PI_SUBAGENT_BASELINE) when the child
   * cwd was inside a git repo; diffs at delivery time for files_changed. */
  gitBaselinePath?: string;
  /** Child session entries parsed once at result-build time (watcher exit
   * or loss synthesis) and reused by extractFilesRead at delivery, so the
   * session file is parsed once per delivery. In-memory only. */
  parsedEntries?: SessionEntry[] | null;
  /** Derived file scope. "declared" (from the files param) participates in
   * spawn-queue locking; "parsed" (from task text) is context-only — prior-
   * work injection and display. Survives pane-loss restarts because the
   * entry mutates in place. */
  scope?: SubagentScope;
  /** Spawn-queue lock id for a declared scope; released only at delivery. */
  scopeId?: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** Working directory of the child — repo-root basis for the durable inbox. */
  cwd?: string;
  /** Session id of the spawning parent, for inbox drain routing. */
  parentSessionId?: string | null;
  /** Project scope of the child (repo root of its cwd), pinned at
   *  registration: every registry read filters by the calling session's
   *  scope, so children of other projects sharing this process are never
   *  visible, addressable, or reaped from here. */
  scopeKey?: string;
  /** Set once a result was delivered; guards sweep/watcher double-send. */
  delivered?: boolean;
  /** Reconciliation bookkeeping (owned by the sweep). */
  reconcile?: { lastMtimeMs: number; lastSize: number; unchangedTicks: number };
  /** Resolved budget ceilings (always finite once attached). */
  budget?: EnforcedBudget;
  /** Incremental meter over the child's session file. */
  budgetMeter?: ReturnType<typeof createSessionBudgetMeter>;
  /** Interrupt → grace → kill state machine for budget breaches. */
  budgetStopper?: ReturnType<typeof createBudgetStopper>;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Whether the child self-terminates on completion (auto-exit agent).
   *  Only auto-exit children qualify for automatic pane-loss restarts. */
  autoExit?: boolean;
  /** Pane-loss restart bookkeeping: set when the single restart attempt
   *  began; `respawnedAt` added once a replacement pane is actually running. */
  restart?: { attemptedAt: number; respawnedAt?: number };
  /** Cancel intent (subagent_control cancel), set BEFORE the stop so the
   *  pane-loss restart gates refuse the child and any racing loss
   *  synthesis reports cancelled_by_parent instead of pane_lost. */
  cancelledAt?: number;
  /** Stalled-child recovery bookkeeping (owned by the stall recovery path):
   *  `nudgedAt` when the health-check nudge was sent; `exhaustedAt` once the
   *  grace window lapsed without resumed activity. Survives recovery — a
   *  child that stalls again skips the nudge and goes straight to restart. */
  stallRecovery?: { nudgedAt: number; exhaustedAt?: number };
  /** tmux wait-for channel the pane signals when its launch script ends; the
   *  watcher parks on it between ticks so completion wakes it immediately
   *  instead of on the next interval tick. */
  waitChannel?: string;
}

/** All currently running subagents, keyed by id. Shared by every session in
 *  this process — one process can host sessions of several projects, so every
 *  read that answers a session filters by that session's project scope. */
const runningSubagents = new Map<string, RunningSubagent>();

/** The project scope of a child: its recorded scope key, else the repo root
 *  of its working directory ("" when neither is known). */
function childScopeKey(running: RunningSubagent): string {
  return running.scopeKey ?? (running.cwd ? repoRootFor(running.cwd) : "");
}

/** Children whose project scope equals `scope` — the only ones a session in
 *  that project may list, name-match, or treat as duplicates. An entry with
 *  no recorded scope key predates scoping (or is a bare test fixture): it
 *  stays visible to every scope rather than invisible to all, while every
 *  production registration path pins the key (attachScopeKey). */
function runningInScope(scope: string): RunningSubagent[] {
  return Array.from(runningSubagents.values()).filter(
    (r) => r.scopeKey === undefined || r.scopeKey === scope,
  );
}

/** The project scope of a session: the repo root of its working directory. */
function currentScopeKey(ctx?: ExtensionContext | null): string {
  return repoRootFor(ctx?.cwd ?? latestCtx?.cwd ?? process.cwd());
}

/** Pin a child's project scope once, at registration. */
function attachScopeKey(running: RunningSubagent): void {
  if (!running.scopeKey) running.scopeKey = repoRootFor(running.cwd ?? process.cwd());
}

/** Caps simultaneous children: parallel spawns share one provider quota and
 * 429-storm it. `PI_SUBAGENT_MAX_CONCURRENT` (default 5, <1 = unlimited). */
const spawnQueue = new SpawnQueue(resolveMaxConcurrent(process.env.PI_SUBAGENT_MAX_CONCURRENT));

/** Spawns accepted while the cap was reached, waiting FIFO for a slot. The
 *  spawn tool must never block the parent turn on another child's runtime —
 *  a queued spawn returns an ack immediately and launches from the queue's
 *  release hook, keeping the same fire-and-forget result delivery. */
interface PendingSpawn {
  params: Static<typeof SubagentParams>;
  ctx: Parameters<typeof launchSubagent>[1];
  parentArtifactDir: string;
  reservedName: string | null;
  /** Declared-scope lock carried through the wait. Parsed-scope entries
   * carry `scope` only — parsed scope never locks. */
  scopeId?: string;
  scope?: SubagentScope;
}
const pendingSpawns: PendingSpawn[] = [];

/** PI_SUBAGENTS_SCOPE_MODE: "queue" (default) parks colliding declared
 * spawns behind their owner; "warn" runs them with a warning; "off" does no
 * scope tracking at all (prior-work injection is orthogonal and still runs). */
type ScopeMode = "queue" | "warn" | "off";
function resolveScopeMode(raw: string | undefined): ScopeMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "warn" || v === "off" ? v : "queue";
}

let scopeIdSeq = 0;
const nextScopeId = (): string => `scope-${process.pid}-${++scopeIdSeq}`;

/** Scope info threaded launchReservedSpawn → launchSubagent: the derived
 * scope always (injection + display), the lock id for declared scopes. */
interface ScopeInfo {
  scopeId?: string;
  scope: SubagentScope;
}

function scopeInfoOf(entry: { scopeId?: string; scope?: SubagentScope }): ScopeInfo | undefined {
  if (!entry.scope || entry.scope.origin === "none") return undefined;
  return entry.scopeId ? { scopeId: entry.scopeId, scope: entry.scope } : { scope: entry.scope };
}

/** Declared-scope conflict summary for ack texts: first owner + its first
 * few owned paths, plus a count of any further owners. */
function describeScopeConflicts(conflicts: ReturnType<typeof findConflicts>): string {
  const first = conflicts[0];
  const hits = first.hits.slice(0, 3).join(", ");
  const more = conflicts.length - 1;
  return (
    `overlaps "${first.name}" (owns ${hits}${first.hits.length > 3 ? ", …" : ""})` +
    (more > 0 ? ` and ${more} other owner${more > 1 ? "s" : ""}` : "")
  );
}

/** Set once any send fails on this module instance: the funnel then goes
 *  silent and the instance's timers disarm — a dead channel must cost one
 *  notice, never one diagnostic per tick flooding the terminal input line. */
let channelDead = false;

/** Diagnostics must never raw-print to the terminal: console.error from an
 *  extension lands in the TUI input editor region where the user is typing
 *  (identically on mac and Linux). Route every diagnostic through the host
 *  UI notify channel, which the TUI renders without touching the input line;
 *  fall back to stderr only when no UI exists (headless, print mode, tests). */
/** Every diagnostic text already emitted by this module instance. A repeated
 * condition (a persistent typo, a dead extension) otherwise repaints the TUI
 * input line on every spawn and resume; one notice per distinct text is enough
 * for the user to act on. Reload resets the set. */
const reportedDiagnostics = new Set<string>();

function reportDiagnostic(message: string): void {
  if (reportedDiagnostics.has(message)) return;
  reportedDiagnostics.add(message);
  const ui = latestCtx?.ui as { notify?: (text: string, severity?: string) => void } | undefined;
  if (latestCtx?.hasUI && typeof ui?.notify === "function") {
    try {
      ui.notify(message, "error");
      return;
    } catch {
      // A broken notify must not hide the diagnostic — fall through to stderr.
    }
  }
  console.error(message);
}

/** Disarm this instance's 1s timers and abort its poll loops — the same
 *  teardown shape as the /reload handshake and session_shutdown. An instance
 *  that can no longer deliver anything must stop ticking; durable artifacts
 *  and the next session's reconcile carry the rest. */
function disarmInstanceTimers(): void {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  if (widgetInterval) {
    clearInterval(widgetInterval);
    widgetInterval = null;
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  moduleAbort?.abort();
}

/** Send through `pi` while containing a failure of the channel itself: after
 *  a /reload this module instance is replaced but its watchers keep polling,
 *  and sends on the dead ExtensionAPI handle reject. That rejection must
 *  never escape as an unhandled rejection the host renders above the input
 *  editor — report once through the UI channel, disarm, and stay silent for
 *  the rest of the instance's life. */
function sendMessageContained(
  pi: ExtensionAPI,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  options: Parameters<ExtensionAPI["sendMessage"]>[1],
): void {
  if (channelDead) return;
  const diagnostic = (reportErr: unknown) => {
    if (channelDead) return; // one notice per instance, never one per tick
    channelDead = true;
    reportDiagnostic(
      `[pi-subagents] message could not be delivered (extension reloaded? channel gone): ` +
        `${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
    );
    disarmInstanceTimers();
  };
  try {
    Promise.resolve(pi.sendMessage(message, options)).catch(diagnostic);
  } catch (reportErr) {
    diagnostic(reportErr);
  }
}

/** Report a queued spawn that failed while leaving the queue — the sync
 *  throw and the async launch rejection share one message so neither path is
 *  silent (a queued spawn must never vanish without a result). */
function reportQueuedLaunchFailure(pi: ExtensionAPI, entry: PendingSpawn, err: unknown): void {
  // Parity with the slot release: a permanently failed queued launch frees
  // its declared scope too — a third spawn parked behind this entry waits on
  // an owner that will never run, and a freed slot alone cannot wake it.
  if (entry.scopeId) releaseScope(entry.scopeId);
  sendMessageContained(
    pi,
    {
      customType: "subagent_result",
      content: `Sub-agent "${entry.params.name}" failed to launch while leaving the queue: ${
        err instanceof Error ? err.message : String(err)
      }`,
      display: true,
      details: { name: entry.params.name, task: entry.params.task, error: String(err) },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Launch queued spawns as slots free; called from the queue's drain hook
 *  and (via the scope drain hook) when a declared scope is released.
 *  Skip-scan: walk the FIFO and launch every entry whose declared scope (if
 *  any) is conflict-free while slots last; conflicting entries stay parked
 *  AT THEIR ORIGINAL INDEX so disjoint tasks keep their parallel lanes and
 *  parked order is preserved. One launch failure must not strand the rest —
 *  report as a steer and keep draining. */
function drainPendingSpawns(): void {
  // Conflict check FIRST: acquiring a slot for a parked entry only to
  // release it again would re-fire this hook synchronously (release()
  // drains) and recurse — and a conflicting entry cannot launch anyway.
  for (let index = 0; index < pendingSpawns.length; ) {
    const next = pendingSpawns[index];
    // Declared scopes only (scopeId is reserved exclusively for files[]-
    // declared scopes): a slot-queued entry with a PARSED scope must never
    // park behind a declared owner — parsing noise may not serialize a wave.
    if (next.scopeId && next.scope && findConflicts(next.scope.paths, next.scopeId).length > 0) {
      index += 1; // parked behind a live owner — keep its place in line
      continue;
    }
    if (!spawnQueue.tryAcquire()) break; // slots exhausted
    pendingSpawns.splice(index, 1); // detach BEFORE launch (and before any release)
    const pi = latestPi;
    if (!pi) {
      // Extension API gone (shutdown): nothing can be launched or reported.
      // Free the slot FIRST — release() re-fires this hook synchronously, so
      // the entry must not be in the queue when that runs — then restore the
      // entry at its original index and stop this pass.
      spawnQueue.release();
      pendingSpawns.splice(index, 0, next);
      break;
    }
    try {
      if (next.scopeId && next.scope) {
        // Queued → running: the pane is about to exist. (name is always set
        // by the time an entry queues — the tool assigned or reserved it.)
        declareScope(next.scopeId, {
          name: next.params.name ?? next.params.agent ?? "subagent",
          paths: next.scope.paths,
          state: "running",
        });
      }
      // launchReservedSpawn is async and never throws synchronously: attach
      // the failure report to the promise, or a rejected queued launch dies as
      // an unhandled rejection with no result anywhere. It releases its slot
      // (and its scope) itself before re-throwing, so only the report is
      // needed here.
      void launchReservedSpawn(pi, next.params, next.ctx, next.parentArtifactDir, next.reservedName, scopeInfoOf(next)).catch(
        (err: unknown) => reportQueuedLaunchFailure(pi, next, err),
      );
    } catch (err) {
      spawnQueue.release();
      reportQueuedLaunchFailure(pi, next, err);
    }
  }
}
spawnQueue.setDrainHook(() => drainPendingSpawns());
setScopeDrainHook(() => drainPendingSpawns());

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Test seam: install a fake host context (UI notify channel) for
 *  diagnostics-routing tests. */
function setLatestCtxForTest(ctx: ExtensionContext | null): void {
  latestCtx = ctx;
}
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

/** Test seam: point the ask_question notify path at a fake host handle. */
function setLatestPiForTest(pi: ExtensionAPI | null): void {
  latestPi = pi;
}

/** Test seam: reset per-instance channel state between cases — latest host
 *  handle and any live 1s timers, so no case leaks into the next. */
function resetChannelStateForTest(): void {
  latestPi = null;
  channelDead = false;
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (widgetInterval) {
    clearInterval(widgetInterval);
    widgetInterval = null;
  }
}

/** Test seam: whether this instance's 1s timers are armed. */
function channelTimersActive(): { status: boolean; widget: boolean } {
  return { status: statusInterval != null, widget: widgetInterval != null };
}

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  currentScope?: string,
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    // Compact lock indicator for declared write scopes: glyph + path count.
    const scopeCount = agent.scope?.origin === "declared" ? agent.scope.paths.length : 0;
    const lockTag = scopeCount > 0 ? ` ${ACCENT}▣${RST}${scopeCount}` : "";
    // A child registered under another repo root (worktree, `cwd` param, a
    // second project in the same process) belongs to someone else's session.
    // It stays visible — dropping it made the whole widget disappear — but
    // dimmed and tagged with its own repo so the row is never mistaken for
    // this session's child.
    const foreignScope = currentScope !== undefined && childScopeKey(agent) !== currentScope;
    const nameCell = foreignScope ? `${ICON_DIM}${agent.name}${RST}` : agent.name;
    const foreignTag = foreignScope
      ? ` ${ICON_DIM}@${basename(childScopeKey(agent)) || "?"}${RST}`
      : "";
    const left = ` ${icon} ${elapsed}${lockTag}  ${nameCell}${agentTag}${foreignTag} `;
    // Metered usage tail on the right label; elapsed already leads the row.
    const usage = agent.budgetMeter?.update();
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot, usage)
      : agent.cli === "claude"
        ? ` running…${formatUsageTail(usage)} `
        : ` starting…${formatUsageTail(usage)} `;

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  try {
    if (!latestCtx?.hasUI) return;

  const scope = currentScopeKey();
  // Every registered child is drawn, own scope first: a spawn registers its
  // project scope from its own cwd, so filtering the render set by the
  // session's scope emptied the widget (and cleared it) whenever the two
  // disagreed, which looked exactly like "no subagents running".
  const children = Array.from(runningSubagents.values());
  const widgetAgents = [
    ...children.filter((r) => childScopeKey(r) === scope),
    ...children.filter((r) => childScopeKey(r) !== scope),
  ];
  if (widgetAgents.length === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(widgetAgents, width, scope);
        },
      };
    },
    { placement: "aboveEditor" },
  );
  } catch {
    // The ctx goes stale once the session is replaced or torn down (notably
    // right after a headless/print-mode run ends): `latestCtx.hasUI` then
    // throws. The widget is cosmetic — a dying session must never crash the
    // host process from a .then/.catch continuation.
  }
}

/**
 * Take a session's UI context and draw the widget immediately.
 *
 * Called from session_start: without it the widget stayed blank until the
 * next tool call replaced `latestCtx`, so a fresh session (or one reloaded
 * while children from an earlier spawn are still registered) showed an
 * empty subagent area and looked like nothing was running.
 */
function armWidgetForSession(ctx: ExtensionContext): void {
  latestCtx = ctx;
  if (runningSubagents.size > 0) startWidgetRefresh();
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  // No explicit tool restriction and no spawning grant → don't pass --tools at
  // all (the child keeps its default toolset).
  if (requested.length === 0 && !grantSpawning) return null;

  const allow = new Set(requested);
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools. A null allowlist means the spawn
  // was intentionally unrestricted (e.g. a fork clone) and is replayed as-is.
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    // Scan the manifest tree once per spawn, not once per allowlisted tool.
    const toolManifests = scanToolManifests(join(getAgentConfigDir(), "extensions"));
    for (const tool of loadout.toolAllowlist.split(",")) {
      if (!tool) continue;
      // Control tools resolve from no manifest by design: the sandbox builder
      // force-adds them, and every launch/resume path delivers them via its
      // own dedicated `-e subagent-done.ts` push alongside this replay — they
      // are known-delivered, not unknown names. Skip before the guard.
      if ((SUBAGENT_CONTROL_TOOLS as readonly string[]).includes(tool)) continue;
      const extPath = getToolExtensionPath(tool, toolManifests);
      if (extPath && existsSync(extPath)) {
        extPaths.add(extPath);
        continue;
      }
      // Built-ins need no extension; anything else that resolves to nothing
      // (typo, unregistered name, extension removed from disk) would silently
      // strip the tool from the child — say so once at spawn time instead.
      if (BUILTIN_TOOLS.has(tool)) continue;
      const near = closestToolName(tool, [
        ...toolManifests.keys(),
        ...BUILTIN_TOOLS,
        ...SUBAGENT_CONTROL_TOOLS,
        ...SPAWNING_TOOLS,
      ]);
      reportDiagnostic(
        `[pi-subagents] allowlisted tool "${tool}" resolves to no extension path — the child will NOT receive it` +
          (near ? ` (did you mean "${near}"?)` : ""),
      );
    }
    // Local addition (not upstream): re-enable extra global extensions inside
    // the sandbox. PI_SUBAGENT_EXTRA_EXTENSIONS (colon-separated paths)
    // overrides; default re-enables the permission-gate extension when present
    // so sandboxed subagents keep the parent session's context-economy guards.
    const { kept, dropped } = resolveExtraExtensions(defaultExtraExtensions());
    // A sandboxed child without its permission gate is the condition to
    // surface, never to skip silently — env entry or shipped default alike.
    for (const miss of dropped) {
      reportDiagnostic(`[pi-subagents] PI_SUBAGENT_EXTRA_EXTENSIONS entry not found, dropping: ${miss}`);
    }
    for (const extPath of kept) {
      if (!extPaths.has(extPath) && existsSync(extPath)) parts.push("-e", shellEscape(extPath));
    }
    for (const extPath of extPaths) {
      parts.push("-e", shellEscape(extPath));
    }
  }
}

/** Extra global extensions re-enabled inside a sandboxed child when
 * PI_SUBAGENT_EXTRA_EXTENSIONS (colon-separated paths) does not override.
 * The permission gate ships as an extension DIRECTORY
 * (<agent-home>/extensions/permission-gate with index.ts inside); the
 * extension loader resolves a directory argument to its index.ts. A ".ts"
 * suffix here points at a file that does not exist in a directory-based
 * layout, silently dropping the gate from every allowlisted spawn. */
function defaultExtraExtensions(): string[] {
  return (
    process.env.PI_SUBAGENT_EXTRA_EXTENSIONS ?? join(homedir(), ".pi", "agent", "extensions", "permission-gate")
  )
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Resolve extra-extension entries against disk at spawn-args build time:
 *  existing paths pass through; an entry ending in .ts/.js/.mjs whose file
 *  is absent but whose parent directory exists self-heals to that directory
 *  (the extension loader resolves a directory to its index.ts — the footgun
 *  documented above defaultExtraExtensions); anything else with no existing
 *  target is returned as dropped, once per path, so the caller warns instead
 *  of silently spawning children without the permission gate. Accepted
 *  trade-off: parent-dir existence is not proof of a loadable extension — a
 *  healed directory the extension loader rejects still leaves the child
 *  gateless with no warning from here. */
function resolveExtraExtensions(entries: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of entries) {
    const p = entry.trim();
    if (!p) continue;
    if (existsSync(p)) {
      kept.push(p);
      continue;
    }
    const ext = extname(p);
    if ((ext === ".ts" || ext === ".js" || ext === ".mjs") && existsSync(dirname(p))) {
      kept.push(dirname(p));
      continue;
    }
    if (!dropped.includes(p)) dropped.push(p);
  }
  return { kept, dropped };
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>, scope?: string): string {
  // Scope-aware: with a project scope, only same-project children count as
  // taken — another project reusing the name is isolation, not a conflict.
  // (Reserved names stay global: over-avoiding a parallel reservation in
  // another project only suffixes a default name; it never under-avoids.)
  const running = scope === undefined ? Array.from(runningSubagents.values()) : runningInScope(scope);
  const taken = new Set(running.map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function resolveRunningByName(
  name: string,
  scope?: string,
):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  // Scope-aware: a session only addresses children of its own project — a
  // same-named child in another project is invisible, never a hit or an
  // ambiguity. Without a scope (legacy callers) every child matches.
  const pool = scope === undefined ? Array.from(runningSubagents.values()) : runningInScope(scope);
  const matches = pool.filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = pool.map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/** How long a steer waits for a lost pane to heal (watcher restart or entry
 *  finalization) before giving up, and how often it rechecks. */
const STEER_HEAL_WAIT_MS = 5_000;
const STEER_HEAL_STEP_MS = 200;

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 *
 * A `can't find pane` failure is a race, not a verdict: the pane died moments
 * ago and the watcher is either restarting it (the entry's surface swaps) or
 * finalizing the entry (a pane_lost result is delivered). Wait briefly for
 * either outcome instead of stranding the message on a pane being replaced.
 */
/** Describe a failed tmux call for model-facing error text without relaying
 *  its raw output: execFile errors read `Command failed: tmux <argv>…\n<stderr>`
 *  and embedding them verbatim leaks multiplexer noise (`can't find pane: %N`)
 *  into the conversation. Keep the subcommand and name the target instead;
 *  errors that are not tmux-shaped pass through unchanged. */
function describeTmuxFailure(error: unknown, target: string): string {
  if (isPaneNotFound(error)) return `${target} is gone`;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : "";
  // A client/server version mismatch keeps failing every call until the
  // server restarts — say so instead of a generic subcommand failure.
  if (/server version is too old for client|protocol version mismatch/i.test(`${message}\n${stderr}`)) {
    return `tmux client/server version mismatch on ${target}: restart the tmux server (tmux kill-server) — panes reopen on demand`;
  }
  const subcommand = message.match(/^Command failed:\s*tmux\s+(\S+)/);
  if (subcommand) return `tmux ${subcommand[1]} failed on ${target}`;
  return message.trim();
}

/** Raw pane-failure text for the pane-error log entry. Unlike
 *  describeTmuxFailure this keeps the multiplexer's own words (`can't find
 *  pane: %N`) — the entry exists to preserve the raw failure in the
 *  session log; the TUI never shows it (raw multiplexer wording is
 *  user-facing noise). */
function rawPaneErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message.trim() : String(error ?? "").trim();
}

/** Record a pane failure as a custom message typed subagent_pane_error,
 *  stored in the session log but hidden from the TUI: pi's documented
 *  display semantics make display:false "hidden entirely" while the entry
 *  still lands in the log and model context. Raw multiplexer wording is
 *  user-facing noise — the loss result already describes the failure.
 *  Never triggers a turn; the loss result owns delivery through its own
 *  path. The renderer below stays registered so history sessions whose
 *  rows were written display:true still render. */
function reportPaneErrorRow(pi: ExtensionAPI, error: unknown, context: string): void {
  sendMessageContained(
    pi,
    {
      customType: "subagent_pane_error",
      content: `[pi-subagents] ${context}: ${rawPaneErrorText(error)}`,
      display: false,
    },
    { triggerTurn: false },
  );
}

/** Renderer for the pane-failure error row: one error-colored line prefixed
 *  "Error: " — the same shape the provider error row uses, so a tmux
 *  pane failure reads like any other harness error. */
function renderSubagentPaneError(
  message: { content?: unknown },
  _options: unknown,
  theme: { fg: (color: string, text: string) => string },
) {
  const text = typeof message.content === "string" ? message.content : String(message.content ?? "");
  if (!text) return undefined;
  return {
    invalidate() {},
    render(width: number): string[] {
      return [theme.fg("error", truncateToWidth(`Error: ${text}`, width))];
    },
  };
}

async function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
  opts: { healWaitMs?: number; stepMs?: number } = {},
): Promise<{ ok: true } | { error: string }> {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  const waitMs = opts.healWaitMs ?? STEER_HEAL_WAIT_MS;
  const stepMs = opts.stepMs ?? STEER_HEAL_STEP_MS;
  const deadline = Date.now() + waitMs;
  let surface = running.surface;
  for (;;) {
    try {
      send(surface, flattened);
      return { ok: true };
    } catch (error: any) {
      if (!isPaneNotFound(error)) {
        return {
          error:
            `Failed to deliver message to subagent "${running.name}" via tmux: ` +
            `${describeTmuxFailure(error, `pane ${surface}`)}`,
        };
      }
      // The watcher already delivered pane_lost and finalized this entry —
      // steering is over; a resend resolves to the resume path instead.
      if (!runningSubagents.has(running.id)) {
        return {
          error:
            `Sub-agent "${running.name}" lost its pane and its run has ended. ` +
            `Send the message again — the name now resolves to its session and ` +
            `the resend resumes it in a fresh pane.`,
        };
      }
      // The watcher restarted the child in a replacement pane — deliver there.
      if (running.surface !== surface) {
        surface = running.surface;
        continue;
      }
      if (Date.now() >= deadline) {
        return {
          error:
            `Failed to deliver message to subagent "${running.name}" via tmux: ` +
            `${describeTmuxFailure(error, `pane ${surface}`)} ` +
            `(pane loss did not heal within ${Math.round(waitMs / 1000)}s — retry, or send ` +
            `the message again to resume the session).`,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

/** Write a launch script to a stable path — the same file layout the old
 *  sendLongCommand delivery produced (shebang, optional preamble, command,
 *  mode 0755) — so a pane can be created already running it. */
function writeLaunchScript(scriptPath: string, command: string, preamble: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true });
  const scriptParts = ["#!/bin/bash"];
  if (preamble) scriptParts.push(preamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
}

/** The command a launch pane is born running: the script itself, the
 *  wait-for signal that wakes the watcher's poll the moment the script ends
 *  (`|| true` so a failed signal can never mask the sentinel echo the script
 *  already printed; the channel is generated hex, never shell-escaped so it
 *  stays visible in the pane command), and a trailing interactive shell so
 *  the pane — and its scrollback, where the sentinel echo lives — survives
 *  the script, matching the old typed-in-a-shell delivery. */
function launchPaneCommand(scriptPath: string, waitChannel: string): string {
  return (
    `bash ${shellEscape(scriptPath)}; ` +
    `tmux wait-for -S ${waitChannel} >/dev/null 2>&1 || true; ` +
    `exec "\${SHELL:-/bin/sh}"`
  );
}

/** Write the launch script, then create the pane born running it: one atomic
 *  split-window. No default-shell window ever exists, so there is no
 *  pane-died-before-delivery race, no respawn-pane, and no shell-ready wait.
 *  Returns the new surface. */
function launchScriptedPane(
  name: string,
  command: string,
  scriptPath: string,
  preamble: string,
  waitChannel: string,
  sessionName?: string,
): string {
  writeLaunchScript(scriptPath, command, preamble);
  return createSurfaceRunning(name, launchPaneCommand(scriptPath, waitChannel), sessionName);
}

/**
 * Resume a finished subagent session by name (the subagent_message tool's
 * resume branch). Extracted from the tool execute so unexpected throws — a
 * pane lost mid-delivery, a recovery that failed — surface as an actionable
 * { error } result instead of escaping as a raw tmux error.
 */
async function resumeSubagentByName(
  params: { name?: string; message?: string },
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const requestedName = params.name?.trim() ?? "";
  const pi = latestPi;
  if (!pi) throw new Error("Subagents extension API is unavailable; cannot resume.");
  try {
    const message = params.message;
    const name = requestedName; // identity preservation: the resumed run reclaims its name
    const { autoExit, interactive } = resolveResumeLaunchBehavior();
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);

    // Resolve the name to its session file via this session's registry.
    const parentArtifactDir = getArtifactDir(
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionId(),
    );
    const entry =
      resolveNameInRegistry(parentArtifactDir, requestedName) ??
      resolveNameInIndex(parentArtifactDir, requestedName);
    if (!entry) {
      const known = knownSubagentNames(parentArtifactDir);
      const err =
        `No subagent named "${requestedName}" in this session. ` +
        (known.length > 0
          ? `Known subagents: ${known.join(", ")}.`
          : "No subagents have been spawned in this session yet.");
      return { content: [{ type: "text" as const, text: err }], details: { error: err } };
    }

    const sessionPath = entry.sessionFile;
    if (!sessionPath || !existsSync(sessionPath)) {
      const err =
        `Subagent "${requestedName}" is registered but its session file is gone ` +
        `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
      return { content: [{ type: "text" as const, text: err }], details: { error: err } };
    }

    // Guard: never resume a session that is still running — two processes
    // mutating the same .jsonl corrupts it. Steer it by name instead.
    for (const r of runningSubagents.values()) {
      if (resolve(r.sessionFile) === resolve(sessionPath)) {
        const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
        return handleSubagentSteer({ name: r.name, message: params.message });
      }
    }

    // Reconstruct the sandbox a resume must replay. Without one the child
    // would relaunch with all global extensions and the full toolset, so a
    // missing sandbox is refused — but the spawn-time sidecar is not the
    // only record: the launch script plus its system-prompt file still
    // describe the same sandbox, so a lost sidecar no longer blocks resume.
    const resolvedLoadout = resolveResumeLoadout(parentArtifactDir, requestedName, sessionPath);
    if (!resolvedLoadout) {
      const err =
        `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
        `(no .loadout.json sidecar beside the session file, and no launch script under ` +
        `subagent-scripts/ to rebuild it from). ` +
        `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
        `Re-run the task as a fresh subagent instead.`;
      return { content: [{ type: "text" as const, text: err }], details: { error: err } };
    }
    const loadout = resolvedLoadout.loadout;

    const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

    // Record entry count before resuming so we can extract new messages.
    // Count lines cheaply (no per-line JSON.parse) so resuming a large
    // transcript doesn't block the UI.
    const entryCountBefore = countSessionEntryLines(sessionPath);

    // Build pi resume command
    const parts = ["pi", "--session", shellEscape(sessionPath)];

    // Load subagent-done extension so the agent can self-terminate if needed
    const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
    parts.push("-e", shellEscape(subagentDonePath));

    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    // Replay the model, identity, and default-deny tool/extension sandbox.
    applySandboxToParts(parts, loadout, { artifactDir, name });

    let resumeMsgFile: string | undefined;
    if (message) {
      const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      resumeMsgFile = join(
        artifactDir,
        "subagent-resume",
        `${name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
      );
      mkdirSync(dirname(resumeMsgFile), { recursive: true });
      writeFileSync(resumeMsgFile, message, "utf8");
      parts.push(shellEscape(`@${resumeMsgFile}`));
    }

    // Build env prefix — replay the snapshot's config dir + spawn whitelist
    // so the resumed process resolves the same agents/extensions and keeps
    // the same nested-spawn restriction it originally ran with.
    const resumeEnvParts: string[] = [];
    const resumeAgentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
    if (resumeAgentDir) {
      resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumeAgentDir)}`);
    }
    if (loadout.spawnable && loadout.spawnable.length > 0) {
      resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
    }
    if (loadout.agent) {
      resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
    }
    resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
    resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
    resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
    resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
    if (autoExit) {
      resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
    }
    const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

    // Resume in the subagent's original cwd so its tools (safe_bash, edits)
    // operate where they did before.
    const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

    const command = `${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
    const launchScriptFile = join(
      artifactDir,
      "subagent-scripts",
      `${name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
    );
    // Write the script, then create the pane born running it — atomic, so a
    // fast-exit default shell can no longer kill the pane before delivery.
    const waitChannel = `pi-subagent-${id}`;
    const surface = launchScriptedPane(
      name,
      command,
      launchScriptFile,
      [
        `# Subagent resume script for ${name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${sessionPath}`,
        ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
      ].join("\n"),
      waitChannel,
      agentsSessionNameFor(currentScopeKey()),
    );

    await spawnQueue.acquire();

    // Register as a running subagent for widget tracking
    const running: RunningSubagent = {
      id,
      name,
      task: message ?? "",
      surface,
      waitChannel,
      autoExit: true,
      startTime,
      sessionFile: sessionPath,
      parentArtifactDir,
      launchScriptFile,
      activityFile,
      interactive,
      ...budgetRuntimeFields(
        // Resume is the recovery path: the loadout budget that killed the
        // child would re-breach instantly against the re-metered session
        // file, so resumes run unenforced.
        null,
        surface,
        sessionPath,
      ),
      statusState: createStatusState({
        source: "pi",
        startTimeMs: startTime,
      }),
    };
    attachScopeKey(running);
    runningSubagents.set(id, running);
    startWidgetRefresh();
    startStatusRefresh(pi);

    // Fire-and-forget watcher
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    watchSubagent(running, watcherAbort.signal)
      .then((result) => {
        updateWidget();

        if (running.delivered) return; // sweep already finalized this entry
        const allEntries = getNewEntries(sessionPath, entryCountBefore);
        const summary = findLastAssistantMessage(allEntries) ??
          (result.errorMessage
            ? `Subagent error: ${result.errorMessage}`
            : result.exitCode !== 0
              ? `Resumed session exited with code ${result.exitCode}`
              : "Resumed session exited without new output");
        const presentation = resolveResultPresentation(
          { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId },
          name,
        );
        running.delivered = true;
        persistResultRecord(running, { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId });

        sendMessageContained(
          pi,
          {
            customType: "subagent_result",
            content: presentation,
            display: true,
            details: {
              name,
              task: message,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: sessionPath,
              sessionId: resumedSessionId,
              ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      })
      .catch((err) => {
        updateWidget();
        sendMessageContained(
          pi,
          {
            customType: "subagent_result",
            content: `Resume error: ${err?.message ?? String(err)}`,
            display: true,
            details: { name, error: err?.message },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      })
      .finally(() => spawnQueue.release());

    return {
      content: [{ type: "text", text: `Session "${name}" resumed.` }],
      details: {
        id,
        name,
        sessionId: resumedSessionId,
        sessionFile: sessionPath,
        launchScriptFile,
        status: "started",
      },
    };
  } catch (err) {
    // describeTmuxFailure keeps multiplexer stderr (`can't find pane: %N`)
    // out of the model-facing text; non-tmux errors pass through unchanged.
    const failure = describeTmuxFailure(err, "the replacement pane");
    const text =
      `Could not resume subagent "${params.name}": ${failure} ` +
      `(pane loss recovery was attempted and failed). The session file is intact — ` +
      `send the message again to retry the resume in a fresh pane.`;
    return { content: [{ type: "text" as const, text }], details: { error: text } };
  }
}

async function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "", currentScopeKey());
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = await steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    runStatusRefreshTick(pi);
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

/** One status-refresh tick: observe every running child, advance its status
 *  machine, drive stalled-child recovery, and run the reconciliation sweep.
 *  Status cosmetics (widget refresh, transition steers) apply only when the
 *  status config is enabled — liveness, recovery, and the sweep always run,
 *  so result delivery never depends on cosmetics. Extracted from the interval
 *  so tests can drive ticks with an injected clock and pane list. */
function runStatusRefreshTick(
  pi: ExtensionAPI,
  now: number = Date.now(),
  opts: { listPanes?: () => Promise<Set<string> | null> } = {},
): void {
  const transitionLines: string[] = [];
  let shouldRefreshWidget = false;

  for (const running of runningSubagents.values()) {
    observeRunningSubagent(running, now);
    const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
    if (nextState.currentKind !== running.statusState.currentKind) {
      shouldRefreshWidget = true;
    }
    running.statusState = nextState;

    // Stalled-child recovery: nudge on the stall transition, grace-lapse
    // check on every other tick. Runs regardless of status cosmetics.
    if (transition === "stalled") handleStallTransition(pi, running, now);
    else enforceStallRecovery(pi, running, now);

    // Interactive subagents (long-running, user-driven) intentionally don't
    // wake the parent session on stalled/recovered transitions — the user is
    // working in the subagent's pane, and a steer message here would burn an
    // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
    if (transition && !running.interactive && statusConfig.enabled) {
      transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
    }
  }

  // Reconciliation sweep: finalize entries whose pane is gone or whose
  // session file stalled — delivery must not depend on the poll loop.
  sweepRunningSubagents({
    runningSubagents,
    listPanes: opts.listPanes ?? listLiveSurfaces,
    finalize: (entry, kind) => finalizeLostSubagent(pi, entry as RunningSubagent, kind),
  }).catch(() => {});

  if (!statusConfig.enabled) return;

  if (shouldRefreshWidget) updateWidget();

  if (transitionLines.length > 0) {
    const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
    sendMessageContained(
      pi,
      {
        customType: "subagent_status",
        content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
        display: true,
        details: { lines: capped.visibleLines, overflow: capped.overflow },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  clearAgentDefCache: () => agentDefCache.clear(),
  pendingSpawns,
  resetSpawnQueue: () => spawnQueue.resetForTest(),
  renderSubagentWidgetLines,
  updateWidget,
  armWidgetForSession,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  defaultExtraExtensions,
  resolveExtraExtensions,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  synthesizeLostResult,
  canRestartLostPane,
  restartLostPane,
  finalizeLostSubagent,
  reportPaneErrorRow,
  renderSubagentPaneError,
  cancelRunningSubagent,
  cancelQueuedSpawn,
  restartSubagent,
  synthesizeCancelledResult,
  handleStallTransition,
  enforceStallRecovery,
  buildStallHealthCheckCommand,
  runStatusRefreshTick,
  statusConfig,
  watchSubagent,
  deliverSubagentResult,
  findChildSelfReport,
  adoptPendingSubagents,
  steerSubagent,
  resumeSubagentByName,
  launchSubagent,
  handleSubagentSteer,
  resolveResultPresentation,
  capResultSummary,
  resolveResumeLaunchBehavior,
  runningSubagents,
  runningInScope,
  childScopeKey,
  currentScopeKey,
  handleSessionShutdown,
  sendMessageContained,
  deliverPendingQuestion,
  setLatestPi: setLatestPiForTest,
  setUiContext: setLatestCtxForTest,
  resetChannelState: resetChannelStateForTest,
  startWidgetRefresh,
  startStatusRefresh,
  channelTimersActive,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  deriveScope,
  parseTaskPaths,
  intersectFilesChanged,
  declareScope,
  releaseScope,
  findConflicts,
  scopedChildren,
  resetScopeRegistry,
  resolveScopeMode,
  agentOfHistoryName,
  agentBaselineFor,
  formatBaselineLine,
  tasksNearIdentical,
  findDuplicateSpawn,
  annotatePastP90,
  formatChildMetricsLine,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: builds the command, writes its launch script, and
 * creates a multiplexer pane born running that script — one atomic step.
 * Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
/** Launch a spawn that already holds a queue slot — the shared pipeline for
 *  the immediate path and the queued-drain path: create the child, register
 *  its name, start the fire-and-forget watcher, and release the slot (which
 *  drains the next queued spawn) when the watcher settles. Launch failures
 *  release the slot too, so one bad spawn never strands the queue. */
async function launchReservedSpawn(
  pi: ExtensionAPI,
  params: Static<typeof SubagentParams>,
  ctx: Parameters<typeof launchSubagent>[1],
  parentArtifactDir: string,
  reservedName: string | null,
  scopeInfo?: ScopeInfo,
): Promise<RunningSubagent> {
  let running: RunningSubagent;
  try {
    running = await launchSubagent(params, ctx, scopeInfo);
  } catch (err) {
    spawnQueue.release();
    // The declared scope was reserved before the launch attempt — a failed
    // launch must give the lock back or it leaks forever.
    if (scopeInfo?.scopeId) releaseScope(scopeInfo.scopeId);
    // Wrap, never re-throw verbatim: a raw tmux failure here (pane lost
    // mid-launch) reads as internal noise; the wrap names the subagent, and
    // describeTmuxFailure keeps multiplexer stderr (`can't find pane: %N`)
    // out of the model-facing text.
    throw new Error(
      `Failed to launch subagent "${params.name}": ` +
        `${describeTmuxFailure(err, "the launch pane")}`,
    );
  } finally {
    if (reservedName) reservedNames.delete(reservedName);
  }

  // Persist name → session so subagent_message({ name }) can resume this
  // subagent after it finishes (and after a pi restart). Done at launch,
  // not completion, so the handle exists even if the parent dies mid-run.
  registerName(parentArtifactDir, running.name, {
    sessionFile: running.sessionFile,
    sessionId: getSessionId(running.sessionFile),
  });
  // Append-only companion to the registry: the registry file is rewritten on
  // every spawn, so a lost/rewritten registry would strand resume-by-name.
  // This line is never rewritten, and resume falls back to it.
  appendSessionIndex(parentArtifactDir, {
    name: running.name,
    sessionFile: running.sessionFile,
    sessionId: getSessionId(running.sessionFile),
  });

  // Create a separate AbortController for the watcher
  // (the tool's signal completes when we return)
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  // Start widget refresh and status supervision when the first agent launches
  startWidgetRefresh();
  startStatusRefresh(pi);

  // Fire-and-forget: start watching in background
  watchSubagent(running, watcherAbort.signal)
    .then((result) => {
      updateWidget(); // reflect removal from Map immediately
      deliverSubagentResult(pi, running, result);
    })
    .catch((err) => {
      updateWidget();
      // The report channel itself can fail (extension reloaded): contain it.
      sendMessageContained(
        pi,
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .finally(() => spawnQueue.release());

  return running;
}

async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | undefined; getSessionId(): string; getSessionDir(): string }; cwd: string },
  scopeInfo?: ScopeInfo,
): Promise<RunningSubagent> {
  if (!params.name?.trim()) throw new Error("launchSubagent: params.name is required (the spawn handler assigns a unique name before launching)");
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const budget = resolveBudget(agentDefs?.budget, params.budget, statusConfig.budgetDefaults);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  // An agent with a non-empty subagent_agents list is granted the spawning
  // toolset and may only spawn the listed agents (enforced via PI_SUBAGENT_ALLOWED).
  const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  // Prior-work injection: when the child carries a scope (declared or
  // parsed), append what recent history says about those paths so a later
  // wave does not re-read files an earlier child already changed. Orthogonal
  // to scope locking — it runs in every PI_SUBAGENTS_SCOPE_MODE. Scope paths
  // are absolute; history paths are repo-relative, so relativize first.
  const scopeRepoRoot = repoRootFor(targetCwdForSession);
  const priorWorkBlock =
    scopeInfo && scopeInfo.scope.paths.length > 0
      ? buildPriorWorkBlock(
          readRecentResults(scopeRepoRoot, 20),
          scopeInfo.scope.paths
            .map((p) => relative(scopeRepoRoot, p))
            .filter((p) => p !== "" && !p.startsWith("..")),
          { historyPath: subagentHistoryPath(scopeRepoRoot) },
        )
      : null;
  const fullTask =
    (inheritsConversationContext
      ? params.task
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`) +
    (priorWorkBlock ? `\n\n${priorWorkBlock}` : "");
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    const waitChannel = `pi-subagent-${id}`;
    const surface = launchScriptedPane(
      params.name,
      command,
      launchScriptFile,
      [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
      ].join("\n"),
      waitChannel,
      agentsSessionNameFor(scopeRepoRoot),
    );

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      waitChannel,
      startTime,
      sessionFile: subagentSessionFile,
      parentArtifactDir: artifactDir,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      cwd: effectiveCwd ?? process.cwd(),
      parentSessionId: sessionId,
      ...(scopeInfo && scopeInfo.scope.origin !== "none" ? { scope: scopeInfo.scope } : {}),
      ...(scopeInfo?.scopeId ? { scopeId: scopeInfo.scopeId } : {}),
      ...budgetRuntimeFields(budget, surface, subagentSessionFile),
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    attachScopeKey(running);
    runningSubagents.set(id, running);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Default-deny model: when an agent restricts its tools (or is granted the
  // spawning toolset), we disable global extension discovery and re-enable only
  // the extensions backing the whitelisted tools. Bare/fork spawns with no tool
  // restriction keep their full default toolset and all global extensions.
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, { grantSpawning });

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: agentDefs?.autoExit ?? false,
    budget,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  if (grantSpawning && agentDefs?.subagentAgents) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(agentDefs.subagentAgents.join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_TASK=${shellEscape(params.task)}`);
  envParts.push(`PI_SUBAGENT_PARENT_SESSION=${shellEscape(sessionId ?? "")}`);
  envParts.push(`PI_SUBAGENT_START_MS=${Date.now()}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  // The pane id does not exist until the pane is created below; the pane's
  // own tmux environment carries it, so expand it at run time inside the pane.
  envParts.push(`PI_SUBAGENT_SURFACE="\${TMUX_PANE}"`);
  // Spawn-time git baseline for files_changed tracking. The path resolves
  // synchronously so PI_SUBAGENT_BASELINE rides the pane env; the porcelain
  // capture and file write run asynchronously — a spawn must never block on
  // git, and the child guards a missing/empty baseline itself.
  const gitBaselinePath = prepareGitBaseline(
    join(artifactDir, `${id}.git-baseline.json`),
    targetCwdForSession,
    boundedGitAsync,
  );
  if (gitBaselinePath) {
    envParts.push(`PI_SUBAGENT_BASELINE=${shellEscape(gitBaselinePath)}`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${params.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  // Write the script, then create the pane born running it: one atomic
  // split-window, no default-shell window, no respawn, no shell-ready wait.
  const waitChannel = `pi-subagent-${id}`;
  const surface = launchScriptedPane(
    params.name,
    command,
    launchScriptFile,
    [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
    ].join("\n"),
    waitChannel,
    agentsSessionNameFor(scopeRepoRoot),
  );

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    waitChannel,
    startTime,
    sessionFile: subagentSessionFile,
    parentArtifactDir: artifactDir,
    ...(gitBaselinePath ? { gitBaselinePath } : {}),
    ...(scopeInfo && scopeInfo.scope.origin !== "none" ? { scope: scopeInfo.scope } : {}),
    ...(scopeInfo?.scopeId ? { scopeId: scopeInfo.scopeId } : {}),
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    autoExit: !!agentDefs?.autoExit,
    cwd: effectiveCwd ?? process.cwd(),
    parentSessionId: sessionId,
    ...budgetRuntimeFields(budget, surface, subagentSessionFile),
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  attachScopeKey(running);
  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(askFile);
  } catch {}
  if (!payload?.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  if (latestPi) sendMessageContained(
    latestPi,
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Budget-runtime fields shared by every RunningSubagent literal: the resolved
 * ceiling, an incremental session meter, and the interrupt→grace→kill stopper.
 * A null budget (agent `budget: none`, nothing declared, or a resume after a
 * budget-caused death) attaches nothing — the child can never be budget-killed. */
function budgetRuntimeFields(
  budget: EnforcedBudget,
  surface: string,
  sessionFile: string,
): Pick<RunningSubagent, "budget" | "budgetMeter" | "budgetStopper"> {
  if (!budget) return {};
  return {
    budget,
    budgetMeter: createSessionBudgetMeter(sessionFile),
    budgetStopper: createBudgetStopper({
      interrupt: () => {
        try {
          sendInterrupt(surface);
        } catch {}
      },
      kill: () => {
        try {
          closeSurface(surface);
        } catch {}
      },
      graceMs: BUDGET_GRACE_MS,
      now: () => Date.now(),
    }),
  };
}

function budgetBreachSummary(breach: BudgetBreach): string {
  const unit =
    breach.dimension === "costUsd"
      ? "USD"
      : breach.dimension === "turns"
        ? "assistant turns"
        : "wall-clock seconds";
  return `Budget exceeded: ${breach.dimension} ${breach.value}/${breach.limit} (${unit}).`;
}

/** Poll-tick budget enforcement: meter the session file, then either raise the
 * breach (interrupting the child) or advance an existing breach toward kill. */
function enforceBudget(running: RunningSubagent): void {
  const { budget, budgetMeter, budgetStopper, startTime } = running;
  if (!budget || !budgetMeter || !budgetStopper) return;
  if (budgetStopper.breached()) {
    budgetStopper.onTick();
    return;
  }
  const breach = checkBudgetExceeded(budget, budgetMeter.update(), Date.now() - startTime);
  if (breach) budgetStopper.onBreach(breach);
}

/** Synthesize a result for a child whose pane vanished or stalled: derived
 * from the durable session file, never from the pane. A confirmed budget
 * breach (stopper state or a fresh meter reading) wins over the loss kind,
 * so a budget-killed child still reports budget_exceeded. */
function synthesizeLostResult(
  running: RunningSubagent,
  kind: "pane_lost" | "stalled",
): SubagentResult {
  // Cancel intent wins over the loss kind: the stop below was parent-driven,
  // so the delivery must not misreport it as a pane loss.
  if (running.cancelledAt) return synthesizeCancelledResult(running);
  const { name, task, sessionFile, startTime } = running;
  // Single read: parse once, derive summary + stats + id from the same
  // entries — the loss path used to re-read the whole file three times.
  const fileExists = existsSync(sessionFile);
  const entries = fileExists ? getNewEntries(sessionFile, 0) : [];
  running.parsedEntries = entries;
  const lastText = fileExists ? findLastAssistantMessage(entries) : null;
  const stats = fileExists ? summarizeStatsFromEntries(entries) : null;
  const sessionId = fileExists ? getSessionIdFromEntries(entries) : null;
  const breach =
    running.budgetStopper?.breached() ??
    (running.budget && running.budgetMeter
      ? checkBudgetExceeded(running.budget, running.budgetMeter.update(), Date.now() - startTime)
      : null);
  const lossLine =
    kind === "pane_lost"
      ? "Pane lost: the child's terminal pane disappeared (reaped or killed) before it could report."
      : "Stalled: the child's session file stopped advancing; treated as dead.";
  const restartLine =
    kind === "pane_lost" && running.restart?.respawnedAt
      ? "\n\nAn automatic restart was attempted: the child was resumed in a replacement pane, and that pane was lost too."
      : "";
  const summary =
    (breach ? budgetBreachSummary(breach) : lossLine) +
    restartLine +
    (lastText ? `\n\nLast output:\n${lastText}` : "");
  return {
    name,
    task,
    summary,
    sessionFile,
    ...(sessionId ? { sessionId } : {}),
    exitCode: -1,
    elapsed: Math.floor((Date.now() - startTime) / 1000),
    ...(breach
      ? { error: "budget_exceeded", errorMessage: budgetBreachSummary(breach) }
      : { error: "pane_lost" }),
    ...(stats ? { stats } : {}),
  };
}

/** Synthesize a result for a child stopped by its parent (subagent_control
 *  cancel): the same durable-session derivation as the loss path, minus the
 *  budget-breach upgrade — a cancelled child was not budget-killed. */
function synthesizeCancelledResult(running: RunningSubagent): SubagentResult {
  const { name, task, sessionFile, startTime } = running;
  const fileExists = existsSync(sessionFile);
  const entries = fileExists ? getNewEntries(sessionFile, 0) : [];
  running.parsedEntries = entries;
  const lastText = fileExists ? findLastAssistantMessage(entries) : null;
  const stats = fileExists ? summarizeStatsFromEntries(entries) : null;
  const sessionId = fileExists ? getSessionIdFromEntries(entries) : null;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const summary =
    `Cancelled by parent after ${formatElapsed(elapsed)}.` +
    (lastText ? `\n\nLast output:\n${lastText}` : "");
  return {
    name,
    task,
    summary,
    sessionFile,
    ...(sessionId ? { sessionId } : {}),
    exitCode: -1,
    elapsed,
    error: "cancelled_by_parent",
    ...(stats ? { stats } : {}),
  };
}

// ── Delivery-path git bounds and the child/parent files_changed merge ──

/** Bound for every git exec the result-delivery path makes. A wedged git
 * (hung mount, stale index lock) must never stall delivery — it is the
 * parent's one-shot funnel for the child's outcome. Both runners stay
 * fail-soft: a timeout kill is just another git failure. The timeout kill
 * uses SIGKILL — a wedged git can ignore SIGTERM and would otherwise
 * outlive its own bound and still block delivery. */
const GIT_BOUND_MS = 5_000;

const boundedGitSync: GitRunner = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_BOUND_MS,
    killSignal: "SIGKILL",
  }) as string;

const boundedGitAsync: AsyncGitRunner = (args, cb) => {
  try {
    execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: GIT_BOUND_MS, killSignal: "SIGKILL" },
      (err, stdout) => cb(err ? null : (stdout as string)),
    );
  } catch {
    cb(null);
  }
};

/** The child's own durable record for `id`, if it self-reported before the
 * parent delivered (same id, observedByParent false, ts at/after this run's
 * start). The drain keeps the LAST record per id, so a parent record that
 * omits files_changed — its git delta failed — would strip the child's
 * already-durable value from the durable view. Returns the last matching
 * record, or null. */
function findChildSelfReport(
  id: string,
  repoRoot: string,
  startTime: number,
): { files_changed?: string[]; files_changed_source?: "git_status_delta" } | null {
  const inboxPath = process.env.PI_SUBAGENT_INBOX || resultInboxPath(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(inboxPath, "utf8");
  } catch {
    return null;
  }
  let found: { files_changed?: string[]; files_changed_source?: "git_status_delta" } | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as {
        id?: unknown;
        ts?: unknown;
        observedByParent?: unknown;
        files_changed?: unknown;
        files_changed_source?: unknown;
      };
      // Adopt only the child's OWN fresh self-report: parent-observed
      // records and stale same-id records from an earlier run of this id
      // never qualify.
      if (
        rec.id !== id ||
        rec.observedByParent !== false ||
        typeof rec.ts !== "number" ||
        rec.ts < startTime ||
        !Array.isArray(rec.files_changed)
      ) continue;
      found = {
        files_changed: rec.files_changed as string[],
        ...(rec.files_changed_source === "git_status_delta"
          ? { files_changed_source: "git_status_delta" }
          : {}),
      };
    } catch {
      // Crash-torn line: skip it — a later record for the same id still wins.
    }
  }
  return found;
}

/** Append a finished (or synthesized) result to the child's repo durable
 * inbox — always BEFORE in-memory delivery, so the result survives pane,
 * parent, or extension-process death. `historyExtra` (files the child read,
 * a capped diff) goes to the append-only history file only. */
function persistResultRecord(
  running: RunningSubagent,
  result: SubagentResult,
  synthesized?: "pane_lost" | "stalled" | "cancelled_by_parent",
  historyExtra?: SubagentHistoryExtra,
): void {
  appendSubagentResult(
    {
      id: running.id,
      ts: Date.now(),
      name: result.name,
      task: result.task,
      agent: running.agent,
      sessionFile: result.sessionFile ?? running.sessionFile,
      sessionId: result.sessionId,
      parentSessionId: running.parentSessionId ?? null,
      observedByParent: true,
      repoRoot: repoRootFor(running.cwd ?? process.cwd()),
      summary: result.summary,
      error: result.error,
      errorMessage: result.errorMessage,
      exitCode: result.exitCode,
      elapsed: result.elapsed,
      ...(result.stats ? { stats: result.stats } : {}),
      ...(synthesized ? { synthesized } : {}),
      ...(result.files_changed ? { files_changed: result.files_changed } : {}),
      ...(result.files_changed_source ? { files_changed_source: result.files_changed_source } : {}),
    },
    historyExtra,
  );
}

/** Deliver a subagent result exactly once: durable inbox write first, then
 * the in-memory steer to the parent, then entry cleanup. Idempotent per entry
 * (the delivered flag) — the sweep and the watcher can race without the
 * parent ever seeing two results. */
function deliverSubagentResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: SubagentResult,
  synthesized?: "pane_lost" | "stalled" | "cancelled_by_parent",
): void {
  if (running.delivered) return; // sweep or watcher already finalized this entry
  // Transient provider death (429 / 5xx / overload): the session file already
  // holds the child's context, so one automatic resume of the SAME session
  // beats delivering a failure the orchestrator would answer with a fresh
  // spawn — that re-pays the whole context. canRestartLostPane caps this at
  // one attempt per child and refuses when the sandbox snapshot is missing;
  // the second call falls through to delivery (restart flag now set).
  if (
    result.errorMessage &&
    isTransientProviderError(result.errorMessage) &&
    canRestartLostPane(running)
  ) {
    void restartLostPane(running)
      .then((respawned) => {
        if (respawned) {
          reportDiagnostic(
            `[pi-subagents] "${running.name}" hit a transient provider error — resuming its session instead of failing it`,
          );
          return;
        }
        if (!running.delivered) deliverSubagentResult(pi, running, result);
      })
      .catch(() => {
        if (!running.delivered) deliverSubagentResult(pi, running, result);
      });
    return;
  }
  running.delivered = true;
  // Final meter read (O(delta) since the last poll tick): the turn count the
  // budget stopper enforced, mirrored into the history row below.
  const finalTurns = running.budgetMeter?.update().turns;
  // Parent-side git delta at delivery time: the same baseline the child
  // diffs against, so both records agree modulo seconds of skew. The richer
  // context (files the child read, a capped diff) enriches the history file
  // only — the drain-managed inbox record stays lean.
  let historyExtra: SubagentHistoryExtra | undefined;
  if (typeof finalTurns === "number") historyExtra = { turns: finalTurns };
  if (running.gitBaselinePath) {
    const filesChanged = computeFilesChanged(running.gitBaselinePath, boundedGitSync);
    if (filesChanged) {
      // Scope-intersect: when the child DECLARED its scope (files[]), attribute
      // only the changes inside it — the whole-repo baseline would otherwise
      // bill sibling children's edits to this one. Parsed task-text scope is
      // advisory (injection matching + display only): edits to files the task
      // never named stay in files_changed. No scope keeps the raw delta; the
      // provenance marker stays advisory either way.
      result.files_changed =
        running.scope?.origin === "declared" && running.scope.paths.length > 0
          ? intersectFilesChanged(filesChanged, running.scope.paths, repoRootFor(running.cwd ?? process.cwd()))
          : filesChanged;
      result.files_changed_source = "git_status_delta";
      const filesRead = extractFilesRead(
        result.sessionFile ?? running.sessionFile,
        running.parsedEntries,
      );
      const diff = gitDiffForBaseline(running.gitBaselinePath, filesChanged, boundedGitSync);
      historyExtra = {
        ...historyExtra,
        ...(filesRead?.length ? { files_read: filesRead } : {}),
        ...(diff ? { diff } : {}),
      };
    } else if (!result.files_changed) {
      // Parent delta null (git failed / baseline unreadable): adopt the
      // child's already-durable files_changed instead of stripping it — the
      // drain keeps the last record per id, and this record is the last.
      const child = findChildSelfReport(
        running.id,
        repoRootFor(running.cwd ?? process.cwd()),
        running.startTime,
      );
      if (child?.files_changed) {
        result.files_changed = child.files_changed;
        result.files_changed_source = child.files_changed_source ?? "git_status_delta";
      }
    }
  }
  persistResultRecord(running, result, synthesized, historyExtra);
  runningSubagents.delete(running.id);
  // THE scope-release funnel — every finalization (watcher exit, reconcile
  // sweep, budget kill) passes through here. The delete sites inside
  // watchSubagent run before delivery and must NOT release; restart never
  // deletes (the entry mutates in place, so the reservation survives); the
  // resume path constructs unscoped entries. Releasing may unpark spawns
  // queued behind this owner — the scope drain hook fires synchronously and
  // the watcher's slot release re-drains regardless.
  if (running.scopeId) releaseScope(running.scopeId);
  try {
    running.abortController?.abort();
  } catch {}
  try {
    closeSurface(running.surface);
  } catch {}
  updateWidget();
  // Contained: a stale post-/reload watcher's ExtensionAPI handle rejects
  // every send — the result report must not become an unhandled rejection.
  sendMessageContained(
    pi,
    {
      customType: "subagent_result",
      content: resolveResultPresentation(result, running.name),
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.stats ? { stats: result.stats } : {}),
        ...(synthesized ? { synthesized } : {}),
        ...(result.files_changed ? { files_changed: result.files_changed } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Dependencies of a pane-loss restart; injectable so tests can fake the
 *  multiplexer. Production callers use the real surface layer. */
interface RestartDeps {
  /** Atomic pane creation: the pane is born running paneCommand. */
  createSurfaceRunning?: (name: string, paneCommand: string) => string;
  /** Launch-script writer (file layout shared with every spawn path). */
  writeScript?: (scriptPath: string, command: string, preamble: string) => void;
  /** Restart executor (defaults to restartLostPane); injectable so tests can
   *  observe or fail the attempt without touching the surface layer. */
  restart?: (running: RunningSubagent, deps: RestartDeps) => Promise<boolean>;
}

/** Dependencies of stalled-child recovery; injectable so tests can fake the
 *  pane channel, the restart, and the grace window. Production callers use
 *  the real surface layer. */
interface StallRecoveryDeps extends RestartDeps {
  /** Interrupt channel (tmux C-c in production). */
  interrupt?: (surface: string) => void;
  /** Keystroke channel for the health-check steer. */
  sendCommand?: (surface: string, command: string) => void;
  /** Grace window override; defaults to the env-tunable resolution. */
  graceMs?: number;
}

/** Gates for the one automatic pane-loss restart. A child qualifies only if
 *  it self-terminates (interactive panes are user-driven — respawning one
 *  would strand the user's context), is a pi child (the restart resumes the
 *  session file with the pi CLI), has real progress worth resuming, has
 *  neither been restarted before nor already delivered, and was not killed
 *  by its own budget (a budget stop is intentional — restarting would
 *  bypass it). */
function canRestartLostPane(running: RunningSubagent): boolean {
  if (running.delivered) return false;
  if (running.restart) return false; // exactly one attempt per child
  if (running.cancelledAt) return false; // parent cancelled it — never resurrect
  if (running.interactive || !running.autoExit) return false;
  if (running.cli === "claude") return false;
  if (running.budgetStopper?.breached()) return false;
  if (
    running.budget &&
    running.budgetMeter &&
    checkBudgetExceeded(running.budget, running.budgetMeter.update(), Date.now() - running.startTime)
  ) {
    return false;
  }
  if (!existsSync(running.sessionFile)) return false;
  return findLastAssistantMessage(getNewEntries(running.sessionFile, 0)) !== null;
}

/** Restart a pane-lost child: create a pane born resuming its durable session
 *  file with the sandbox snapshot recorded at spawn (mirrors the
 *  subagent_message resume construction). Returns true when a replacement
 *  pane is running the resumed child; false when the gates refused or the
 *  attempt itself failed. The attempt flag flips synchronously, so racing
 *  callers (watcher + sweep) can never double-restart. */
async function restartLostPane(
  running: RunningSubagent,
  deps: RestartDeps = {},
): Promise<boolean> {
  if (!canRestartLostPane(running)) return false;
  running.restart = { attemptedAt: Date.now() };

  const spawnRunning = deps.createSurfaceRunning ?? createSurfaceRunning;
  const writeScript = deps.writeScript ?? writeLaunchScript;
  const waitChannel = running.waitChannel ?? `pi-subagent-${running.id}`;

  const artifactDir = running.parentArtifactDir ?? dirname(running.sessionFile);
  // Without a replayable sandbox the restart would launch with all global
  // extensions and the full toolset — refuse rather than escalate. The
  // sidecar is preferred; when it is gone the launch script rebuilds it.
  const resolvedLoadout = resolveResumeLoadout(artifactDir, running.name, running.sessionFile);
  if (!resolvedLoadout) return false;
  const loadout = resolvedLoadout.loadout;
  const safeName =
    running.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent";

  try {
    // The resumed process needs a user turn to act on; without one the CLI
    // would park the pane waiting for input.
    const msgDir = join(artifactDir, "subagent-resume");
    mkdirSync(msgDir, { recursive: true });
    const msgFile = join(msgDir, `${safeName}-restart-${Date.now()}.md`);
    writeFileSync(
      msgFile,
      "Your terminal pane was lost (reaped or killed) mid-task. You have been automatically " +
        "restarted in a new pane with your full session history intact. Continue the task from " +
        "where you left off. If you had already finished, restate your final summary and stop.",
      "utf8",
    );

    // Same construction as the subagent_message resume: the pi CLI resuming
    // the durable session file, sandbox replayed from the spawn-time snapshot.
    const parts = ["pi", "--session", shellEscape(running.sessionFile)];
    parts.push("-e", shellEscape(join(SUBAGENTS_DIR, "subagent-done.ts")));
    applySandboxToParts(parts, loadout, { artifactDir, name: running.name });
    parts.push(shellEscape(`@${msgFile}`));

    const envParts: string[] = [];
    if (loadout.agentDir) {
      envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(loadout.agentDir)}`);
    }
    if (loadout.spawnable && loadout.spawnable.length > 0) {
      envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
    }
    if (loadout.agent) {
      envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
    }
    envParts.push(`PI_SUBAGENT_NAME=${shellEscape(running.name)}`);
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
    envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(running.sessionFile)}`);
    envParts.push(`PI_SUBAGENT_ID=${shellEscape(running.id)}`);
    envParts.push(`PI_SUBAGENT_TASK=${shellEscape(running.task)}`);
    envParts.push(`PI_SUBAGENT_PARENT_SESSION=${shellEscape(running.parentSessionId ?? "")}`);
    envParts.push(`PI_SUBAGENT_START_MS=${String(running.startTime)}`);
    if (running.activityFile) {
      envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(running.activityFile)}`);
    }
    // The pane id cannot be known before the pane exists; the pane's own
    // tmux environment carries it, so expand it at run time inside the pane.
    envParts.push(`PI_SUBAGENT_SURFACE="\${TMUX_PANE}"`);
    const cdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

    const command =
      `${cdPrefix}${envParts.join(" ") + " "}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
    const scriptPath = join(
      artifactDir,
      "subagent-scripts",
      `${safeName}-restart-${Date.now()}.sh`,
    );
    // Write the script first, then create the pane born running it — one
    // atomic step: no default-shell window, no delivery race, no ready wait.
    // The replacement pane re-signals the wait-for channel its watcher parks
    // on, so the restart keeps push-driven completion.
    writeScript(scriptPath, command, [
      `# Subagent restart script for ${running.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${running.sessionFile}`,
      `# Restarted from dead pane: ${running.surface}`,
    ].join("\n"));

    const surface = spawnRunning(running.name, launchPaneCommand(scriptPath, waitChannel));
    running.waitChannel = waitChannel;
    running.surface = surface;
    running.launchScriptFile = scriptPath;
    // The resumed child re-appends in its own time; re-baseline the sweep's
    // stall bookkeeping so the restart pause is not read as a new stall.
    delete running.reconcile;
    // The replacement pane runs a fresh child: its stall episode budget resets
    // with it (one nudge before any future escalation, not a straight kill).
    delete running.stallRecovery;
    // Restart is the recovery path, same as the subagent_message resume: the
    // budget that was metering the pre-loss run would re-breach instantly
    // against the re-read session file, so resumed runs are unenforced.
    running.budget = undefined;
    running.budgetMeter = undefined;
    running.budgetStopper = undefined;
    running.restart.respawnedAt = Date.now();
    updateWidget();
    return true;
  } catch {
    // The script write or the pane creation failed before the entry mutated:
    // no replacement pane exists to close, and the entry still points at the
    // dead pane id, so the loss is detected (and delivered) again.
    return false;
  }
}

/** Grace window a nudged child gets to resume activity before recovery
 *  escalates to a restart. Env-tunable at call time
 *  (PI_SUBAGENT_STALL_RECOVERY_GRACE_MS). */
const DEFAULT_STALL_RECOVERY_GRACE_MS = 120_000;

function resolveStallRecoveryGraceMs(
  env: { [key: string]: string | undefined } = process.env,
): number {
  const raw = env.PI_SUBAGENT_STALL_RECOVERY_GRACE_MS;
  const value = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_STALL_RECOVERY_GRACE_MS;
}

/** The steering user turn typed into a stalled child's pane after the
 *  interrupt: tells the child why it was interrupted and what to do next. */
function buildStallHealthCheckCommand(silentForMs: number): string {
  const minutes = Math.max(1, Math.round(silentForMs / 60_000));
  return (
    `Health check: no activity for ${minutes} min. If a command hung, kill it and ` +
    `continue from your last milestone in /tmp; if blocked, ask_question; if done, finish.`
  );
}

/** Stalled-child recovery entry: on a stall transition, interrupt the pane
 *  (a hung foreground command would swallow a typed message) and steer the
 *  child with a health-check turn. Guards: interactive panes are user-driven
 *  and never injected into; claude children have no activity contract; a
 *  child with no heartbeat trail (recorder absent or disabled) is owned by
 *  the sweep's session-file path — recovery must not fire on it. A child
 *  already nudged (this or an earlier episode) skips the nudge and goes
 *  straight to restart-or-deliver. */
function handleStallTransition(
  pi: ExtensionAPI,
  running: RunningSubagent,
  now: number,
  deps: StallRecoveryDeps = {},
): void {
  if (running.interactive) return;
  if (running.cli === "claude") return;
  if (running.statusState.lastActivityAtMs == null) return;
  if (running.stallRecovery) {
    finalizeLostSubagent(pi, running, "stalled", deps);
    return;
  }
  running.stallRecovery = { nudgedAt: now };
  const interrupt = deps.interrupt ?? sendInterrupt;
  const send = deps.sendCommand ?? sendCommand;
  // A dead or closing pane must not escape as an unhandled throw — the sweep
  // observes the pane and finalizes; the recovery state stays recorded either
  // way, so the nudge is never retried within the episode.
  try {
    interrupt(running.surface);
  } catch {}
  try {
    send(running.surface, buildStallHealthCheckCommand(now - running.statusState.lastActivityAtMs));
  } catch {}
}

/** Grace-lapse check for an in-flight recovery, run on every status tick: a
 *  child still stalled once the grace window elapses escalates to
 *  restart-or-deliver; a child that resumed activity simply outlives the
 *  episode (the stallRecovery marker stays, so a later stall skips the
 *  nudge). One escalation per episode (the exhaustedAt flag). */
function enforceStallRecovery(
  pi: ExtensionAPI,
  running: RunningSubagent,
  now: number,
  deps: StallRecoveryDeps = {},
): void {
  const recovery = running.stallRecovery;
  if (!recovery || recovery.exhaustedAt != null) return;
  if (running.statusState.currentKind !== "stalled") return;
  if (now - recovery.nudgedAt < (deps.graceMs ?? resolveStallRecoveryGraceMs())) return;
  recovery.exhaustedAt = now;
  finalizeLostSubagent(pi, running, "stalled", deps);
}

/** Whether a lost child qualifies for its one automatic restart: a pane loss
 *  always tries; a stall only after the health-check recovery failed (the
 *  stallRecovery marker). A sweep-found stall with no recovery state delivers
 *  directly, as before. */
function restartEligible(running: RunningSubagent, kind: "pane_lost" | "stalled"): boolean {
  if (!canRestartLostPane(running)) return false;
  return kind === "pane_lost" || running.stallRecovery != null;
}

/** Finalize a lost child for the sweep and watcher: try the one automatic
 *  restart first; deliver the synthesized loss when the gates refuse or the
 *  attempt fails. The restart path is fire-and-forget: a failed attempt
 *  leaves the attempt flag set, so the next sweep tick (or the watcher)
 *  delivers the loss. */
function finalizeLostSubagent(
  pi: ExtensionAPI,
  running: RunningSubagent,
  kind: "pane_lost" | "stalled",
  deps: RestartDeps = {},
): void {
  if (restartEligible(running, kind)) {
    const restart = deps.restart ?? restartLostPane;
    void restart(running, deps)
      .then((respawned) => {
        if (!respawned && !running.delivered) {
          deliverSubagentResult(pi, running, synthesizeLostResult(running, kind), kind);
        }
      })
      .catch((reportErr) => {
        reportDiagnostic(
          `[pi-subagents] restart attempt failed (${describeTmuxFailure(reportErr, `the pane of "${running.name}"`)}); synthesizing loss`,
        );
        reportPaneErrorRow(pi, reportErr, `restart of "${running.name}" failed`);
        if (!running.delivered) {
          deliverSubagentResult(pi, running, synthesizeLostResult(running, kind), kind);
        }
      });
    return;
  }
  deliverSubagentResult(pi, running, synthesizeLostResult(running, kind), kind);
}

// ── subagent_control verbs (cancel / restart) ──

/** Injectable seams for the control verbs: the interrupt/kill channels and
 *  grace window of the budget-stop path, plus the restart machinery's
 *  pane/script seams and executor. */
interface ControlDeps extends RestartDeps {
  /** Interrupt channel (tmux C-c in production). */
  interrupt?: (surface: string) => void;
  /** Kill channel (kill-pane in production). */
  kill?: (surface: string) => void;
  /** Grace window override; defaults to the budget stopper's. */
  graceMs?: number;
  /** Sleep seam for the grace wait; real default is a plain setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const controlSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The budget-stop stop sequence, factored: interrupt the child, give it the
 *  grace window to exit cleanly (its session file flushes), then kill the
 *  pane. Fail-soft on both channels — a dead pane must not fail the verb. */
async function stopChildSurface(running: RunningSubagent, deps: ControlDeps = {}): Promise<void> {
  const interrupt = deps.interrupt ?? sendInterrupt;
  const kill = deps.kill ?? closeSurface;
  const graceMs = deps.graceMs ?? BUDGET_GRACE_MS;
  const sleep = deps.sleep ?? controlSleep;
  try {
    interrupt(running.surface);
  } catch {}
  await sleep(graceMs);
  try {
    kill(running.surface);
  } catch {}
}

/** Cancel a running child: record cancel intent FIRST (it blocks the
 *  pane-loss restart gates and upgrades any racing loss synthesis to
 *  cancelled_by_parent), stop it through the budget-stop sequence, then
 *  finalize through the standard delivery funnel — the funnel releases the
 *  declared scope, aborts the watcher (whose settle frees the slot), and
 *  delivers exactly one result. If the watcher delivered during the grace
 *  window (the child exited on the interrupt), the funnel's delivered flag
 *  makes this a no-op instead of a second result. */
async function cancelRunningSubagent(
  pi: ExtensionAPI,
  running: RunningSubagent,
  deps: ControlDeps = {},
): Promise<void> {
  running.cancelledAt = Date.now();
  await stopChildSurface(running, deps);
  if (!running.delivered) {
    deliverSubagentResult(pi, running, synthesizeCancelledResult(running), "cancelled_by_parent");
  }
}

/** Cancel a queued spawn: detach it from the FIFO, release its declared-
 *  scope reservation (unparking spawns queued behind it), and drop its name
 *  reservation. Slot parity is inherent — a queued entry holds no slot (the
 *  drain acquires one only at launch), so there is nothing to release and
 *  the holder count is untouched. Returns the removed entry, or null when
 *  no queued spawn carries the name. */
function cancelQueuedSpawn(name: string): PendingSpawn | null {
  const wanted = name.trim();
  const index = pendingSpawns.findIndex(
    (entry) => (entry.params.name ?? entry.reservedName ?? entry.params.agent) === wanted,
  );
  if (index === -1) return null;
  const [entry] = pendingSpawns.splice(index, 1);
  if (entry.scopeId) releaseScope(entry.scopeId);
  if (entry.reservedName) reservedNames.delete(entry.reservedName);
  return entry;
}

/** Restart a running child on demand: gate first (an ineligible child is
 *  never stopped), then stop the live pane through the budget-stop sequence
 *  — the restart machinery expects a dead pane, and two panes sharing one
 *  session file would interleave writes — then re-dispatch through the
 *  pane-loss restart path, which mutates the entry in place onto the new
 *  pane (same name, same registry entry, the watcher keeps watching). */
async function restartSubagent(
  running: RunningSubagent,
  deps: ControlDeps = {},
): Promise<{ ok: true } | { error: string }> {
  if (!canRestartLostPane(running)) {
    return {
      error:
        `"${running.name}" is not restartable: restart needs a pi auto-exit child with assistant ` +
        "progress that has neither been restarted, delivered, or budget-stopped",
    };
  }
  await stopChildSurface(running, deps);
  if (running.delivered) {
    return {
      error: `"${running.name}" finished while it was being stopped; its result was already delivered`,
    };
  }
  const restart = deps.restart ?? restartLostPane;
  const respawned = await restart(running, deps);
  if (!respawned) {
    return {
      error: `the restart attempt for "${running.name}" failed; the watcher either reports the pane loss or its auto-restart recovers it`,
    };
  }
  return { ok: true };
}

/** Race a blocking poll against its abort signal. pollForExit observes the
 *  signal only between its awaits; while it is parked inside a multiplexer
 *  round-trip (which can take hundreds of ms on a loaded host) an abort
 *  would otherwise not surface until that round-trip yields — delaying the
 *  watcher's settle, its queue-slot release, and the queued-spawn drain that
 *  release triggers. Loser rejections are swallowed so an abandoned poll
 *  cannot surface as an unhandled rejection; the poll winds itself down on
 *  its next signal check. */
function raceAbortSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let decided = false;
    const onAbort = () => {
      if (decided) return;
      decided = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    pending.then(
      (value) => {
        if (decided) return;
        decided = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (decided) return;
        decided = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  deps: {
    poll?: typeof pollForExit;
    restart?: (r: RunningSubagent) => Promise<boolean>;
    readScreen?: (surface: string, lines?: number) => string;
  } = {},
): Promise<SubagentResult> {
  const { name, task, startTime, sessionFile } = running;
  const poll = deps.poll ?? pollForExit;
  const restart = deps.restart ?? restartLostPane;
  const readPane = deps.readScreen ?? readScreen;

  try {
    let result: Awaited<ReturnType<typeof pollForExit>>;
    for (;;) {
      // Poll the entry's CURRENT pane: a sweep-initiated restart may have
      // moved the entry while an earlier poll still watched the dead pane.
      const surface = running.surface;
      const pollSignal = AbortSignal.any([signal, getModuleAbortSignal()]);
      const pollPromise = poll(surface, pollSignal, {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        waitChannel: running.waitChannel,
        onTick() {
          observeRunningSubagent(running);
          deliverPendingQuestion(running);
          enforceBudget(running);
        },
      });
      // Race the poll: an abort landing mid-round-trip must settle the
      // watcher (and free its queue slot) immediately, not on the next tick.
      result = await raceAbortSignal(pollPromise, pollSignal);
      if (result.reason !== "gone") break;
      // The polled pane is gone, but the entry may already sit on a
      // replacement pane (sweep-initiated restart): keep watching that one.
      if (running.surface !== surface) continue;
      // First confirmed loss of the entry's own pane: try the one automatic
      // restart (respawn + resume the durable session file). On success keep
      // watching the replacement pane; on failure synthesize the loss below.
      if (await restart(running)) continue;
      break;
    }

    // The pane disappeared without an exit record (group reap, external
    // kill-pane, or the budget stopper's kill racing the poll) and no
    // automatic restart applies. The durable session file is the source of
    // truth — synthesize, don't spin.
    if (result.reason === "gone") {
      const synthesized = synthesizeLostResult(running, "pane_lost");
      try {
        closeSurface(running.surface);
      } catch {}
      runningSubagents.delete(running.id);
      return synthesized;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    running.budgetStopper?.onExit();
    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        // The pane may already be gone (child exited and closed it) — screen
        // capture is best-effort; the exit-code fallback below still reports.
        try {
          summary = readPane(running.surface, 200)
            .replace(/__SUBAGENT_DONE_\d+__/, "")
            .trimEnd();
        } catch {}
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      try {
        closeSurface(running.surface);
      } catch {}
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction — single read: parse once, derive
    // summary + stats + id from the same entries (was three full parses).
    let summary: string;
    const piEntries = existsSync(sessionFile) ? getNewEntries(sessionFile, 0) : null;
    running.parsedEntries = piEntries;
    if (piEntries) {
      summary =
        findLastAssistantMessage(piEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = piEntries ? summarizeStatsFromEntries(piEntries) : null;
    const subagentSessionId = piEntries ? getSessionIdFromEntries(piEntries) : null;

    // Close the finished pane. Non-fatal: the pane may already be gone (it
    // can close itself moments before this), and a cleanup failure must never
    // turn a completed child's result into an error result.
    try {
      closeSurface(running.surface);
    } catch {}
    runningSubagents.delete(running.id);

    const budgetBreach = running.budgetStopper?.breached() ?? null;
    return {
      name,
      task,
      summary: budgetBreach ? budgetBreachSummary(budgetBreach) : summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(budgetBreach
        ? { error: "budget_exceeded", errorMessage: budgetBreachSummary(budgetBreach) }
        : result.errorMessage
          ? { errorMessage: result.errorMessage }
          : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    // Abort fires on session shutdown / module teardown — most importantly when
    // a headless (print-mode) parent finishes its run and exits. The subagent
    // pane is an independent tmux process: killing it here destroyed children
    // mid-turn ("seeded then die before turn_start" in headless runs). Stop
    // watching, but leave the pane alive so the child completes on its own;
    // its result lands in its session file, recoverable by a resumed parent
    // or `subagents_list` via the persistent name registry.
    if (signal.aborted) {
      runningSubagents.delete(running.id);
      return {
        name,
        task,
        summary: "Subagent detached: parent session ended while it was running. It keeps running in its tmux pane; its result is in its session file.",
        exitCode: 0,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "detached",
        sessionFile,
      };
    }
    try {
      closeSurface(running.surface);
    } catch {}
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

/** Surface undelivered inbox records for this repo. Only the record's own
 * (resumed) parent session may receive a task-steering delivery — it is the
 * natural continuation of a result its in-memory delivery never reached.
 * Every other session is an unrelated bystander: a dead parent's stale
 * result must never trigger or steer its turns (it could hijack a fresh
 * subagent task mid-flight), so it surfaces context-only — displayed and in
 * transcript, but with no forced turn and no queued steer. */
function drainResultInbox(pi: ExtensionAPI, ctx?: unknown): void {
  try {
    const c = ctx as { cwd?: string; sessionManager?: { getSessionId?(): string } } | undefined;
    const cwd = c?.cwd ?? latestCtx?.cwd ?? process.cwd();
    const sessionId =
      c?.sessionManager?.getSessionId?.() ??
      (latestCtx as unknown as { sessionManager?: { getSessionId?(): string } } | null)
        ?.sessionManager?.getSessionId?.() ??
      null;
    for (const record of drainSubagentResults(repoRootFor(cwd), sessionId)) {
      // The draining session owns this record only when it IS the (resumed)
      // spawning parent. drainSubagentResults passes a parent-session record
      // through only when the parent never observed it in memory, so `own`
      // means "reclaim my own unobserved result", never a foreign task.
      const own = sessionId != null && record.parentSessionId === sessionId;
      sendMessageContained(
        pi,
        {
          customType: "subagent_result",
          content: own
            ? `Sub-agent "${record.name}" finished — recovered from the durable inbox (original parent gone):\n\n` +
              `${capResultSummary(record.summary)}`
            : `Sub-agent "${record.name}", started by an earlier session, finished — result recovered from the durable inbox. Informational for this session; no action required:\n\n` +
              `${capResultSummary(record.summary)}`,
          display: true,
          details: {
            name: record.name,
            task: record.task,
            exitCode: record.exitCode,
            elapsed: record.elapsed,
            sessionFile: record.sessionFile,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            ...(record.error ? { error: record.error } : {}),
            fromInbox: true,
            ...(own ? {} : { contextOnly: true }),
          },
        },
        own ? { triggerTurn: true, deliverAs: "steer" } : undefined,
      );
    }
  } catch {
    // Inbox drain is best-effort; records stay on disk for the next drain.
  }
}

/** Re-attach to orphans left by a previous session of this project.
 * Live pane -> watch again (the result delivers when the child exits);
 * dead pane -> synthesize from the durable session file and deliver now.
 * Budgets stay unenforced on adoption: a restart-fresh meter cannot be
 * trusted against already-elapsed work. */
async function adoptPendingSubagents(
  pi: ExtensionAPI,
  pending: PendingDetachedSubagent[],
  listPanes: () => Promise<Set<string> | null> = listLiveSurfaces,
): Promise<void> {
  const live = await listPanes();
  const sessionId = (latestCtx as any)?.sessionManager?.getSessionId?.() ?? null;
  for (const p of pending) {
    const running: RunningSubagent = {
      id: p.id,
      name: p.name,
      task: p.task,
      surface: p.surface,
      sessionFile: p.sessionFile,
      startTime: p.startedAt,
      cwd: process.cwd(),
      parentSessionId: sessionId,
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: p.startedAt }),
    };
    if (live !== null && live.has(p.surface)) {
      attachScopeKey(running);
      runningSubagents.set(running.id, running);
      watchSubagent(running, getModuleAbortSignal()).then(
        (result) => deliverSubagentResult(pi, running, result),
        () => {},
      );
    } else {
      deliverSubagentResult(pi, running, synthesizeLostResult(running, "pane_lost"), "pane_lost");
    }
  }
  updateWidget();
}

/** Session-shutdown core, extracted for testing: detach only the dying
 *  session's own children — persist their orphan sidecars, abort their
 *  watchers, drop their entries. Other projects' children sharing this
 *  process keep their supervision: clearing everything is how a project
 *  switch used to strand another project's subagents as unsupervised panes
 *  that later surfaced as unrecoverable pane losses. */
function handleSessionShutdown(ctx?: ExtensionContext | null): void {
  const sessionId = (ctx as any)?.sessionManager?.getSessionId?.() ?? null;
  const scope = currentScopeKey(ctx ?? null);
  const own = [...runningSubagents.values()].filter((r) =>
    r.parentSessionId != null ? r.parentSessionId === sessionId : childScopeKey(r) === scope,
  );
  if (own.length > 0) {
    writePendingDetachedSubagents(own, Date.now());
  }
  for (const agent of own) {
    agent.abortController?.abort();
    runningSubagents.delete(agent.id);
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    armWidgetForSession(ctx);
    // Drain the repo's durable subagent-result inbox: entries whose spawning
    // parent is gone wait there until some session in this repo wakes up.
    drainResultInbox(pi, ctx);
    // Reap dead-but-remained panes left by a crashed earlier session —
    // hygiene for the agents sessions only, never the user's own windows.
    reapDeadAgentPanes();
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }

    // Surface subagents orphaned by a previous session in this project, and
    // sync the persistent name registry into this session's view: a resumed
    // parent must see its registered children so it resumes them by name
    // instead of spawning replacements. One notice covers both — they usually
    // describe the same orphans.
    try {
      const sm = (ctx as any).sessionManager;
      const sessionDir = sm?.getSessionDir?.();
      const sessionId = sm?.getSessionId?.();
      const lines: string[] = [];
      let severity: "info" | "warning" = "info";
      let surfaced: ReturnType<typeof findPendingDetached> = [];
      if (sessionDir) {
        const pending = findPendingDetached(join(sessionDir, "artifacts"), Date.now());
        if (pending.length > 0) {
          severity = "warning";
          lines.push(
            `${pending.length} subagent(s) detached mid-run by a previous session — ` +
              `results recoverable from their session files (subagent-pending/ sidecars)`,
          );
          surfaced = pending;
        }
      }
      if (sessionDir && sessionId) {
        const registered = listRegisteredSubagents(getArtifactDir(sessionDir, sessionId));
        if (registered.length > 0) {
          const missing = registered.filter((r) => !r.exists).length;
          lines.push(
            `${registered.length} subagent session(s) registered by an earlier run of this ` +
              `session: ${registered.map((r) => r.name).join(", ")}. Resume them by name ` +
              `(subagent_message) instead of spawning new subagents` +
              (missing > 0 ? ` — ${missing} session file(s) missing` : "") + ".",
          );
        }
      }
      if (lines.length > 0) ctx.ui.notify?.(lines.join("\n"), severity);
      // Warn once per orphan set: the sidecar's only duty was this notice —
      // adoption takes over from here (re-watch or finalize + deliver).
      if (surfaced.length > 0) dismissPendingDetached(surfaced);
      if (surfaced.length > 0) {
        void adoptPendingSubagents(pi, surfaced).catch(() => {});
      }
    } catch {
      // Discovery and registry sync are best-effort.
    }
  });

  // Clean up on session shutdown
  pi.on("turn_start", () => drainResultInbox(pi, latestCtx));

  pi.on("session_shutdown", (_event, ctx) => {
    // Detach only this session's own children: their orphan sidecars persist
    // before their watchers abort, so the next session_start in this project
    // surfaces and adopts them. Children of other projects sharing this
    // process keep their supervision (see handleSessionShutdown).
    handleSessionShutdown(ctx);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    // The registries are shared by every session in this process: only tear
    // the module poll down once no other project's children remain to watch.
    if (runningSubagents.size === 0) {
      const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
      if (moduleAbort) moduleAbort.abort();
    }
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      defaultActive: !SPAWN_TOOLS_GATED,
      description:
        "Spawn a sub-agent in a dedicated pane. Fire-and-forget: returns immediately with an acknowledgement only; " +
        "when it finishes, the harness automatically delivers its result as a steer message that wakes you and starts a new turn. " +
        "Do not poll, sleep, tail, re-read session logs, or call tools to check status. " +
        "Do not fabricate or assume results. " +
        "After spawning, end your turn or do independent work, including parallel spawns.",
      promptSnippet:
        "Spawn a fire-and-forget sub-agent; its result arrives later as a steer message. " +
        "Do not poll or fabricate results; end turn or do other work.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. The lone exception is a
        // top-level `fork: true` clone, which has no role and inherits the
        // caller's own already-trusted toolset. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const permittedAgents = SUBAGENT_ALLOWLIST
          ? [...SUBAGENT_ALLOWLIST]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // Deny-by-default tool declaration: a definition without a `tools:`
        // line would launch with the full default toolset — the unrestricted
        // path reserved for top-level fork clones that inherit the caller's
        // already-trusted toolset. Role agents must declare their tools; the
        // fix is one frontmatter line in the definition file.
        const declaredDefs = params.agent ? loadAgentDefaults(params.agent) : null;
        if (declaredDefs && !declaredDefs.tools) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: agent '${params.agent}' declares no tools and would launch ` +
                  `unrestricted (deny-by-default). Add a 'tools:' line to its definition ` +
                  `listing exactly what it needs, e.g. 'tools: read, piread, pibash'.`,
              },
            ],
            details: { error: "agent undeclared tools" },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Default the cosmetic pane label to the agent name when omitted,
        // disambiguating against running subagents, in-flight reservations, and
        // every name already in the registry — so names stay unique across the
        // whole session, running or finished. Reserve the chosen name
        // synchronously (before any await) so parallel spawns don't collide.
        let reservedName: string | null = null;
        if (!params.name?.trim()) {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          params.name = uniqueRunningName(params.agent, registryNames, currentScopeKey());
          reservedName = params.name;
          reservedNames.add(reservedName);
        }

        // ── Declared file-scope lock ──
        // Derive the child's scope and check conflicts synchronously: the
        // segment from here to tryAcquire is verified await-free, so the
        // reservation is atomic against same-turn parallel spawns (mirrors
        // the name reservation above). Parsed scope NEVER locks — it only
        // rides along for prior-work injection and display.
        const scope = deriveScope(
          params.task,
          resolveSubagentPaths(params, params.agent ? loadAgentDefaults(params.agent) : null).effectiveCwd ?? ctx.cwd,
          params.files,
        );
        const scopeMode = resolveScopeMode(process.env.PI_SUBAGENTS_SCOPE_MODE);
        let scopeId: string | undefined;
        let scopeConflicts: ReturnType<typeof findConflicts> = [];
        if (scopeMode !== "off" && scope.origin === "declared") {
          scopeId = nextScopeId();
          scopeConflicts = findConflicts(scope.paths);
        }
        const scopeInfo = scopeInfoOf({ scopeId, scope });

        // History-derived time-sense and duplicate guard for the ack: the
        // baseline line gives the orchestrator a typical elapsed/cost figure
        // at spawn, and a near-identical same-agent task (running child or
        // history summary) warns before a duplicate spawn. Warn-only — the
        // stat-cached history read is the sole data source, no new loops.
        const spawnHistory = readRecentResults(
          repoRootFor(
            resolveSubagentPaths(params, params.agent ? loadAgentDefaults(params.agent) : null)
              .effectiveCwd ?? ctx.cwd,
          ),
          20,
        );
        const baselineLine = (() => {
          const b = agentBaselineFor(spawnHistory, params.agent);
          return b ? `${formatBaselineLine(params.agent, b)} ` : "";
        })();
        const dupNote =
          findDuplicateSpawn(
            { agent: params.agent, task: params.task },
            runningSubagents.values(),
            spawnHistory,
          ) ?? "";

        // Launch the subagent (creates pane, runs the launch script). Release
        // the name reservation once it registers in runningSubagents (or the
        // launch fails) — from then on uniqueRunningName tracks it via the
        // running map. A slot must already be held: either claimed just now or
        // drained from the queue — never block the parent turn on acquire().
        let running: RunningSubagent;
        if (scopeConflicts.length > 0 && scopeMode === "queue") {
          // Declared write overlap with a live owner: park the spawn with its
          // scope reserved (a queued reservation participates in conflicts,
          // so a third colliding spawn queues behind this one too). No slot
          // is taken — the scope release wakes it.
          declareScope(scopeId!, { name: params.name, paths: scope.paths, state: "queued" });
          pendingSpawns.push({ params, ctx, parentArtifactDir, reservedName, scopeId, scope });
          startWidgetRefresh();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Sub-agent "${params.name}" queued behind "${scopeConflicts[0].name}" — it declares write scope that ` +
                  `${describeScopeConflicts(scopeConflicts)}, so it launches once that owner finishes. ` +
                  `${baselineLine}${dupNote}` +
                  `The launch and its result both arrive automatically: a steer message wakes you when it finishes. ` +
                  `Do NOT poll, sleep, or check status; do NOT assume results. Move on to other work or end your turn.`,
              },
            ],
            details: {
              name: params.name,
              task: params.task,
              agent: params.agent,
              queued: true,
              queuePosition: pendingSpawns.length,
              scopeConflicts,
            },
          };
        }
        if (scopeId) {
          declareScope(scopeId, { name: params.name, paths: scope.paths, state: "running" });
        }
        if (spawnQueue.tryAcquire()) {
          running = await launchReservedSpawn(pi, params, ctx, parentArtifactDir, reservedName, scopeInfo);
        } else {
          // Cap reached: queue FIFO and return immediately. The drain hook
          // launches it when a slot frees; result delivery is unchanged.
          pendingSpawns.push({ params, ctx, parentArtifactDir, reservedName, scopeId, scope });
          startWidgetRefresh();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Sub-agent "${params.name}" queued — the concurrency cap is reached, so it launches ` +
                  `when a running sub-agent finishes. ${baselineLine}${dupNote}The launch and its result both arrive automatically: ` +
                  `a steer message wakes you when it finishes. Do NOT poll, sleep, or check status; do NOT assume results. ` +
                  `Move on to other work or end your turn.`,
              },
            ],
            details: {
              name: params.name,
              task: params.task,
              agent: params.agent,
              queued: true,
              queuePosition: pendingSpawns.length,
            },
          };
        }

        // Return immediately
        const scopeWarn =
          scopeMode === "warn" && scopeConflicts.length > 0
            ? `WARNING: write-scope ${describeScopeConflicts(scopeConflicts)} — running anyway (PI_SUBAGENTS_SCOPE_MODE=warn). `
            : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `${baselineLine}${dupNote}${scopeWarn}` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      defaultActive: !SPAWN_TOOLS_GATED,
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name. " +
        "Also lists this session's registered subagent sessions, resumable by name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name. " +
        "Also lists this session's registered subagent sessions, resumable by name.",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        // This session's registered children from the persistent name
        // registry — resumable by name, so a resumed parent can pick them
        // up instead of spawning replacements.
        let registered: ReturnType<typeof listRegisteredSubagents> = [];
        try {
          const sm = (latestCtx as any)?.sessionManager;
          const sessionDir = sm?.getSessionDir?.();
          const sessionId = sm?.getSessionId?.();
          if (sessionDir && sessionId) {
            registered = listRegisteredSubagents(getArtifactDir(sessionDir, sessionId));
          }
        } catch {
          // Registry listing is best-effort.
        }

        // Declared write-scope owners (running or queued) — the file locks
        // this session's spawns currently hold. Exposure is transcript-safe:
        // paths repo-relative (absolute machine paths never reach transcripts
        // or details) and capped.
        const exposureRoot = repoRootFor(ctx?.cwd ?? latestCtx?.cwd ?? process.cwd());
        const scoped: Array<{ name: string; state: "queued" | "running"; paths: string[]; more?: number }> =
          scopedChildren().map((s) => {
            const shown = s.paths
              .map((p) => relative(exposureRoot, p))
              .filter((p) => p !== "" && !p.startsWith(".."));
            return {
              name: s.name,
              state: s.state,
              paths: shown.slice(0, 10),
              ...(shown.length > 10 ? { more: shown.length - 10 } : {}),
            };
          });

        // Live per-child metrics — queued first (they have no start time),
        // then running children with elapsed, phase, metered usage, and a
        // past-p90 flag from this repo's history baselines.
        const metrics: ChildMetrics[] = annotatePastP90(
          [
            ...pendingSpawns.map(queuedChildMetrics),
            ...runningInScope(exposureRoot).map(runningChildMetrics),
          ],
          readRecentResults(exposureRoot, 20),
        );

        if (list.length === 0 && registered.length === 0 && scoped.length === 0 && metrics.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] as typeof list, registered: [] as typeof registered },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });
        if (registered.length > 0) {
          lines.push("", "Registered sessions (resume by name via subagent_message):");
          for (const r of registered) {
            const state = r.exists ? "resumable" : "session file missing";
            lines.push(`• ${r.name} — ${state} (${basename(r.sessionFile)})`);
          }
        }

        if (scoped.length > 0) {
          lines.push("", "Declared file scopes (write locks):");
          for (const s of scoped) {
            const total = s.paths.length + (s.more ?? 0);
            const shown =
              s.paths.slice(0, 3).join(", ") + (total > 3 ? `, +${total - 3} more` : "");
            // All declared paths were filtered out (outside the exposure
            // root): an explicit marker — never an empty "owns  (state)" span.
            const owns = s.paths.length > 0 ? `owns ${shown}` : "(outside this repo)";
            lines.push(`• ${s.name} — ${owns} (${s.state})`);
          }
        }
        if (metrics.length > 0) {
          lines.push("", "Live children:");
          for (const m of metrics) lines.push(`• ${formatChildMetricsLine(m)}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list, registered, ...(scoped.length ? { scoped } : {}), ...(metrics.length ? { metrics } : {}) },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        const registered = details?.registered ?? [];
        const scoped = (details?.scoped ?? []) as Array<{ name: string; state: string; paths: string[]; more?: number }>;
        const metrics = (details?.metrics ?? []) as ChildMetrics[];
        if (agents.length === 0 && registered.length === 0 && scoped.length === 0 && metrics.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        if (registered.length > 0) {
          if (agents.length > 0) lines.push("");
          lines.push(theme.fg("dim", "Registered sessions (resume via subagent_message):"));
          for (const r of registered) {
            const state = r.exists ? "resumable" : "session file missing";
            lines.push(
              `  ${theme.fg("toolTitle", theme.bold(r.name))}${theme.fg("dim", ` — ${state}`)}`,
            );
          }
        }
        // Mirror the text output's scope section in the expanded view — the
        // ▣ glyph matches the widget's lock indicator.
        if (scoped.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(theme.fg("dim", "Declared file scopes (write locks):"));
          for (const s of scoped) {
            const total = s.paths.length + (s.more ?? 0);
            const shown =
              s.paths.slice(0, 3).join(", ") + (total > 3 ? `, +${total - 3} more` : "");
            // Same all-outside marker as the text output's scope section.
            const owns = s.paths.length > 0 ? `owns ${shown}` : "(outside this repo)";
            lines.push(
              `  ▣ ${theme.fg("toolTitle", theme.bold(s.name))}${theme.fg("dim", ` — ${owns} (${s.state})`)}`,
            );
          }
        }
        // Mirror the text output's live-metrics section in the expanded view.
        if (metrics.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(theme.fg("dim", "Live children:"));
          for (const m of metrics) {
            lines.push(`  • ${theme.fg("dim", formatChildMetricsLine(m))}`);
          }
        }
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_control tool ──
  pi.registerTool({
      name: "subagent_control",
      label: "Control Subagent",
      defaultActive: !SPAWN_TOOLS_GATED,
      description:
        "Control a live sub-agent by display name. `cancel` stops a running sub-agent (interrupt, then kill after a grace period) or removes a queued one before it launches; " +
        "a cancelled run reports cancelled_by_parent as a steer message, its scope lock and slot free automatically. " +
        "`restart` re-dispatches a running sub-agent into a fresh pane resuming its session (same name, same entry) — refused when it has no resumable progress. " +
        "Unknown or inactive names return an error line. Do not poll after calling; outcomes arrive as steer messages.",
      promptSnippet:
        "Cancel or restart a sub-agent by name; cancelled/restarted outcomes arrive later as steer messages. " +
        "Do not poll; end turn or do other work after.",
      parameters: SubagentControlParams,

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const name = params.name.trim();
        const single = (text: string, error?: string) => ({
          content: [{ type: "text" as const, text }],
          details: { action: params.action, name, ...(error ? { error } : {}) },
        });
        if (!name) {
          return single(
            "Provide the exact display name of a sub-agent (see subagents_list or the spawn acknowledgement).",
            "name required",
          );
        }

        if (params.action === "cancel") {
          const resolved = resolveRunningByName(name, currentScopeKey());
          if ("running" in resolved) {
            // Fire-and-forget like spawn: the stop waits out the grace
            // window and the cancelled result arrives as a steer.
            void cancelRunningSubagent(pi, resolved.running).catch((err: unknown) => {
              reportDiagnostic(
                `[pi-subagents] cancel of "${name}" failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            });
            return single(
              `Cancel initiated for sub-agent "${name}" — interrupted, then killed after the grace period. ` +
                `Its cancelled result arrives as a steer message; the scope lock and slot free automatically. ` +
                `Do not poll or re-cancel.`,
            );
          }
          const queued = cancelQueuedSpawn(name);
          if (queued) {
            return single(
              `Removed queued sub-agent "${name}" — it never launched. ` +
                `Its scope reservation is released and its name is free again.`,
            );
          }
          return single(
            `No running or queued sub-agent named "${name}". ` +
              `Live children and queued names are listed by subagents_list.`,
            "unknown name",
          );
        }

        // restart
        const resolved = resolveRunningByName(name, currentScopeKey());
        if ("running" in resolved) {
          if (!canRestartLostPane(resolved.running)) {
            return single(
              `Sub-agent "${name}" is not restartable: restart needs a pi auto-exit child with assistant ` +
                `progress that has neither been restarted, delivered, or budget-stopped.`,
              "not restartable",
            );
          }
          void restartSubagent(resolved.running)
            .then((outcome) => {
              if ("error" in outcome) {
                reportDiagnostic(
                  `[pi-subagents] restart of "${name}": ${describeTmuxFailure(outcome.error, `the pane of "${name}"`)}`,
                );
              }
            })
            .catch((err: unknown) => {
              reportDiagnostic(
                `[pi-subagents] restart of "${name}" failed: ` +
                  `${describeTmuxFailure(err, `the pane of "${name}"`)}`,
              );
              reportPaneErrorRow(pi, err, `restart of "${name}" failed`);
            });
          return single(
            `Restart initiated for sub-agent "${name}" — its live pane is stopped and the task re-dispatched ` +
              `into a fresh pane resuming the same session. The entry and name are unchanged; the result arrives ` +
              `as a steer message. If the attempt is refused, a loss result arrives instead.`,
          );
        }
        return single(resolved.error, "unknown name");
      },
    });

  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      defaultActive: !SPAWN_TOOLS_GATED,
      description:
        "Message a subagent by name. Names persist after a subagent finishes: the same name steers a running subagent or resumes a finished one. " +
        "`name` and `message` are required. " +
        "Steering returns immediately with an acknowledgement, no new result. " +
        "Resuming is fire-and-forget: the result arrives later as a steer message that wakes a new turn. " +
        "Do not poll or fabricate results. End turn or do independent work after.",
      promptSnippet:
        "Steer a running subagent or resume a finished one by name (`name`+`message` required). " +
        "Resume is fire-and-forget; result arrives later as a steer message. No polling.",
      parameters: Type.Object({
        name: Type.String({
          description: "Exact subagent name. Steers it if running; resumes its session if finished.",
        }),
        message: Type.String({
          description: "Follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        // Project-scoped: another project's same-named child is not this
        // session's duplicate and must not swallow its steer.
        const runningMatch = runningInScope(currentScopeKey()).find((r) => r.name === requestedName);
        if (runningMatch) {
          return handleSubagentSteer({ name: requestedName, message: params.message });
        }

        // ── Resume a finished session by name ──
        return await resumeSubagentByName(params, ctx);
      },
    });

  // ── spawn-tool gating (top-level sessions only; see SPAWN_TOOLS_GATED) ──
  const spawnToolsActive = (): boolean =>
    SPAWNING_TOOLS.every((t) => pi.getActiveTools().includes(t));
  const activateSpawnTools = (): boolean => {
    if (spawnToolsActive()) return false;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SPAWNING_TOOLS])]);
    return true;
  };
  const deactivateSpawnTools = (): boolean => {
    const active = pi.getActiveTools();
    const next = active.filter(
      (t) => !(SPAWNING_TOOLS as readonly string[]).includes(t),
    );
    if (next.length === active.length) return false;
    pi.setActiveTools(next);
    return true;
  };

  // /subagents command — spawn a subagent by name
  pi.registerCommand("subagents", {
    description: "Spawn a subagent: /subagents [agent] [task] (agent optional — routed by task)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          spawnToolsActive()
            ? "Usage: /subagents <agent> [task] — spawn tools active ('/subagents off' hides them)"
            : "Usage: /subagents <agent> [task] — spawn tools hidden; '/subagents on' (or any spawn) enables them",
          "warning",
        );
        return;
      }
      if (trimmed === "on" || trimmed === "off") {
        const changed =
          trimmed === "on" ? activateSpawnTools() : deactivateSpawnTools();
        ctx.ui.notify(
          changed
            ? `Spawn tools ${trimmed === "on" ? "activated" : "deactivated"} for this session`
            : `Spawn tools already ${trimmed === "on" ? "active" : "hidden"}`,
          "info",
        );
        return;
      }
      activateSpawnTools(); // any explicit spawn is also a trigger

      const words = trimmed.split(/\s+/);
      let agentName = words[0];
      let task = words.slice(1).join(" ");
      let defs = loadAgentDefaults(agentName);

      if (!defs) {
        // Prose tolerance: users write "/subagents use the worker to …". If the
        // first word isn't a known agent, use the first known agent name in the
        // phrase and treat the words after it as the task.
        const idx = words.findIndex((w, i) => i > 0 && loadAgentDefaults(w));
        if (idx !== -1) {
          agentName = words[idx];
          task = words.slice(idx + 1).join(" ");
          defs = loadAgentDefaults(agentName);
        }
      }

      if (!defs) {
        // No agent named anywhere — let the session model route by task
        // content (it can inspect agents via subagents_list). Same one-turn
        // cost as the named path; no keyword heuristics to maintain.
        pi.sendUserMessage(
          `Spawn a subagent for this task: ${JSON.stringify(trimmed)} — first call ` +
            `subagents_list, pick the most suitable agent for the task, then call ` +
            `subagent with that agent and the task. Do not do the work yourself.`,
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // files_changed renders capped; the full list stays in details only —
        // a drain bystander echoes records into every repo session's
        // transcript, so an uncapped list is a token-cost leak.
        const filesChanged: string[] = Array.isArray(details.files_changed) ? details.files_changed : [];
        if (filesChanged.length > 0) {
          contentLines.push("");
          for (const p of filesChanged.slice(0, 20)) {
            contentLines.push(theme.fg("dim", `- ${p}`.slice(0, Math.max(1, width - 6))));
          }
          if (filesChanged.length > 20) {
            contentLines.push(theme.fg("muted", `… +${filesChanged.length - 20} more`));
          }
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_pane_error message renderer ──
  pi.registerMessageRenderer("subagent_pane_error", renderSubagentPaneError as never);

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
