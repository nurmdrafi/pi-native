/**
 * Daemon-generation helpers for self-heal.
 *
 * A pi session's native-tool daemons outlive pulls and rebuilds: "restart
 * on death" never fires while an old binary keeps serving. These helpers
 * let self-heal detect, from mtime evidence alone, that bin/ changed since
 * the last session_start and kill only this repo's stale daemons.
 * OS-agnostic: mtime + `pkill -f` (BSD and GNU ERE behave the same here).
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export const DAEMON_BINS = ["pibash", "piread", "piedit"] as const;

/** Highest mtime (ms) among the daemon binaries; missing files are skipped; none present → 0. */
export function scanBinGeneration(binDir: string): number {
  let max = 0;
  for (const name of DAEMON_BINS) {
    try {
      max = Math.max(max, statSync(join(binDir, name)).mtimeMs);
    } catch {
      // Missing binary: not this machine's problem yet; after-pull rebuilds it.
    }
  }
  return max;
}

/** True when a recorded previous generation exists and differs from the current one. */
export function generationChanged(previous: number | null, current: number): boolean {
  return previous !== null && previous !== current;
}

/** pkill -f (ERE) pattern matching only this repo's `--serve` daemon processes. */
export function daemonKillPattern(binDir: string): string {
  return `${binDir}/(${DAEMON_BINS.join("|")}) --serve`;
}
