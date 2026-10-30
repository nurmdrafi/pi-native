/**
 * Reconciliation sweep: result delivery independent of the poll loop.
 *
 * The watcher's poll loop keys on the tmux pane; a group pane reap (or a
 * wedged child with a live pane) produces no observable exit event, so the
 * loop never reaches result construction and the subagent vanishes without
 * delivering anything. The sweep runs on every status tick and finalizes
 * entries from durable state instead:
 *
 *   1. Pane check: surface missing from the live pane list -> child dead
 *      by infrastructure.
 *   2. Session-file check: file mtime/size unchanged across the stall
 *      window -> child dead or wedged (a long pause alone is not enough —
 *      LLM turns legitimately take minutes between appends).
 *
 * Either condition synthesizes the result from the session file and hands it
 * to the caller's finalize (durable inbox write + in-memory delivery +
 * entry removal). Finalization is idempotent: once the entry leaves the
 * running map, later sweeps see nothing to do.
 */

import { statSync } from "node:fs";

/** Ticks (status ticks, ~1s each) a session file may sit unchanged before the
 * child is considered stalled. Generous on purpose — one long tool call (a
 * build, a test suite) legitimately writes nothing for many minutes, and a
 * false stall kills live work; a late stall only delays delivery. */
export const STALL_TICKS = 1800;

export interface SweepEntry {
  id: string;
  surface: string;
  sessionFile: string;
  /** Reconcile bookkeeping (owned by the sweep). */
  reconcile?: { lastMtimeMs: number; lastSize: number; unchangedTicks: number };
}

export interface SweepDeps {
  /** Live running-subagent map (mutated only via finalize). */
  runningSubagents: Map<string, SweepEntry>;
  /** Resolves the set of live tmux pane ids ("%N"), or null when tmux itself
   * is unreachable — a tmux outage must never look like a mass pane reap, so
   * a null result skips pane-based finalization for this tick (the
   * session-file stall check still runs; it needs only the filesystem). */
  listPanes(): Promise<Set<string> | null>;
  /** Deliver + remove one entry. Must be idempotent per entry. */
  finalize(entry: SweepEntry, kind: "pane_lost" | "stalled"): void;
}

/** One sweep pass. Sequential on purpose: finalize ordering (inbox write
 * before in-memory delivery) must hold per entry, and entries are few. */
export async function sweepRunningSubagents(deps: SweepDeps): Promise<void> {
  const live = await deps.listPanes();
  for (const entry of [...deps.runningSubagents.values()]) {
    if (live !== null && !live.has(entry.surface)) {
      deps.finalize(entry, "pane_lost");
      continue;
    }

    const state = entry.reconcile ?? { lastMtimeMs: -1, lastSize: -1, unchangedTicks: 0 };
    let mtimeMs = -1;
    let size = -1;
    try {
      const st = statSyncBestEffort(entry.sessionFile);
      mtimeMs = st?.mtimeMs ?? -1;
      size = st?.size ?? -1;
    } catch {}

    const unchanged =
      mtimeMs !== -1 && mtimeMs === state.lastMtimeMs && size === state.lastSize;
    state.lastMtimeMs = mtimeMs;
    state.lastSize = size;
    state.unchangedTicks = unchanged ? state.unchangedTicks + 1 : 0;
    entry.reconcile = state;

    if (state.unchangedTicks >= STALL_TICKS) {
      deps.finalize(entry, "stalled");
    }
  }
}

function statSyncBestEffort(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
