/**
 * Subagent budgets: declaration parsing, resolution, session metering, and
 * the stop-path state machine.
 *
 * Every subagent runs under a finite budget (wall-clock seconds, assistant
 * turns, cumulative provider-reported USD cost). Undeclared budgets get the
 * builtin defaults — "unlimited" is not a valid resolution. A spawn override
 * may lower a dimension but never raise it past its ceiling (the role's
 * declared budget, else the applicable default).
 *
 * Pure logic lives here so tests need no tmux; the watcher in index.ts wires
 * these pieces into the poll loop and injects the actual interrupt/kill.
 */
import { readFileSync } from "node:fs";

export interface BudgetDims {
  wallClockSec?: number;
  turns?: number;
  costUsd?: number;
}

/** Fully resolved budget: enforced dimensions are finite; absent dimensions
 * have no ceiling. */
export interface ResolvedBudget {
  wallClockSec?: number;
  turns?: number;
  costUsd?: number;
}

/** Enforced budget: only declared dimensions, or null when unenforced. */
export type EnforcedBudget = Partial<ResolvedBudget> | null;

/** How long a budget-breached child has to exit on its own after the
 * interrupt before the pane is killed. */
export const BUDGET_GRACE_MS = 30_000;

const DIMENSIONS = ["wallClockSec", "turns", "costUsd"] as const;
type Dimension = (typeof DIMENSIONS)[number];

function validateDim(dimension: Dimension, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      dimension === "turns"
        ? `${field} must be a positive integer`
        : `${field} must be a positive number`,
    );
  }
  if (dimension === "turns" && !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

/** A `budget: none` frontmatter value: an explicit exemption that beats
 * config defaults and spawn overrides — the agent can never be budget-killed. */
export const BUDGET_NONE = "none";

/**
 * Parse a nested `budget:` block from agent-definition frontmatter:
 *
 *   budget:
 *     wallClockSec: 900
 *     turns: 50
 *     costUsd: 2.5
 *
 * or the scalar exemption `budget: none`.
 *
 * Returns undefined when no block exists. Fails fast on unknown keys and
 * non-positive/non-numeric values — a typo must stop the spawn, not silently
 * disable the ceiling.
 */
export function parseBudgetFrontmatter(frontmatter: string): BudgetDims | "none" | undefined {
  if (/^budget:\s*none\s*$/m.test(frontmatter)) return BUDGET_NONE;
  const start = frontmatter.match(/^budget:\s*$/m);
  if (!start || start.index === undefined) return undefined;

  const after = frontmatter.slice(start.index + start[0].length);
  const dims: Partial<Record<Dimension, number>> = {};
  for (const rawLine of after.split("\n")) {
    // The block ends at the first non-indented, non-empty line.
    if (rawLine.trim() !== "" && !/^\s/.test(rawLine)) break;
    const line = rawLine.match(/^\s+([A-Za-z]+):\s*(\S+)\s*$/);
    if (!line) continue;
    const key = line[1];
    if (!(DIMENSIONS as readonly string[]).includes(key)) {
      throw new Error(`unsupported budget key '${key}' (allowed: ${DIMENSIONS.join(", ")})`);
    }
    const dimension = key as Dimension;
    const raw = Number(line[2]);
    dims[dimension] = validateDim(dimension, raw, `budget.${dimension}`);
  }
  if (Object.keys(dims).length === 0) {
    throw new Error("budget block declares no dimensions");
  }
  return dims;
}

export type BudgetDefaultsConfig = BudgetDims;

/**
 * Resolve the effective budget. Per dimension:
 *   ceiling = role budget ?? config default (no builtin fallback)
 *   effective = spawn override ? min(override, ceiling-or-override) : ceiling
 * A spawn may lower a dimension, never raise it past a ceiling. With no
 * ceiling and no override the dimension is unenforced. `budget: none` (role)
 * returns null: nothing is enforced and spawn overrides are ignored.
 */
export function resolveBudget(
  role: BudgetDims | "none" | undefined,
  spawn: BudgetDims | undefined,
  config?: BudgetDefaultsConfig,
): EnforcedBudget {
  if (role === BUDGET_NONE) return null;
  const resolved: Partial<ResolvedBudget> = {};
  let any = false;
  for (const dimension of DIMENSIONS) {
    const ceiling = role?.[dimension] ?? config?.[dimension];
    const override = spawn?.[dimension];
    const effective =
      override === undefined
        ? ceiling
        : Math.min(
            validateDim(dimension, override, `spawn budget.${dimension}`),
            ceiling ?? override,
          );
    if (effective !== undefined) {
      resolved[dimension] = effective;
      any = true;
    }
  }
  return any ? (resolved as EnforcedBudget) : null;
}

export interface BudgetMeterState {
  turns: number;
  costUsd: number;
}

/**
 * Incremental meter over a pi session JSONL: counts assistant messages and
 * sums provider-reported cost totals. Keeps a byte offset so each update
 * parses only newly appended complete lines; malformed lines are skipped.
 * A missing or unreadable file meters as zero.
 */
export function createSessionBudgetMeter(sessionFile: string): {
  update(): BudgetMeterState;
} {
  let offset = 0;
  let turns = 0;
  let costUsd = 0;

  return {
    update(): BudgetMeterState {
      let content: string;
      try {
        content = readFileSync(sessionFile, "utf8");
      } catch {
        return { turns, costUsd };
      }
      if (content.length <= offset) return { turns, costUsd };

      const fresh = content.slice(offset);
      const lastNewline = fresh.lastIndexOf("\n");
      if (lastNewline === -1) return { turns, costUsd };

      const complete = fresh.slice(0, lastNewline + 1);
      offset += complete.length;
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if ((entry as { type?: unknown })?.type !== "message") continue;
        const message = (entry as { message?: { role?: unknown; usage?: unknown } }).message;
        if (!message || message.role !== "assistant") continue;
        turns += 1;
        const cost = (message.usage as { cost?: { total?: unknown } } | undefined)?.cost;
        const total = cost?.total;
        if (typeof total === "number" && Number.isFinite(total)) costUsd += total;
      }
      return { turns, costUsd };
    },
  };
}

