/**
 * Cadence thresholds — the single definition of "this session is long".
 * Consumers: the CN cadence nudge here, and the handoff extension's turn-limit
 * offer (which reuses CADENCE_TURNS as its default).
 *
 * Counted like AGENTS.md Token Economy does: user turns (~120) or estimated
 * context tokens (~150K) before proposing a compaction/fresh-session hop
 * (2026-10-10: 354/303-turn marathons re-billed ~100M cacheRead each with zero
 * compactions; 2026-10-29 pidx audit: the 281/177-turn permission-gate
 * sessions paid 85–94% of spend in cacheRead — rounds × prefix turns
 * quadratic, and it is sunk well before 200). The nudge is NON-blocking
 * (2026-10-11): appended to the next tool_result — the blocking variant cost
 * a re-issue turn and the model could not act on it mid-call anyway.
 */

/** User turns before the cadence nudge fires. Resets on compaction. */
export const CADENCE_TURNS = 120;

/** Estimated context tokens before the cadence nudge fires. */
export const CADENCE_CTX_TOKENS = 150_000;
