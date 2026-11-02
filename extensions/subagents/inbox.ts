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
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { getNewEntries } from "./session.ts";

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
  /** False when only the child itself reported this result — the spawning
   * parent died before in-memory delivery, so even its own resumed session
   * must surface the record. Absent (undefined) = legacy parent-appended. */
  observedByParent?: boolean;
  repoRoot: string;
  summary: string;
  error?: string;
  errorMessage?: string;
  exitCode: number;
  elapsed: number;
  /** Aggregate usage/model stats when available. */
  stats?: unknown;
  /** Set when the result was synthesized rather than observed (pane reap,
   *  stall, parent cancel). */
  synthesized?: "pane_lost" | "stalled" | "cancelled_by_parent";
  /** Repo-relative paths added/removed/status-changed since the spawn-time git
   * baseline, sorted, capped at 200. Absent when no baseline existed or git
   * failed — the spawn itself must never depend on git. */
  files_changed?: string[];
  /** Provenance marker: files_changed came from a git status delta. */
  files_changed_source?: "git_status_delta";
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

/** Total tokens processed per a session-stats record: the four cumulative
 *  usage fields summed. One definition, shared by live child metrics and
 *  history mirroring so the two can never disagree. */
export function usageTokens(stats: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}): number {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return num(stats.inputTokens) + num(stats.outputTokens) + num(stats.cacheReadTokens) + num(stats.cacheWriteTokens);
}

export function resultInboxPath(repoRoot: string): string {
  return join(repoRoot, ".pi", "subagent-results.jsonl");
}

function drainStatePath(repoRoot: string): string {
  return join(repoRoot, ".pi", "subagent-results.drain.json");
}

/** Append one result record to its repo's inbox (creates dirs as needed).
 * `historyExtra` (files the child read, a capped diff) enriches the HISTORY
 * line only — the drain-managed inbox record stays lean. */
export function appendSubagentResult(record: InboxRecord, historyExtra?: SubagentHistoryExtra): void {
  // PI_SUBAGENT_INBOX (absolute file path) overrides the repo-root default so
  // an isolated process can capture every write without ever touching the
  // repo's real inbox.
  const path = process.env.PI_SUBAGENT_INBOX || resultInboxPath(record.repoRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Best-effort durability: the in-memory delivery still happens, and the
    // next successful append keeps the stream usable.
  }
  // History row whenever there is anything to record: changed files, or a
  // read-only child's files_read (computeFilesChanged yields [] on a clean
  // delta — dropping the row here would silently drop the reader's
  // files_read and leave prior-reader matching inert for pure readers).
  if ((record.files_changed?.length ?? 0) > 0 || (historyExtra?.files_read?.length ?? 0) > 0) {
    appendHistoryLine(record, historyExtra);
  }
}

// ── Git-derived files_changed, history, and prior-work injection ──

/** Synchronous git runner (injectable for tests). */
export type GitRunner = (args: string[]) => string;
/** Asynchronous git runner: the callback receives stdout, or null on failure. */
export type AsyncGitRunner = (args: string[], cb: (stdout: string | null) => void) => void;

const runGitSync: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }) as string;

const runGitAsync: AsyncGitRunner = (args, cb) => {
  try {
    execFile("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      cb(err ? null : (stdout as string)),
    );
  } catch {
    cb(null);
  }
};

const FILES_CHANGED_CAP = 200;
const FILES_READ_CAP = 50;
const DIFF_CAP_CHARS = 1500;
const HISTORY_MAX_LINES = 1000;
const HISTORY_KEEP_LINES = 500;
const HISTORY_SUMMARY_CHARS = 300;

/** Parse `git status --porcelain=v1 -z` output into path → status code.
 * With -z, records are NUL-separated and unquoted; a rename emits two
 * consecutive tokens (`XY <to>` then the bare source path) — the source is
 * recorded as a deletion so renames surface as plain add/delete pairs. */