export interface BudgetBreach {
  dimension: Dimension;
  value: number;
  limit: number;
}

/**
 * First breached dimension, wall clock before turns before cost, or null.
 * Comparison is >=: the limit is a ceiling, so reaching it is a breach.
 * Undefined dimensions are unenforced and skipped.
 */
export function checkBudgetExceeded(
  budget: ResolvedBudget,
  meter: BudgetMeterState,
  elapsedMs: number,
): BudgetBreach | null {
  const elapsedSec = Number((elapsedMs / 1000).toFixed(1));
  if (budget.wallClockSec !== undefined && elapsedSec >= budget.wallClockSec) {
    return { dimension: "wallClockSec", value: elapsedSec, limit: budget.wallClockSec };
  }
  if (budget.turns !== undefined && meter.turns >= budget.turns) {
    return { dimension: "turns", value: meter.turns, limit: budget.turns };
  }
  if (budget.costUsd !== undefined && meter.costUsd >= budget.costUsd) {
    return { dimension: "costUsd", value: Number(meter.costUsd.toFixed(4)), limit: budget.costUsd };
  }
  return null;
}

/**
 * Stop-path state machine: on breach, interrupt the child once; if it has not
 * exited when the grace period lapses, kill it. Callers inject interrupt/kill
 * (tmux C-c / kill-pane in production) and a clock for tests.
 */
export function createBudgetStopper(options: {
  interrupt(): void;
  kill(): void;
  graceMs: number;
  now(): number;
}): {
  onBreach(breach: BudgetBreach): void;
  onTick(): void;
  onExit(): void;
  breached(): BudgetBreach | null;
} {
  const { interrupt, kill, graceMs, now } = options;
  let breach: BudgetBreach | null = null;
  let breachAt = 0;
  let exited = false;
  let killed = false;

  return {
    onBreach(next: BudgetBreach) {
      if (breach) return;
      breach = next;
      breachAt = now();
      interrupt();
    },
    onTick() {
      if (!breach || exited || killed) return;
      if (now() - breachAt >= graceMs) {
        killed = true;
        kill();
      }
    },
    onExit() {
      exited = true;
    },
    breached() {
      return breach;
    },
  };
}
