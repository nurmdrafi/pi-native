import type { TurnDetail } from "@/types";

/** One emitted line in the session's cache-cost audit trail: `warn` marks a
 *  billable prompt-prefix refresh, `notice` marks a cache miss. */
export interface CacheAuditLine {
  level: "warn" | "notice";
  /** 1-based turn position, matching the charts tab row numbering. */
  turn: number;
  /** Billable tokens the line names: cacheWrite for a refresh, re-billed
   *  input + cacheWrite for a miss. */
  tokens: number;
  text: string;
}

export interface CacheCostAudit {
  /** Turns that rewrote the prompt prefix into cache (cacheWrite > 0). */
  refreshes: number;
  /** Turns served no cached prefix at all (cacheRead === 0, input > 0). */
  misses: number;
  /** Approximate tokens re-billed across misses: input + cacheWrite. */
  missTokens: number;
  lines: CacheAuditLine[];
}

/** Structural slice of TurnDetail — the detail wire guarantees these numbers,
 *  but detection stays defensive: absent/null/NaN fields count as zero. */
interface CacheTurn {
  i?: number | null;
  input?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * Derive the cache-cost audit trail from a session's detail turns. Pure: the
 * same turns always yield the same trail, so each billable event emits its
 * line exactly once per session no matter how often the view recomputes.
 *
 * Two distinct billable events, both grounded in the per-turn usage the
 * detail endpoint ships:
 *  - refresh (warn): `cacheWrite > 0` — the prompt prefix was rewritten into
 *    cache, billed at the cache-write premium.
 *  - miss (notice): `cacheRead === 0 && input > 0` — no cached prefix was
 *    served, so the whole prompt is re-billed (input + cacheWrite). A cold
 *    turn can emit both lines: one refresh, one miss.
 */
export function cacheCostAudit(turns: readonly (CacheTurn | TurnDetail)[]): CacheCostAudit {
  const lines: CacheAuditLine[] = [];
  let refreshes = 0;
  let misses = 0;
  let missTokens = 0;

  turns.forEach((t, idx) => {
    const pos = (typeof t?.i === "number" && Number.isFinite(t.i) ? t.i : idx) + 1;
    const input = num(t?.input);
    const cacheRead = num(t?.cacheRead);
    const cacheWrite = num(t?.cacheWrite);

    if (cacheWrite > 0) {
      refreshes += 1;
      lines.push({
        level: "warn",
        turn: pos,
        tokens: cacheWrite,
        text: `t${pos} cache refresh: ${fmt(cacheWrite)} prefix tokens rewritten at cache-write rate`,
      });
    }
    if (cacheRead === 0 && input > 0) {
      const reBilled = input + cacheWrite;
      misses += 1;
      missTokens += reBilled;
      lines.push({
        level: "notice",
        turn: pos,
        tokens: reBilled,
        text: `t${pos} cache miss: ~${fmt(reBilled)} tokens re-billed uncached`,
      });
    }
  });

  return { refreshes, misses, missTokens, lines };
}