export function parsePorcelainZ(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  let renameTarget: string | null = null;
  for (const token of tokens) {
    const m = /^([A-Z?.! ][A-Z?.! ]) (.+)$/s.exec(token);
    if (m) {
      out.set(m[2], m[1]);
      renameTarget = m[2];
    } else if (renameTarget !== null) {
      out.set(token, "D ");
      renameTarget = null;
    }
  }
  return out;
}

function readBaseline(baselinePath: string): { repoRoot: string; porcelain: string } | null {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { repoRoot?: unknown; porcelain?: unknown };
  if (typeof parsed?.repoRoot !== "string" || typeof parsed.porcelain !== "string") return null;
  return { repoRoot: parsed.repoRoot, porcelain: parsed.porcelain };
}

/** Resolve a spawn-time git baseline PATH synchronously (so the env var can
 * ride the pane) while the porcelain capture and file write run
 * asynchronously — the launch path must never block on git. A child that
 * starts before the file lands, or whose git failed, simply sees no baseline
 * (computeFilesChanged guards with null). Returns null when the cwd is not
 * inside a git repo. */
export function prepareGitBaseline(
  baselinePath: string,
  childCwd: string,
  runGit: AsyncGitRunner = runGitAsync,
): string | null {
  let root: string;
  try {
    root = repoRootFor(childCwd);
    if (!existsSync(join(root, ".git"))) return null;
  } catch {
    return null;
  }
  runGit(["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], (porcelain) => {
    if (porcelain === null) return;
    try {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, JSON.stringify({ repoRoot: root, porcelain }), "utf8");
    } catch {
      // Best-effort: the child-side guard treats a missing file as no baseline.
    }
  });
  return baselinePath;
}

/** Diff the end-state git status against the baseline porcelain: paths that
 * were added, removed, or changed status code since the spawn, sorted and
 * capped at 200. ANY failure (missing/empty/corrupt baseline, git error)
 * yields null — callers omit the field entirely. */
export function computeFilesChanged(baselinePath: string, gitFn: GitRunner = runGitSync): string[] | null {
  try {
    const baseline = readBaseline(baselinePath);
    if (!baseline) return null;
    const current = gitFn(["-C", baseline.repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const before = parsePorcelainZ(baseline.porcelain);
    const after = parsePorcelainZ(current);
    const changed = new Set<string>();
    for (const [path, code] of after) {
      if (before.get(path) !== code) changed.add(path);
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.add(path);
    }
    return [...changed].sort().slice(0, FILES_CHANGED_CAP);
  } catch {
    return null;
  }
}

/** Paths the child READ via read-ish tool calls (piread/piedit `path`
 * argument), extracted from its session file's toolCall entries: deduped,
 * sorted, capped at 50. Null when the session file is unreadable.
 * The delivery path hands in the entries it already parsed for
 * stats/summary (`preParsedEntries`) so the session file is parsed once per
 * delivery; the file path stays for every other caller. The optional
 * `options.parseCalls` is a `{ parses }` tally incremented on each real file
 * parse (test hook). */
export function extractFilesRead(
  sessionFile: string,
  preParsedEntries?: ReadonlyArray<unknown> | null,
  options?: { parseCalls?: { parses: number } },
): string[] | null {
  try {
    let source: ReadonlyArray<unknown>;
    if (Array.isArray(preParsedEntries)) {
      source = preParsedEntries;
    } else {
      if (options?.parseCalls) options.parseCalls.parses += 1;
      source = getNewEntries(sessionFile, 0);
    }
    const entries = source as unknown as Array<Record<string, any>>;
    const paths = new Set<string>();
    for (const entry of entries) {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== "toolCall") continue;
        if (part.name !== "piread" && part.name !== "piedit") continue;
        const p = part?.arguments?.path;
        if (typeof p === "string" && p.trim()) paths.add(p.trim());
      }
    }
    return [...paths].sort().slice(0, FILES_READ_CAP);
  } catch {
    return null;
  }
}

/** `git -C <baseline.repoRoot> diff HEAD --no-color -U1 -- <files>` output
 * capped at 1500 chars; null on failure, empty diff, or empty file list.
 * `HEAD` (not the default index-vs-worktree diff) so staged-only changes
 * appear; truly untracked files still show nothing — fail-soft null. */
