/** Violation memory (VM): blocks correct within a session, but the model is
 * stateless across sessions and re-attempts the same families in every new
 * one. Persisted per-family DISTINCT-SESSION block counts (NDJSON, append-only)
 * pick the lessons injected into the next session's system prompt. */
export const MEMORY_THRESHOLD = 5; // distinct sessions before a lesson enters the prompt
export const FAMILY_LESSONS: Record<string, string> = {
  "Token Economy (Re-run)":
    "Never re-run a command unchanged within 10 min without an edit/write since — its output is already in context.",
  "Token Economy (Re-read)":
    "Never re-read a file window already in context this session — read only new regions (offset/limit).",
  "Token Economy (Piread-first)":
    "Read text files with the piread tool, never the built-in read tool — read is only for images. piread falls back to the built-in reader on its own.",
  "Token Economy (Pibash-first)":
    "Run shell commands with the pibash tool, never the built-in bash tool — pibash falls back to the built-in executor on its own.",
  "Permission Gate (Destructive)":
    "Destructive/mutating commands (rm, git reset --hard/clean/checkout --, package installs, sudo) need explicit user approval first — a yes in chat or in the invoking message (incl. /ship, /issue, /update-changelog) counts and suppresses the confirm; otherwise ask in chat and wait.",
  "Anchor Guard":
    "edit oldText is exact bytes from a read this session, unique in the file, non-overlapping with sibling edits.",
  Commitlint:
    "Commit messages are conventional: 'type(scope?): subject', lowercase subject, no trailing dot.",
  "Toolchain (pnpm)":
    "In a pnpm repo use pnpm run/exec/dlx — never npm/npx/yarn against its tree.",
  "Toolchain (Node)":
    "Match the repo's exact Node pin (.nvmrc/engines): prefix node binaries with 'nvm use <pin> &&'.",
  "Search (Scope)":
    "Never run a recursive grep without a path/glob scope — scope it (path, --include) or use rg.",
  "Portability (grep -P)":
    "No grep -P on macOS (BSD grep) — use rg or grep -E.",
  "Search (node_modules)":
    "Don't crawl node_modules without asking the user — pi docs under node_modules/@earendil-works/ are pre-approved.",
};

/** the gate's own synthesized block results carry isError + a family-prefixed text */
const BLOCK_FAMILY_RE =
  /^(Token Economy|Anchor Guard|Codemode|Commitlint|Permission Gate|Toolchain|Search|Portability)[^:]*/;
export function blockFamilyOf(event: {
  isError?: boolean;
  content?: unknown[];
}): string | undefined {
  if (!event.isError) return undefined;
  const txt = (event.content as { text?: unknown }[] | undefined)?.[0]?.text;
  const m = typeof txt === "string" ? BLOCK_FAMILY_RE.exec(txt) : null;
  return m ? m[0] : undefined;
}

/** Process-wide fallback, evaluated once: a resumed session is a new process,
 * so this is the closest stable identity when the harness env is absent. */
const PROCESS_SID = `pid-${process.pid}`;

/**
 * Session identity for the violation store.
 *
 * The harness exposes `PI_SESSION_ID`, the id that names the conversation in
 * `sessions/*.jsonl`. Every producer used to mint its own `randomUUID()` per
 * process instead, so the stored ids matched no session (0 of 365 overlapped)
 * and each native tool disagreed with the gate about the same process —
 * MEMORY_THRESHOLD then counted processes rather than sessions.
 *
 * Resolved lazily (not at module load) so a test can pass its own env, and
 * memoized per process so one process keeps one id.
 */
export function memorySid(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
): string {
  const explicit = env.PI_SESSION_ID;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return pid === process.pid ? PROCESS_SID : `pid-${pid}`;
}

/** One row shape for every producer; `kind` separates the two signals. */
export type ViolationRow = {
  kind: "violation";
  family: string;
  sid: string;
  ts: number;
  reason?: string;
  path?: string;
};

export type AdoptionRow = {
  kind: "adoption";
  tool: string;
  sid: string;
  ts: number;
};

