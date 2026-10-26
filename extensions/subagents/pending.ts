/**
 * Detached-subagent persistence.
 *
 * When a parent session ends while subagents are still running, their
 * watchers are aborted and nothing is delivered — the dying session cannot
 * receive a steer. These sidecars keep that loss visible and recoverable:
 * each still-running child is recorded under the parent session's artifact
 * dir, and the next session_start in the same project scans previous
 * artifact dirs and surfaces the orphans.
 *
 * Best-effort by design: shutdown and discovery must never throw.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PENDING_DIR = "subagent-pending";

/** Default age after which a sidecar is no longer surfaced. */
export const PENDING_MAX_AGE_MS = 48 * 3600_000;

export interface PendingDetachedSubagent {
  id: string;
  name: string;
  agent?: string;
  task: string;
  sessionFile: string;
  surface: string;
  startedAt: number;
  detachedAt: number;
}

type PendingEntry = Partial<PendingDetachedSubagent> & {
  id?: string;
  parentArtifactDir?: string;
};

/**
 * Write one sidecar per running subagent that has a parent artifact dir.
 * Returns the paths written; entries without a dir are skipped; per-entry
 * failures are swallowed.
 */
export function writePendingDetachedSubagents(entries: PendingEntry[], nowMs: number): string[] {
  const written: string[] = [];
  for (const e of entries) {
    if (!e.id || !e.parentArtifactDir) continue;
    const record: PendingDetachedSubagent = {
      id: e.id,
      name: e.name ?? e.id,
      ...(e.agent ? { agent: e.agent } : {}),
      task: e.task ?? "",
      sessionFile: e.sessionFile ?? "",
      surface: e.surface ?? "",
      startedAt: e.startedAt ?? nowMs,
      detachedAt: nowMs,
    };
    try {
      const dir = join(e.parentArtifactDir, PENDING_DIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${e.id}.json`);
      writeFileSync(file, JSON.stringify(record), "utf8");
      written.push(file);
    } catch {
      // Persistence is best-effort; shutdown must never throw.
    }
  }
  return written;
}

/**
 * Find sidecars under each session's subagent-pending dir inside artifactsRoot.
 * Corrupt, incomplete, and aged-out records are skipped. Never throws.
 */
export function findPendingDetached(
  artifactsRoot: string,
  nowMs: number,
  maxAgeMs: number = PENDING_MAX_AGE_MS,
): PendingDetachedSubagent[] {
  const found: PendingDetachedSubagent[] = [];
  let sessions: string[];
  try {
    sessions = readdirSync(artifactsRoot);
  } catch {
    return found;
  }
  for (const s of sessions) {
    let files: string[];
    try {
      files = readdirSync(join(artifactsRoot, s, PENDING_DIR));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(artifactsRoot, s, PENDING_DIR, f), "utf8"),
        ) as PendingDetachedSubagent;
        if (typeof record.detachedAt !== "number" || nowMs - record.detachedAt > maxAgeMs) continue;
        if (!record.id || !record.name || typeof record.sessionFile !== "string") continue;
        found.push(record);
      } catch {
        // Corrupt sidecar — ignore.
      }
    }
  }
  return found;
}