export function gitDiffForBaseline(
  baselinePath: string,
  files: string[],
  gitFn: GitRunner = runGitSync,
): string | null {
  if (!files || files.length === 0) return null;
  try {
    const baseline = readBaseline(baselinePath);
    if (!baseline) return null;
    const out = gitFn(["-C", baseline.repoRoot, "diff", "HEAD", "--no-color", "-U1", "--", ...files]);
    if (!out || !out.trim()) return null;
    return out.length > DIFF_CAP_CHARS ? out.slice(0, DIFF_CAP_CHARS) : out;
  } catch {
    return null;
  }
}

/** Extra per-result context kept in the history file ONLY — never in the
 * drain-managed inbox record. `turns` is the budget meter's final count at
 * delivery; tokens/cost/duration are mirrored from the record itself. */
export interface SubagentHistoryExtra {
  files_read?: string[];
  diff?: string;
  turns?: number;
  /** Park-to-launch wait (ms) for a spawn that queued before launching;
   *  omitted for immediate spawns. */
  queueWaitMs?: number;
}

/** One record of the append-only per-repo history file. */
export interface SubagentHistoryRecord {
  id: string;
  ts: number;
  name: string;
  files_changed: string[];
  files_read?: string[];
  diff?: string;
  summary: string;
  turns?: number;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** History file location: same directory as the durable inbox (honors the
 * PI_SUBAGENT_INBOX override, so isolated processes never touch the repo's
 * real history). */
export function subagentHistoryPath(repoRoot: string): string {
  const inbox = process.env.PI_SUBAGENT_INBOX || resultInboxPath(repoRoot);
  return join(dirname(inbox), "subagent-history.jsonl");
}

function appendHistoryLine(record: InboxRecord, extra?: SubagentHistoryExtra): void {
  const path = subagentHistoryPath(record.repoRoot);
  // Usage mirror for future-wave planning: tokens and cost come from the
  // SAME numbers already computed for InboxRecord.stats (no re-parse),
  // turns from the delivery-time meter read, duration from elapsed.
  const stats = record.stats as { cost?: unknown } | null | undefined;
  const costUsd = typeof stats?.cost === "number" && Number.isFinite(stats.cost) ? stats.cost : undefined;
  const tokens = record.stats ? usageTokens(record.stats as Parameters<typeof usageTokens>[0]) : 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      id: record.id,
      ts: record.ts,
      name: record.name,
      files_changed: [...(record.files_changed ?? [])].sort().slice(0, FILES_CHANGED_CAP),
      ...(extra?.files_read?.length ? { files_read: extra.files_read } : {}),
      ...(extra?.diff ? { diff: extra.diff } : {}),
      ...(typeof extra?.turns === "number" ? { turns: extra.turns } : {}),
      ...(typeof extra?.queueWaitMs === "number" && Number.isFinite(extra.queueWaitMs) && extra.queueWaitMs > 0
        ? { queueWaitMs: Math.round(extra.queueWaitMs) }
        : {}),
      ...(tokens > 0 ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Math.round(record.elapsed * 1000),
      summary: (record.summary ?? "").replace(/\s+/g, " ").trim().slice(0, HISTORY_SUMMARY_CHARS),
    });
    // Appends are append-only: a read-modify-write appender drops a sibling
    // writer's line (child self-report racing parent delivery) that lands
    // between its read and its write, and a crash mid-rewrite truncates all
    // history. The ONLY rewrite is rotation, and it fires solely when the
    // file is unchanged since the read (mtimeMs+size recheck — the same
    // lost-update guard the inbox compaction uses); a refused rotation just
    // defers to the next append. That recheck is check-then-write, not
    // atomic: an append landing between the re-stat and the rewrite is
    // still dropped — the same residual window the inbox compaction accepts
    // at this write rate.
    let rotation: { lines: string[]; mtimeMs: number; size: number } | null = null;
    try {
      const readAt = statSync(path);
      const existing = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      // Rotation: past the cap, keep the most recent half before appending.
      if (existing.length > HISTORY_MAX_LINES) {
        rotation = { lines: existing.slice(-HISTORY_KEEP_LINES), mtimeMs: readAt.mtimeMs, size: readAt.size };
      }
    } catch {
      // Fresh file — nothing to rotate, plain append below.
    }
    if (rotation) {
      try {
        const now = statSync(path);
        if (now.mtimeMs === rotation.mtimeMs && now.size === rotation.size) {
          writeFileSync(path, [...rotation.lines, line].join("\n") + "\n", "utf8");
          return;
        }
        // Changed since the read: rewriting could drop the interleaved line —
        // fall through to a plain append and rotate another day.
      } catch {
        // Unstatable: fall through to the append.
      }
    }
    // Crash residue: a mid-append crash can leave the last line without its
    // newline. Gluing onto it merges both records into one invalid JSON line
    // — readers drop BOTH, and below the rotation threshold the residue is
    // never rewritten away. Probe the last byte and supply the missing
    // newline: the residue is sacrificed, the new record still parses.
    // One fd for the whole probe: fstat the OPEN fd (never the path) and
    // read at that fd's size-1, so the offset and the size come from one
    // snapshot — a path stat and a separate open can straddle an append and
    // probe a mid-file byte. An append racing after the fstat only grows the
    // file past this offset; it never moves it (same residual window the
    // rotation guard's recheck accepts).
    let prefix = "";
    try {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) prefix = "\n";
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Probe is best-effort: on failure append exactly as before.
    }
    appendFileSync(path, prefix + line + "\n", "utf8");
  } catch {
    // Best-effort: history enriches future spawns; a lost line is not a lost result.
  }
}