/** Gate blocks and native-tool fallbacks both explain themselves with a reason. */
export function violationRecord(input: {
  family: string;
  sid: string;
  ts: number;
  reason?: string;
  path?: string;
}): ViolationRow {
  const row: ViolationRow = {
    kind: "violation",
    family: input.family,
    sid: input.sid,
    ts: input.ts,
  };
  if (input.reason !== undefined) row.reason = input.reason;
  if (input.path !== undefined) row.path = input.path;
  return row;
}

/** A completed native-tool call (AT1 adoption telemetry). */
export function adoptionRecord(input: {
  tool: string;
  sid: string;
  ts: number;
}): AdoptionRow {
  return { kind: "adoption", tool: input.tool, sid: input.sid, ts: input.ts };
}

/**
 * Families written by the native tools' FALLBACK path. They are not lessons
 * (no FAMILY_LESSONS entry) and they were produced by a packaging defect —
 * an unsigned binary the kernel SIGKILLs — so they are dropped by migration
 * instead of being carried forward as history.
 */
export const LEGACY_TOOL_FAMILIES = [
  "Piread (fallback)",
  "Pibash (fallback)",
  "Piedit (fallback)",
  "Pidx (fallback)",
] as const;

/** True when this family can still produce a lesson. */
export function isKnownFamily(family: string): boolean {
  return Object.hasOwn(FAMILY_LESSONS, family);
}

export type MigrationResult = {
  rows: (ViolationRow | AdoptionRow)[];
  /** legacy rows rewritten into the current shape */
  migrated: number;
  /** rows discarded (legacy tool fallbacks, out-of-window) */
  dropped: number;
  /** non-object / unparsable inputs */
  unparsable: number;
};

/**
 * Rewrite legacy store rows into the current shape (pure; the caller writes).
 *
 * Same 30-day window loadCounts applies, so a migration can never resurrect a
 * rolled-out family. A row's reason/path survive when present; a row that
 * carries none stays without one, because inventing them is what made the
 * store unable to explain itself.
 */
export function migrateRows(
  input: unknown[],
  opts: { now: number; windowMs?: number },
): MigrationResult {
  const windowMs = opts.windowMs ?? 30 * 24 * 60 * 60_000;
  const out: MigrationResult = { rows: [], migrated: 0, dropped: 0, unparsable: 0 };
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      out.unparsable++;
      continue;
    }
    const e = raw as Record<string, unknown>;
    // Already current shape: pass through verbatim.
    if (e.kind === "adoption" || e.kind === "violation") {
      if (typeof e.ts === "number" && opts.now - e.ts > windowMs) {
        out.dropped++;
        continue;
      }
      out.rows.push(e as unknown as ViolationRow | AdoptionRow);
      continue;
    }
    if (typeof e.family !== "string" || typeof e.ts !== "number") {
      out.unparsable++;
      continue;
    }
    if (opts.now - e.ts > windowMs) {
      out.dropped++;
      continue;
    }
    if (!isKnownFamily(e.family)) {
      // Legacy tool-fallback family: cause fixed, lesson impossible.
      out.dropped++;
      continue;
    }
    out.rows.push(
      violationRecord({
        family: e.family,
        sid: typeof e.sid === "string" && e.sid ? e.sid : `legacy-line-${out.rows.length}`,
        ts: e.ts,
        ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
        ...(typeof e.path === "string" ? { path: e.path } : {}),
      }),
    );
    out.migrated++;
  }
  return out;
}

/**
 * Merge the two lesson-count sources into one session-based number.
 *
 * `sessionCounts` is the NDJSON side: distinct sids per family in the window.
 * `legacyDepth` is the frozen pre-NDJSON blob: one number per family with no
 * session attribution. Because depth cannot be attributed to sessions, its only
 * honest contribution is a floor of 1 — counting `n` would fabricate sessions
 * and let a single old session clear MEMORY_THRESHOLD on its own, which is the
 * exact failure H7 set out to prevent.
 *
 * Returns a new object; neither input is mutated.
 */
export function mergeLessonCounts(
  sessionCounts: Record<string, number>,
  legacyDepth: Record<string, number>,
): Record<string, number> {
  const counts: Record<string, number> = { ...sessionCounts };
  for (const [family, depth] of Object.entries(legacyDepth)) {
    if (!(depth > 0)) continue;
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
}
