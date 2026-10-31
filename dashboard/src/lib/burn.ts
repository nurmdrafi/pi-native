/** Burn-rate floor: fewer events or a shorter span than this would pin the
 * strip to a single burst, so the strip shows "warming up" instead. */
const MIN_RATE_EVENTS = 3;
const MIN_RATE_SPAN_MS = 120_000;

/** Hourly spend rate over the newest `windowMs` of timestamped turn events
 * (their full span when `windowMs` is null). Events without a usable
 * timestamp are dropped. Returns null while coverage is too thin for an
 * honest rate — that state renders as "warming up". */
export function burnRate(
  events: { ts: string | null; cost: number }[],
  windowMs: number | null,
): { hourly: number; spanMs: number; events: number } | null {
  const pts = events
    .map((e) => ({ ts: e.ts === null ? NaN : new Date(e.ts).getTime(), cost: e.cost }))
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
  const newest = pts.length > 0 ? pts[pts.length - 1].ts : null;
  if (newest === null) return null;
  const windowed =
    windowMs === null ? pts : pts.filter((p) => p.ts > newest - windowMs);
  if (windowed.length < MIN_RATE_EVENTS) return null;
  const spanMs = windowed[windowed.length - 1].ts - windowed[0].ts;
  if (spanMs < MIN_RATE_SPAN_MS) return null;
  const cost = windowed.reduce((sum, p) => sum + p.cost, 0);
  return { hourly: (cost / spanMs) * 3_600_000, spanMs, events: windowed.length };
}

/** Skill usage rows, most-used first; ties fall back to name order so the
 * table is stable. */
export function sortedSkillRows(
  skills: Record<string, number> | null | undefined,
): [string, number][] {
  return Object.entries(skills ?? {}).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}