/** Stat-keyed cache for readRecentResults — an unchanged history file
 * (same mtimeMs + size) returns the cached parse instead of re-reading the
 * whole tail on every spawn. */
const recentResultsCache = new Map<
  string,
  { mtimeMs: number; size: number; records: SubagentHistoryRecord[] }
>();

/** Read the last `limit` history records, skipping corrupt lines and keeping
 * the last line per id (child self-report, then the richer parent record).
 * Cached by stat (mtimeMs + size); the cache holds the full deduped list so
 * different `limit`s slice their own tails. The optional `options.parseCalls`
 * is a `{ parses }` tally incremented on each real parse (test hook). */
export function readRecentResults(
  repoRoot: string,
  limit: number,
  options?: { parseCalls?: { parses: number } },
): SubagentHistoryRecord[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const historyPath = subagentHistoryPath(repoRoot);
  let stat: { mtimeMs: number; size: number };
  try {
    const st = statSync(historyPath);
    stat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return [];
  }
  const hit = recentResultsCache.get(historyPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.records.slice(Math.max(0, hit.records.length - limit));
  }
  if (options?.parseCalls) options.parseCalls.parses += 1;
  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, SubagentHistoryRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SubagentHistoryRecord;
      if (rec && typeof rec.id === "string") byId.set(rec.id, rec);
    } catch {
      // A corrupt line (crash mid-write) must not blind the whole read.
    }
  }
  const all = [...byId.values()];
  recentResultsCache.set(historyPath, { mtimeMs: stat.mtimeMs, size: stat.size, records: all });
  return all.slice(Math.max(0, all.length - limit));
}

/** Record shape buildPriorWorkBlock renders. */
export interface PriorWorkRecord {
  id?: string;
  name: string;
  ts: number;
  files_changed: string[];
  files_read?: string[];
  diff?: string;
  summary?: string;
}

function segmentOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

function anyOverlap(paths: string[], scope: string[]): boolean {
  return paths.some((p) => scope.some((s) => segmentOverlap(p, s)));
}

/** Format the prior-work injection block for a child whose scope overlaps
 * recent history records — overlap on files_changed OR files_read counts.
 * At most 2 (most recent) records, 1200 chars total: changed paths are
 * capped at 10, the diff excerpt at 800, the summary at 300, shrinking
 * further until the block fits. Each kept row's header carries a greppable
 * artifact reference — `[id <id> @ <historyPath>]` — so the child can pull
 * the full record from the history file on demand; the reference is part
 * of the rendered row, so the char cap stays enforced after it is added.
 * Null when nothing overlaps. */
