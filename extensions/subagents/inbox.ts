/**
 * Durable per-repo subagent result inbox.
 *
 * Every completed subagent — normal exit, budget kill, or a result
 * synthesized by the reconciliation sweep — appends its result to
 * `<repo-root>/.pi/subagent-results.jsonl` BEFORE any in-memory delivery is
 * attempted. A result on disk can never be lost, whatever happens to panes,
 * parents, or the extension process: if the spawning parent is gone, the
 * next session in that repo drains the inbox and surfaces the entry.
 *
 * The drain state (`<repo-root>/.pi/subagent-results.drain.json`) is shared
 * by all sessions in the repo: a record is surfaced to the repo exactly once
 * (the spawning parent is skipped because it already received the direct
 * in-memory steer). Records are addressed by id, so appends after a drain
 * are picked up by the next drain.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One durable subagent result record. */
export interface InboxRecord {
  /** Unique record id (delivery/drain idempotency key). */
  id: string;
  ts: number;
  name: string;
  task: string;
  agent?: string;
  sessionFile: string;
  sessionId?: string;
  /** Session id of the spawning parent, when known. The parent's own drain skips it. */
  parentSessionId?: string | null;
  repoRoot: string;
  summary: string;
  error?: string;
  errorMessage?: string;
  exitCode: number;
  elapsed: number;
  /** Aggregate usage/model stats when available. */
  stats?: unknown;
  /** Set when the result was synthesized rather than observed (pane reap, stall). */
  synthesized?: "pane_lost" | "stalled";
}

/** Nearest ancestor of startDir containing `.git`, else startDir itself. */
export function repoRootFor(startDir: string): string {
  let cur = startDir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return startDir;
    cur = parent;
  }
}

export function resultInboxPath(repoRoot: string): string {
  return join(repoRoot, ".pi", "subagent-results.jsonl");
}

function drainStatePath(repoRoot: string): string {
  return join(repoRoot, ".pi", "subagent-results.drain.json");
}

/** Append one result record to its repo's inbox (creates dirs as needed). */
export function appendSubagentResult(record: InboxRecord): void {
  const path = resultInboxPath(record.repoRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Best-effort durability: the in-memory delivery still happens, and the
    // next successful append keeps the stream usable.
  }
}

/** Records not yet drained for this repo, oldest first. The spawning parent's
 * own records are skipped (it received the direct in-memory steer); marking
 * them drained is still correct for other sessions. */
export function drainSubagentResults(repoRoot: string, sessionId?: string | null): InboxRecord[] {
  const inboxPath = resultInboxPath(repoRoot);
  let records: InboxRecord[] = [];
  try {
    const raw = readFileSync(inboxPath, "utf8");
    records = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as InboxRecord);
  } catch {
    return [];
  }

  const statePath = drainStatePath(repoRoot);
  let drainedIds: string[] = [];
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { drained?: string[] };
    if (Array.isArray(state.drained)) drainedIds = state.drained;
  } catch {}
  const seen = new Set(drainedIds);

  const fresh = records.filter((r) => !seen.has(r.id));
  if (fresh.length === 0) return [];

  const toSurface = fresh.filter((r) => !sessionId || r.parentSessionId !== sessionId);
  if (toSurface.length === 0) return [];

  // Only surfaced records are marked drained — a record skipped because the
  // draining session IS its parent must stay claimable by other sessions.
  const nowSeen = [...seen, ...toSurface.map((r) => r.id)].slice(-1000);
  try {
    writeFileSync(statePath, JSON.stringify({ drained: nowSeen }), "utf8");
  } catch {
    // A failed state write only risks a duplicate surface later, never a loss.
  }
  return toSurface;
}
