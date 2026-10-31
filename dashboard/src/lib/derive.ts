/** Pure derivations for the overview panels. Erasable TypeScript only —
 * node --test imports this file directly with types stripped, so no alias
 * imports, no enums or other transform-only syntax. */

import { fmtMoney } from "./format.ts";

/** Gate token share buckets, in axis order. "0" means the session recorded
 * no gate tokens at all. */
export const GATE_SHARE_BUCKETS = ["0", "≤5", "≤10", "≤20", ">20"] as const;
/** Index of the ">20" bucket — the high end that carries the warn marker. */
export const GATE_SHARE_HIGH = 4;

/** Bucket index for a gate token share in pct. Boundaries sit inside the
 * lower bucket: 5 is "≤5", 20 is "≤20". */
export function gateShareBucket(pct: number): number {
  if (pct <= 0) return 0;
  if (pct <= 5) return 1;
  if (pct <= 10) return 2;
  if (pct <= 20) return 3;
  return GATE_SHARE_HIGH;
}

/** Local-day key for a timestamp. Spend days are server-local days; this
 * dashboard runs on the operator's own machine, so browser-local matches. */
export function dayKey(ts: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Per-call money keeps a third digit under a dime — two would read $0.00. */
export function perCall(v: number): string {
  if (v >= 1) return fmtMoney(v);
  return v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

/** Cost per call from summed totals. Zero or negative call counts cannot
 * carry a rate — the caller suppresses the tool instead of showing one. */
export function perCallRate(cost: number, calls: number): number | null {
  if (calls <= 0) return null;
  return cost / calls;
}

/** Sessions with any failed-call streak, worst first — the failure-streak
 * league ordering. Ties break on total failed calls; clean sessions stay
 * out. Displays slice the result; exports keep every row. */
export function failureStreakLeague<
  S extends { agent: { maxFailureStreak: number; failureStreakCalls: number } },
>(sessions: S[]): S[] {
  return sessions
    .filter((s) => s.agent.maxFailureStreak > 0)
    .sort(
      (a, b) =>
        b.agent.maxFailureStreak - a.agent.maxFailureStreak ||
        b.agent.failureStreakCalls - a.agent.failureStreakCalls,
    );
}

/** Tool spend league across sessions, each tool priced exactly once: a
 * tool with recorded calls takes its cost from that session's cost map,
 * and a tool that only carries a cost joins with zero calls. Ordered by
 * cost desc, then calls desc; displays slice the top rows. */
export function toolLeaderboard<
  S extends { tools: Record<string, number>; toolCosts?: Record<string, number> },
>(sessions: S[]): { name: string; calls: number; cost: number }[] {
  const totals = new Map<string, { name: string; calls: number; cost: number }>();
  const row = (name: string) => {
    let t = totals.get(name);
    if (!t) {
      t = { name, calls: 0, cost: 0 };
      totals.set(name, t);
    }
    return t;
  };
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.tools)) {
      const t = row(name);
      t.calls += count;
      t.cost += s.toolCosts?.[name] ?? 0;
    }
    for (const [name, cost] of Object.entries(s.toolCosts ?? {})) {
      if (!totals.has(name)) row(name).cost += cost;
    }
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}