export function buildPriorWorkBlock(
  records: PriorWorkRecord[],
  scopePaths: string[],
  opts: { now?: number; maxRecords?: number; maxChars?: number; historyPath?: string } = {},
): string | null {
  const scope = scopePaths.filter((p) => typeof p === "string" && p.trim());
  if (scope.length === 0) return null;
  const matching = records.filter(
    (r) => anyOverlap(r.files_changed ?? [], scope) || anyOverlap(r.files_read ?? [], scope),
  );
  if (matching.length === 0) return null;
  const now = opts.now ?? Date.now();
  const maxRecords = Math.max(1, opts.maxRecords ?? 2);
  const maxChars = opts.maxChars ?? 1200;
  const tail =
    "Do not re-read these files to reconstruct this context; verify only what your task requires.";

  const render = (rec: PriorWorkRecord, diffBudget: number, summaryBudget: number): string => {
    const lines: string[] = [];
    const mins = Math.max(0, Math.round((now - rec.ts) / 60000));
    const ref = rec.id
      ? ` [id ${rec.id}${opts.historyPath ? ` @ ${opts.historyPath}` : ""}]`
      : "";
    lines.push(`Prior work touching your scope (from ${rec.name}, finished ${mins} min ago)${ref}:`);
    for (const p of rec.files_changed.slice(0, 10)) lines.push(`- ${p}`);
    if (rec.files_changed.length > 10) {
      lines.push(`… +${rec.files_changed.length - 10} more changed files`);
    }
    const readOverlap = (rec.files_read ?? []).filter((p) => scope.some((s) => segmentOverlap(p, s)));
    if (readOverlap.length > 0) lines.push(`Read in your scope: ${readOverlap.slice(0, 10).join(", ")}`);
    if (rec.diff) {
      lines.push(`Diff (first ${diffBudget} chars):`);
      lines.push(rec.diff.slice(0, diffBudget));
    }
    if (rec.summary) {
      lines.push(rec.summary.replace(/\s+/g, " ").trim().slice(0, summaryBudget));
    }
    return lines.join("\n");
  };

  const build = (recs: PriorWorkRecord[], diffBudget: number, summaryBudget: number): string =>
    recs.map((r) => render(r, diffBudget, summaryBudget)).join("\n\n") + "\n" + tail;

  let picked = matching.slice(-maxRecords).reverse();
  let block = build(picked, 800, 300);
  while (block.length > maxChars && picked.length > 1) {
    picked = picked.slice(0, -1);
    block = build(picked, 800, 300);
  }
  if (block.length > maxChars) {
    // One record still over budget: shrink the diff excerpt, then the summary.
    let fitted: string | null = null;
    for (let d = 800; d >= 0 && fitted === null; d -= 200) {
      for (let s = 300; s >= 0; s -= 100) {
        const candidate = build(picked, d, s);
        if (candidate.length <= maxChars) {
          fitted = candidate;
          break;
        }
      }
    }
    block = fitted ?? block.slice(0, maxChars);
  }
  return block;
}

type DrainFileStat = { mtimeMs: number; size: number } | null;

/** turn_start drains re-run every turn; this gate keeps an UNCHANGED inbox
 * (same mtimeMs + size, plus the drain state file's stat) from being
 * re-read and re-parsed each time. Keyed per inbox path AND session id —
 * the skip decision depends on which session is draining (own-parent
 * records stay claimable by their parent). The state file's stat is part
 * of the key so deleting it re-opens the gate instead of wedging it: with
 * the state gone every record is fresh again and must be re-read. */
const drainStatGate = new Map<string, { inbox: DrainFileStat; state: DrainFileStat }>();

function statOf(path: string): DrainFileStat {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function sameFileStat(a: DrainFileStat, b: DrainFileStat): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Records not yet drained for this repo, oldest first. The spawning parent's
 * own records are skipped (it received the direct in-memory steer) but stay
 * claimable — another session in the repo still surfaces them. The optional
 * `options.reads` is a `{ count }` tally incremented on each real inbox read
 * (test hook for the stat gate). */
export function drainSubagentResults(
  repoRoot: string,
  sessionId?: string | null,
  options?: { reads?: { count: number } },
): InboxRecord[] {
  const inboxPath = resultInboxPath(repoRoot);
  const statePath = drainStatePath(repoRoot);
  const gateKey = `${inboxPath}\u0000${sessionId ?? ""}`;
  // Gate marks record what a completed drain observed; a read AT stat older
  // than the disk (an append raced us) re-opens the gate next drain.
  const setGate = (inbox: DrainFileStat): void => {
    drainStatGate.set(gateKey, { inbox, state: statOf(statePath) });
  };
  const stat = statOf(inboxPath);
  const gate = drainStatGate.get(gateKey);
  if (gate && sameFileStat(gate.inbox, stat) && sameFileStat(gate.state, statOf(statePath))) {
    return [];
  }
  if (stat === null) {
    // Missing file: nothing to drain. Record the observation so repeat
    // turn_start drains skip straight past it; a newly created file changes
    // the stat and is read normally.
    setGate(null);
    return [];
  }
  const readAtMs = stat.mtimeMs;
  const readAtSize = stat.size;
  let records: InboxRecord[];
  try {
    if (options?.reads) options.reads.count += 1;
    const raw = readFileSync(inboxPath, "utf8");
    records = raw
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        // A corrupt line (crash mid-append) must not blind the whole drain:
        // skip it — a later full-drain compaction rewrites the file without it.
        try {
          return [JSON.parse(line) as InboxRecord];
        } catch {
          return [];
        }
      });
  } catch {
    // A transient read failure must never be cached as "drained".
    return [];
  }
  let drainedIds: string[] = [];
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { drained?: string[] };
    if (Array.isArray(state.drained)) drainedIds = state.drained;
  } catch {}
  const seen = new Set(drainedIds);

  // The same id can be appended twice (child self-report + parent delivery):
  // keep the last line — the parent's record is richer and marked observed.
  const byId = new Map(records.map((r) => [r.id, r]));
  const fresh = [...byId.values()].filter((r) => !seen.has(r.id));
  if (fresh.length === 0) {
    setGate({ mtimeMs: readAtMs, size: readAtSize });
    return [];
  }

  // A record the spawning parent never observed surfaces even to that same
  // (resumed) session — the in-memory steer never happened.
  const toSurface = fresh.filter(
    (r) => r.observedByParent === false || !sessionId || r.parentSessionId !== sessionId,
  );
  if (toSurface.length === 0) {
    setGate({ mtimeMs: readAtMs, size: readAtSize });
    return [];
  }

  // Only surfaced records are marked drained — a record skipped because the
  // draining session IS its parent must stay claimable by other sessions.
  const nowSeen = [...seen, ...toSurface.map((r) => r.id)].slice(-1000);
  try {
    writeFileSync(statePath, JSON.stringify({ drained: nowSeen }), "utf8");
  } catch {
    // A failed state write only risks a duplicate surface later, never a loss.
  }
  // Once every record is drained the inbox is dead weight — compact it so the
  // file cannot grow without bound. The mtime re-check refuses the rewrite if
  // anything appended since the read: a lost append would be a lost result.
  const surfaced = new Set(toSurface.map((r) => r.id));
  if (records.every((r) => seen.has(r.id) || surfaced.has(r.id))) {
    try {
      const st = statSync(inboxPath);
      if (st.mtimeMs === readAtMs && st.size === readAtSize) {
        writeFileSync(inboxPath, "", "utf8");
        unlinkSync(statePath);
        // The compacted (empty) file's fresh stat is the safe skip point.
        setGate(statOf(inboxPath));
        return toSurface;
      }
    } catch {
      // Compaction is best-effort; the state file still prevents resurfacing.
    }
  }
  setGate({ mtimeMs: readAtMs, size: readAtSize });
  return toSurface;
}
