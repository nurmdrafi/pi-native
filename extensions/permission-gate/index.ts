/**
 * Permission gate — mechanical enforcement of AGENTS.md tool-call rules.
 * Blocks violations with a corrective reason before the tool runs, or caps
 * output after it; every block reason carries the fix.
 *
 * CURRENT rules (IDs are stable; family = block-reason prefix):
 * | ID  | Family / mechanism            | Enforces |
 * |-----|-------------------------------|----------|
 * | AG  | Anchor Guard                  | edit oldText: existence (exact+fuzzy), uniqueness, no intra-call overlap; snippet on a miss |
 * | R1  | Token Economy (Re-read)       | no read whose window is fully covered by in-context spans (reads/edits/writes/@file injections); stat-mismatch invalidation |
 * | R1b | Token Economy (Big read)      | whole-file (no-limit) or >=500-line-window read of a >10KB file blocked with a targeted-window fix |
 * | R1c | Locate-first                  | a >=100-line window on a path no search command named this session is blocked — `rg` first, then read the hit's range |
 * | P1  | Token Economy (Piread-first)  | built-in read of a text file blocked — use the piread tool; images keep `read` (piread delegates them internally) |
 * | P2  | Token Economy (Pibash-first)  | built-in bash blocked — use the pibash tool (same schema, full bash-kind rules; pibash falls back itself) |
 * | P3  | Token Economy (Pibash/Piread-first) | a codemode script that calls built-in `tools.bash`/`tools.read` is blocked — call `tools.pibash`/`tools.piread` (the sandbox used to sidestep P1/P2 entirely) |
 * | P4  | Codemode (Script)             | a codemode script that does not PARSE as an async function body is blocked before execution — a syntax/escaping slip costs a wasted turn otherwise (template-literal backticks, escaped quotes) |
 * | H1  | output cap (non-blocking)     | bash output capped at 100 lines / 4KB UTF-8; oversized first line head+tail; tail spilled to $TMPDIR/pgate-spill; errors capped too |
 * | H1b | read cap (non-blocking)       | read/piread result over 300 lines / 8KB truncated to the head, full text spilled to $TMPDIR/pgate-spill with a pointer — reads had no post-cap before |
 * | H2  | Permission Gate (Destructive) | destructive commands need approval: chat yes / UI confirm; fail closed headless; re-send re-prompts |
 * | R9  | Commitlint                    | conventional-commit headers, subject case, body line length (incl. heredoc bodies), pre-hook |
 * | TC1 | Toolchain (pnpm)              | npm/npx/yarn in a pnpm repo (packageManager/pnpm-lock) — pnpm run/exec/dlx |
 * | TC2 | Toolchain (Node)              | node-family binary under an exact x.y.z Node pin (.nvmrc/engines) the interpreter misses — nvm use first |
 * | SS1 | Search (Scope)                | recursive grep with no path/glob scope — scope it or use rg |
 * | PB1 | Portability (grep -P)         | grep -P on darwin — rg / grep -E |
 * | NM1 | Search (node_modules)         | read/search node_modules — ask user first; @earendil-works pre-approved |
 * | R10 | Token Economy (Re-run)         | identical command re-run within 10 min without an edit/write/mutating-bash since is blocked |
 * | RB  | Token Economy (Re-block)      | verbatim re-send of a just-blocked command escalates (never armed for H2) |
 * | VM  | violation memory              | cross-session per-family block counts inject lessons into the next system prompt (threshold: 5 distinct sessions / 30d) |
 * | AT1 | adoption telemetry            | a completed native-tool call (pibash/piread/piedit/pidx) appends a `{kind:"adoption"}` line — non-adoption was invisible when only blocks were logged |
 * | CN  | cadence nudge (non-blocking)  | tool_result note at ~200 user turns / ~150K context tokens (AGENTS.md Token Economy); resets on compaction |
 *
 * Destructive matching is a TRIPWIRE, not a boundary — see destructive.ts.
 * Change history lives in git log; this table lists what is CURRENTLY enforced.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { config, ruleEnabled } from "./config.ts";

/** Bash-kind predicate: `bash` plus the native `pibash` tool (2026-10-18
 * pibash adoption). Both share the bash schema and both must run the full
 * bash rule set — H1 output cap, R10 re-run guard, destructive analysis,
 * malformed-input check, and mutation tracking. `isToolCallEventType` has no
 * `pibash` overload (pi only types built-in names), so the native name is
 * checked alongside it; the input shape is the bash input shape. */
function isBashKind(event: { toolName: string }): boolean {
  return event.toolName === "bash" || event.toolName === "pibash";
}

/** P4: does the codemode script parse as an async function body? Returns a
 * short `line N: message` pointer on a SyntaxError, else undefined. The
 * AsyncFunction constructor is the closest host-side model of the QuickJS
 * sandbox's wrapper (top-level `await`/`return` allowed).
 *
 * V8's SyntaxError carries no line/column, so the line is recovered by
 * bisecting line-prefixes: the first prefix that fails to parse is the last
 * line the error can be on (a multi-line construct pins to the line that
 * closed it, which is where the message points anyway). A non-SyntaxError
 * failure returns undefined — the guard only blocks scripts PROVEN not to
 * parse, never guesses on an unexpected throw. */
function codemodeParseError(code: string): string | undefined {
  const parse = (src: string): string | undefined => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new (Object.getPrototypeOf(async function () {}).constructor)(src);
      return undefined;
    } catch (err) {
      return err instanceof SyntaxError ? err.message.replace(/^SyntaxError:\s*/, "") : undefined;
    }
  };
  const full = parse(code);
  if (full === undefined) return undefined; // parses, or the throw was not a SyntaxError — never block
  const lines = code.split("\n");
  if (lines.length > 1) {
    // first line-prefix that fails to parse = the earliest line the error can be on
    for (let i = 1; i <= lines.length; i++) {
      if (parse(lines.slice(0, i).join("\n")) !== undefined)
        return i < lines.length ? `line ${i}: ${full}` : full;
    }
  }
  return full;
}
import type { ExtensionAPI, ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { homedir } from "os";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "fs";
import { readFile, lstat } from "fs/promises";
import { basename, dirname, join } from "path";

import { toLF, validateEditAnchors } from "./anchor-guard.ts";
import { capBashOutput, capReadOutput, isRustCompressed } from "./bash-cap.ts";
import { scrubBashText } from "./output-scrub.ts";
import {
  APPROVED_WINDOW_MS,
  APPROVAL_RE,
  PROTECTED_PREFIX_RE,
  isMutatingCommand,
  normalizeSegment,
  segmentDestructive,
  splitSegments,
} from "./destructive.ts";
import { validateCommitMessages } from "./commitlint.ts";
import {
  FAMILY_LESSONS,
  MEMORY_THRESHOLD,
  adoptionRecord,
  blockFamilyOf,
  memorySid,
  mergeLessonCounts,
  migrateRows,
  violationRecord,
} from "./violation-memory.ts";
import {
  certify,
  countTextLines,
  coversAll,
  HASH_CAP_BYTES,
  hashFile,
  hashText,
  normPath,
  snapshot,
} from "./read-coverage.ts";
import type { CoverageEntry, LineSpan } from "./read-coverage.ts";
import { toolchainCheck } from "./toolchain.ts";
import {
  nodeModulesPath,
  searchCheck,
  searchedPathsFrom,
} from "./search-guard.ts";

// ---- R1b + cadence thresholds (see index header table: R1b, CN) ----
/** big-read gate: a whole-file-ish request for a file larger than this is
 * blocked with a targeted-window reason (44KB/51KB whole-file reads rode two
 * sessions' prefixes; the read tool's own 2000-line/50KB truncation is too
 * generous to be the only brake). 2026-10-18: floor lowered 24KB→10KB —
 * piread compacts any read past its 2KB model budget, so a ~14KB whole read
 * came back with 11.5KB elided and still counted as "read" (dropx-admin
 * AddUser.jsx session). The gate must fire before compaction does. */
const BIG_READ_BYTES = 10_000;
/** a requested window at least this wide counts as whole-file-ish */
const BIG_READ_WIN = 500;
/** R1c locate-first: a window at least this wide on a path never searched
 * this session is a guess about where the content is. Kept well above
 * ordinary targeted reads (narrow-window cases read 5-50 lines) so a
 * legitimate first read still passes. */
const LOCATE_MIN_WIN = 100;
/** Built-in read is authoritative for images (piread is text-only and
 * delegates them internally). Any other extension goes through piread first
 * (2026-10-15 audit: the last session read 69 text files via built-in `read`
 * while piread existed). */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
/** cadence nudge thresholds, counted like AGENTS.md Token Economy does:
 * user turns (~200) or estimated context tokens (~150K) before proposing a
 * compaction/fresh-session hop (2026-10-10: 354/303-turn marathons re-billed
 * ~100M cacheRead each with zero compactions). The nudge is NON-blocking
 * (2026-10-11): appended to the next tool_result — the blocking variant cost
 * a re-issue turn and the model could not act on it mid-call anyway. */
const CADENCE_TURNS = 200;
const CADENCE_CTX_TOKENS = 150_000;

/** R10: re-running an unchanged base command inside this window re-sends output already in context */
const RERUN_WINDOW_MS = 10 * 60_000;
/** Re-block window: shorter than R10 — the verbatim re-send pattern is immediate (2026-10-08 audit: 3s and 2.5s gaps) */
const REBLOCK_WINDOW_MS = 2 * 60_000;
/**
 * Violation memory (2026-10-06 feedback: "LLM keeps repeating the same mistakes
 * every session"). Blocks correct within a session (98% one-shot recovery)
 * but the model is stateless across sessions and re-attempts the same families
 * in every new one (R2 cat-viewing persisted Sep→Oct in work-project logs).
 * Persisted per-family block counts pick the lessons injected into the next
 * session's system prompt — the only mechanism that can cut FIRST attempts.
 * Delete logs/violation-memory.json to reset; PGATE_MEMORY overrides the path.
 */
export default function (pi: ExtensionAPI) {
  /**
   * In-context coverage (2026-10-05 audit): per absolute path, the union of
   * line spans whose content this session has already put in context — read
   * results (their actual returned lines), edit results (applied text),
   * writes and images (whole file). A read is blocked only when its requested
   * window is FULLY covered; partial overlap passes (it brings new lines).
   * Resets: session_compact (the summary replaced the content), mtime+size
   * mismatch against the certified snapshot (external change — caught by
   * stat, not guessed from bash command text), a failed edit (context may
   * have drifted).
   *
   * Resume hydration (2026-10-07): session_start replays the prior branch's
   * read/write tool entries through the same certify() path (with an
   * entry-timestamp freshness check), so dup-read coverage survives a
   * process restart; edits clear the path (span derivation needs anchor
   * validation — skipping only loses savings, never adds a false block).
   */
  const coverage = new Map<string, CoverageEntry>();
  /** R1c locate-first: absolute paths a search command named this session. */
  const searchedPaths = new Set<string>();
  /** Record R1c search targets. Local closure: the path resolver and the
   * on-disk probe are already in scope. */
  const recordSearchedPaths = (segs: string[], cwd: string | undefined) => {
    for (const p of searchedPathsFrom(segs, cwd, normPath, existsSync))
      searchedPaths.add(p);
  };
  /** edit/write toolCallId -> { path, spans?, kind }, awaiting its tool_result */
  const pendingEdits = new Map<
    string,
    {
      path: string;
      spans?: LineSpan[];
      firstEditedLine?: number;
      preStat?: { mtimeMs: number; size: number };
      fuzzy?: boolean;
      kind: "edit" | "write";
    }
  >();
  /** read toolCallId -> { path, win }, awaiting its tool_result */
  const pendingReads = new Map<string, { path: string; win: LineSpan }>();
  /** R10: bash toolCallId -> normalized base command, awaiting its tool_result */
  const pendingBash = new Map<string, string>();
  /** R10: base command -> last-run record; re-runs are compared against it */
  const lastBashRun = new Map<
    string,
    { ts: number; mut: number; failed: boolean }
  >();
  // 2026-10-08 extensions audit (Re-block): pendingBash is only set AFTER all
  // checks pass, so blocked calls leave no tool_result-side trace — keep the
  // verbatim cmd keyed by toolCallId to recognize our own synthesized block
  // results. One lastBlockedBash slot: only the immediately preceding blocked
  // bash call can be "re-sent verbatim".
  const pendingBashFull = new Map<string, string>();
  let lastBlockedBash:
    { cmd: string; family: string; ts: number; mut: number } | undefined;
  /** cadence nudge state — user turns seen; reset on session_compact/session_start */
  let turnsSeen = 0;
  let cadenceFired = false;
  /** R10: bumped on every successful edit/write — a mutation makes verify re-runs legitimate */
  let mutationSeq = 0;
  /** H2: last user-approved destructive command (verbatim) + when */
  let lastApprovedDestructive: { cmd: string; ts: number } | undefined;
  /** H2/chat (2026-10-11): the latest user message approved destructive work —
   * counts as approval for the turn it arrived in (single ask; see APPROVAL_RE) */
  let promptApproves = false;

  // ---- violation memory: cross-session repeat-offense reduction ----
  // NDJSON append-only store (2026-10-07): parallel sessions (gated subagents)
  // made the read-modify-write JSON blob racy — last writer silently dropped
  // counts. Appends are atomic; aggregation happens at load. The legacy JSON
  // blob stays readable as a frozen base (pre-NDJSON telemetry, never written).
  const memoryNdjson =
    process.env.PGATE_MEMORY ??
    join(homedir(), ".pi", "agent", "logs", "violation-memory.ndjson");
  const memoryLegacy = process.env.PGATE_MEMORY
    ? memoryNdjson.replace(/\.ndjson$/, ".json")
    : join(homedir(), ".pi", "agent", "logs", "violation-memory.json");
  // H7 (2026-10-08): count DISTINCT SESSIONS per family in a rolling 30-day
  // window, not all-time block depth — one session hammering a family used to
  // hit the threshold alone (breadth across sessions is the actual signal that
  // a lesson belongs in the prompt). `sid` is the harness session id
  // (memorySid), not a per-process uuid: the old per-process value made every
  // writer disagree and counted processes instead of sessions.
  const sid = memorySid();
  const MEMORY_WINDOW_MS = 30 * 24 * 60 * 60_000;
  const loadCounts = (): Record<string, number> => {
    const distinct: Record<string, Set<string>> = {};
    const legacy: Record<string, number> = {};
    try {
      const blob: unknown = JSON.parse(readFileSync(memoryLegacy, "utf8"));
      if (blob && typeof blob === "object") {
        for (const [k, v] of Object.entries(blob as Record<string, unknown>))
          if (typeof v === "number") legacy[k] = v;
      }
    } catch {
      // absent or corrupt legacy blob — start from NDJSON alone
    }
    let lines = 0;
    try {
      const raw = readFileSync(memoryNdjson, "utf8").split("\n");
      for (let i = 0; i < raw.length; i++) {
        const line = raw[i];
        if (!line.trim()) continue;
        lines++;
        try {
          const e = JSON.parse(line) as {
            family?: string;
            sid?: string;
            n?: number;
            ts?: number;
          };
          if (typeof e.family !== "string") continue;
          if (typeof e.ts === "number" && Date.now() - e.ts > MEMORY_WINDOW_MS)
            continue; // rolled out
          const key =
            typeof e.sid === "string" && e.sid ? e.sid : `legacy-line-${i}`;
          (distinct[e.family] ??= new Set()).add(key);
        } catch {
          continue; // torn tail append — tolerate like pi's session files
        }
      }
    } catch {
      // no NDJSON yet — legacy counts (if any) stand alone
    }
    // Compact at load (H7) so a long-lived store does not grow unboundedly.
    // The rewrite is also the migration: legacy rows become the current shape,
    // legacy tool-fallback families are dropped (their cause was the unsigned
    // binary, not the model's behaviour), and rows outside the window go away.
    // Previously this kept one entry per family+session and silently discarded
    // the `reason`, which is what left the store unable to explain itself.
    if (lines > 200) {
      try {
        const parsed: unknown[] = [];
        for (const line of readFileSync(memoryNdjson, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            parsed.push(JSON.parse(line));
          } catch {
            // torn tail append — tolerate like pi's session files
          }
        }
        const migrated = migrateRows(parsed, { now: Date.now() });
        const tmp = `${memoryNdjson}.compact`;
        writeFileSync(
          tmp,
          migrated.rows.map((e) => `${JSON.stringify(e)}\n`).join(""),
        );
        renameSync(tmp, memoryNdjson);
      } catch {
        // compaction is best-effort telemetry hygiene — never break the loop
      }
    }
    const counts: Record<string, number> = {};
    for (const [family, set] of Object.entries(distinct))
      counts[family] = set.size;
    // The legacy blob's depth is depth, not sessions (see mergeLessonCounts):
    // its contribution stays a floor of 1 so MEMORY_THRESHOLD keeps counting
    // distinct sessions instead of mixing depth into a session count.
    return mergeLessonCounts(counts, legacy);
  };
  const counts = loadCounts();
  /** record a block's family; persist top-offender telemetry for the next session's prompt */
  const blockCall = (reason: string): { block: true; reason: string } => {
    const colon = reason.indexOf(":");
    const family = colon === -1 ? reason : reason.slice(0, colon); // colon-less reason → whole string, never a truncated key
    if (FAMILY_LESSONS[family]) {
      counts[family] = (counts[family] ?? 0) + 1;
      try {
        mkdirSync(dirname(memoryNdjson), { recursive: true });
        appendFileSync(
          memoryNdjson,
          `${JSON.stringify(violationRecord({ family, sid, ts: Date.now(), reason }))}\n`,
        );
      } catch {
        // telemetry must never break the agent loop
      }
    }
    return { block: true, reason };
  };
  // AT1 (2026-10-21 audit): adoption telemetry. The NDJSON above only records
  // BLOCKS, so the store made silent non-adoption invisible — 1 "Pibash-first"
  // line against 27 "Pibash (fallback)" lines read as "pibash is used but
  // degrading" when the truth was "pibash is never called". A successful call
  // to a native tool now appends a lightweight `{kind:"adoption"}` line, so a
  // session's native-tool usage is countable next to the built-in usage the
  // P1/P2/P3 families already capture. Same append-only store, same
  // best-effort discipline; loadCounts ignores non-family lines.
  const NATIVE_TOOLS = new Set(["pibash", "piread", "piedit", "pidx"]);
  const recordAdoption = (toolName: string): void => {
    if (!NATIVE_TOOLS.has(toolName)) return;
    try {
      mkdirSync(dirname(memoryNdjson), { recursive: true });
      appendFileSync(
        memoryNdjson,
        `${JSON.stringify(adoptionRecord({ tool: toolName, sid, ts: Date.now() }))}\n`,
      );
    } catch {
      // telemetry must never break the agent loop
    }
  };
  // S4 fix 1 (2026-10-15, spec §5.2): fail-closed handler wrap — an unexpected
  // exception in ANY handler must never fail open. tool_call → generic internal
  // block (the call never runs; a rejected handler otherwise lets the tool
  // proceed); every other hook passes through with console.error (a
  // post-execution result must not be corrupted; prompt/session hooks have
  // nothing to prevent).
  const guarded = <E, R>(
    hook: string,
    handler: ExtensionHandler<E, R>,
  ): ExtensionHandler<E, R> =>
  async (event, ctx) => {
    try {
      return await handler(event, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (hook === "tool_call") {
        return blockCall(
          `Permission Gate (Internal): unexpected error while checking this call (${msg}) — failing closed. Ask the user in chat before re-sending.`,
        ) as unknown as R;
      }
      console.error(
        `[permission-gate] ${hook} handler error (passing through): ${msg}`,
      );
      return;
    }
  };
  // pi.on with every handler wrap-checked (above); the cast keeps pi's own
  // overload-checked signatures — the wrapper is type-transparent
  const on = ((
    event: string,
    handler: (e: never, c: never) => unknown,
  ) =>
    pi.on(
      event as never,
      guarded(event, handler as never) as never,
    )) as typeof pi.on;
  // module scope: one process can host several sessions (ctx.newSession, e.g.
  // /handoff, replaces the session in-process) — injection stays suppressed for
  // the replacement session; accepted for now, name documents the scope
  let memoryInjectedThisProcess = false;

  // ---- S4 (2026-10-15, spec §6.8): write/edit protected-path confirm ----
  /** realpath the write/edit target (missing leaf → realpath the parent and
   * rejoin the basename — the common create-through-symlink case); returns
   * the H2 confirm subject when it lands in a protected tree, else undefined */
  const protectedPathReason = (
    tool: string,
    abs: string,
  ): string | undefined => {
    if (!abs) return undefined;
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      try {
        real = join(realpathSync(dirname(abs)), basename(abs));
      } catch {
        return undefined; // unresolvable — the tool's own error handles it
      }
    }
    return PROTECTED_PREFIX_RE.test(real)
      ? `${tool} '${abs.slice(0, 28)}' → protected (symlink-resolved) and`
      : undefined;
  };
  /** H2 approval ladder, shared by destructive bash segments and the S4
   * fix 8 write/edit protected-path confirm: chat approval (promptApproves)
   * → remembered verbatim approval (2 min) → UI dialog with timeout (S-3) →
   * fail closed. Returns undefined = allowed; otherwise the block reason. */
  const confirmDestructive = async (
    key: string,
    subject: string,
    ctx:
      | {
          hasUI?: boolean;
          ui?: { confirm(t: string, m: string): Promise<boolean> };
        }
      | undefined,
  ): Promise<string | undefined> => {
    if (promptApproves) return undefined;
    if (
      lastApprovedDestructive &&
      lastApprovedDestructive.cmd === key &&
      Date.now() - lastApprovedDestructive.ts < APPROVED_WINDOW_MS
    )
      return undefined;
    let approved = false;
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
      const t = Number(process.env.PGATE_CONFIRM_TIMEOUT_MS);
      const ms = Number.isFinite(t) && t > 0 ? t : 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        approved =
          (await Promise.race([
            ctx.ui.confirm("Allow destructive command?", key),
            new Promise<boolean>((r) => {
              timer = setTimeout(() => r(false), ms);
            }),
          ])) === true; // S4 fix 2: strict boolean — truthy non-booleans never approve
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (approved) {
      lastApprovedDestructive = { cmd: key, ts: Date.now() };
      return undefined;
    }
    return (
      `Permission Gate (Destructive): ${subject} needs the user's approval ` +
      `first — ${ctx?.hasUI ? "the user declined" : "no chat approval, no confirm dialog"}; ask in chat and wait. Never run it unprompted.`
    );
  };

  on("before_agent_start", (event) => {
    if (!ruleEnabled("violationMemory")) return;
    if (memoryInjectedThisProcess) return; // once per process — per-run re-entry must not stack copies
    memoryInjectedThisProcess = true;
    const lessons = Object.entries(counts)
      .filter(([family, n]) => n >= MEMORY_THRESHOLD && FAMILY_LESSONS[family])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([family]) => `- ${FAMILY_LESSONS[family]}`);
    if (lessons.length === 0) return;
    // pi seeds appendSystemPrompt to "" today; guard anyway — undefined must never
    // leak into the system prompt as the literal "undefined" (2026-10-07 review)
    event.systemPromptOptions.appendSystemPrompt =
      (event.systemPromptOptions.appendSystemPrompt ?? "") +
      `<violation-memory>\nRecurring tool-call violations from your prior sessions (gate telemetry) — apply before the first call:\n${lessons.join("\n")}\n</violation-memory>\n`;
  });

  // R-inj (2026-10-10 session audit): CLI @file args arrive as
  // `<file name="/abs/path">\n…content…\n</file>` blocks in the expanded
  // prompt (cli/file-processor); TUI @paths are literal text — nothing to
  // certify. A block that byte-matches the file on disk certifies whole-file
  // coverage, so R1 blocks re-reads of prompt-injected content exactly like
  // read results. Hint/empty/mismatched blocks certify nothing — err toward
  // allowing (never over-block on unverifiable injections).
  on("before_agent_start", async (event) => {
    // prompt exists only on user-triggered runs (custom messages carry
    // "message", not "prompt" - BeforeAgentStartEvent is a union)
    if (event.messageType !== "user") return;
    if (!event.prompt.includes('<file name="')) return;
    for (const m of event.prompt.matchAll(
      /<file name="([^"]+)">([\s\S]*?)<\/file>/g,
    )) {
      const path = normPath(m[1]);
      if (!path) continue;
      // file-processor emits `\n${content}\n` inside the tags — strip exactly
      // one boundary newline each side; content itself is untouched
      const body = m[2].replace(/^\n/, "").replace(/\n$/, "");
      let disk: string;
      try {
        disk = toLF(await readFile(path, "utf8")).replace(/^\uFEFF/, "");
      } catch {
        continue; // unreadable/missing: nothing to certify
      }
      if (disk !== body) continue; // hints, truncation, drift: not verifiably in context
      const snap = await snapshot(path);
      if (snap)
        coverage.set(path, {
          spans: [{ start: 1, end: Infinity }],
          kind: "inject",
          stat: snap,
          // S5 M3: free hash — `disk` was already read for the byte-match
          hash:
            Buffer.byteLength(disk) <= HASH_CAP_BYTES
              ? hashText(disk)
              : undefined,
        });
    }
  });

  // edit: anchor pre-validation first (existence, uniqueness, overlap);
  // only a call that passes is tracked for read-freshness below
  // per-turn chat state (2026-10-11): turns drive the cadence nudge, the
  // latest prompt arms/disarms chat approval for the destructive gate
  on("before_agent_start", (event) => {
    turnsSeen++;
    const prompt = event.messageType === "user" ? event.prompt : "";
    promptApproves = APPROVAL_RE.test(prompt);
  });

  on("tool_call", async (event, ctx) => {
    // P3 (2026-10-21 audit): codemode reaches every tool from a sandbox, so the
    // model-facing names below are never the ones a script uses. A script that
    // calls the BUILT-IN `bash`/`read` instead of the native `pibash`/
    // `piread` sidesteps P1/P2 entirely — this scoped check re-applies the
    // same rule inside the script source. The check only fires when the
    // corresponding native extension is live (its opt-out env var removes the
    // tool, so blocking would strand the agent), and never matches the native
    // names (`tools.pibash`/`tools.piread` do not match `tools.bash`/
    // `tools.read` under the word-boundary regex).
    // P4 (2026-10-21 audit): the codemode sandbox runs the script as an async
    // function body, so a script that does not PARSE never reaches a tool and
    // burns a whole turn (session logs: `SyntaxError: Unexpected identifier
    // 'sleep'`, `unexpected end of file`) — most often a template-literal
    // backtick or an "escaped" quote that closed the literal early. A parse
    // check costs microseconds and replaces the sandbox's opaque failure with
    // a line pointer plus the escaping rule. Runs before P3 so a script that is
    // both non-parsing and built-in-name-calling gets the parse fix first (it
    // must compile before its calls mean anything).
    if (event.toolName === "codemode" && ruleEnabled("codemodeScriptGuard")) {
      const code = (event.input as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) {
        const parseError = codemodeParseError(code);
        if (parseError)
          return blockCall(
            `Codemode (Script): script does not parse (${parseError}) — it is an async function body; a stray backtick or an over-escaped quote usually closes a template/string early. Fix the escaping and re-send.`,
          );
      }
    }

    if (event.toolName === "codemode" && ruleEnabled("nativeToolsInScripts")) {
      const code = (event.input as { code?: unknown }).code;
      if (typeof code === "string") {
        if (
          process.env.PI_NATIVE_BASH !== "0" &&
          /\btools\s*\.\s*bash\s*\(/.test(code)
        )
          return blockCall(
            "Token Economy (Pibash-first): this codemode script calls the built-in bash tool — call tools.pibash({command, timeout}) instead (same schema, same rules; it falls back itself).",
          );
        if (
          process.env.PI_NATIVE_READ !== "0" &&
          /\btools\s*\.\s*read\s*\(/.test(code)
        )
          return blockCall(
            "Token Economy (Piread-first): this codemode script calls the built-in read tool — call the native tools.piread({path, offset, limit}) instead for text files (images still use the read tool).",
          );
      }
    }

    if (isToolCallEventType("edit", event) || isToolCallEventType("piedit", event)) {
      // S4 fix 3: malformed edit input — explicit block, never an analyzer throw
      if (typeof event.input.path !== "string" || !event.input.path.trim())
        return blockCall(
          "Permission Gate (Malformed): edit call has no path string — re-send the tool call with input.path.",
        );
      const path = normPath(event.input.path, ctx?.cwd);
      // S4 fix 8: symlink-resolved protected targets confirm through the
      // same H2 ladder as destructive bash — a write into <fake-home>/.ssh
      // via an in-cwd link must never land silently
      const prot = ruleEnabled("destructiveConfirm")
        ? protectedPathReason("edit", path)
        : undefined;
      if (prot) {
        const r = await confirmDestructive(`edit:${path}`, prot, ctx);
        if (r) return blockCall(r);
      }
      // Anchor Guard off: skip validation and coverage registration entirely —
      // the built-in editor's own validation is then the only check.
      const checked = ruleEnabled("editAnchorGuard")
        ? await validateEditAnchors(event.input, ctx?.cwd, coverage.get(path))
        : undefined;
      if (checked && "block" in checked) {
        // S5 M3: the hash disproved the certified spans/stat — drop them, or
        // R1 would block the corrective re-read as a dup-read (deadlock)
        if (checked.stale) coverage.delete(path);
        return blockCall(checked.reason);
      }
      pendingEdits.set(event.toolCallId, {
        path,
        spans: checked?.spans,
        firstEditedLine: checked?.firstEditedLine,
        preStat: checked?.preStat,
        fuzzy: checked?.fuzzy,
        kind: "edit",
      });
      return;
    }

    // R1: block a read whose requested window is fully covered by this
    // session's in-context spans (2026-10-05 coverage model).
    // `piread` (native read pipeline, 2026-10-18) shares the read schema —
    // both names get the same read handling so gate protection survives
    // the individual registration.
    if (
      (ruleEnabled("reReadGuard") ||
        ruleEnabled("largeReadGuard") ||
        ruleEnabled("locateFirst")) &&
      (isToolCallEventType("read", event) ||
        isToolCallEventType("piread", event))
    ) {
      // S4 fix 3: malformed read input — explicit block, never an analyzer throw
      if (typeof event.input.path !== "string" || !event.input.path.trim())
        return blockCall(
          "Permission Gate (Malformed): read call has no path string — re-send the tool call with input.path.",
        );
      const display = String(event.input.path ?? "");
      const path = normPath(display, ctx?.cwd);
      // clamp the path contribution so the reason stays inside the 220c diet cap for any path length or kind
      const shown = display.length > 57 ? `…${display.slice(-56)}` : display;
      // NM1 (2026-10-13 audit): dependency internals — a node_modules/.pnpm
      // path was read straight through the read tool; ask user first (@earendil-works exempt)
      const nm = ruleEnabled("dependencyInternals") ? nodeModulesPath(display) : undefined;
      if (nm) return blockCall(nm);
      // P1 (2026-10-15 audit): piread-first. Built-in `read` on a text file is
      // blocked so the native pipeline (same schema, same coverage) is used;
      // images stay on `read`. piread itself falls back to the built-in reader
      // for images/binary/missing-binary, so no manual fallback is needed.
      // Skipped when the piread extension is opted out (PI_NATIVE_READ=0) —
      // then `piread` does not exist and blocking `read` would strand the agent.
      if (
        ruleEnabled("nativeReadFirst") &&
        isToolCallEventType("read", event) &&
        process.env.PI_NATIVE_READ !== "0" &&
        !IMAGE_EXTENSIONS.some((ext) => display.toLowerCase().endsWith(ext))
      ) {
        return blockCall(
          `Token Economy (Piread-first): '${shown}' is a text file — use the piread tool (piread {path, offset, limit}) instead of read. Images use the read tool.`,
        );
      }
      const start = Math.max(
        1,
        typeof event.input.offset === "number" ? event.input.offset : 1,
      );
      const win: LineSpan = {
        start,
        end:
          typeof event.input.limit === "number"
            ? start + event.input.limit - 1
            : Infinity,
      };
      // R1c locate-first: a WIDE window on a path no search has named this
      // session is a guess about where the content sits. Deliberately narrow:
      // whole-file reads belong to R1b, and windows under LOCATE_MIN_WIN are
      // ordinary targeted reads that must stay frictionless.
      if (
        ruleEnabled("locateFirst") &&
        win.end !== Infinity &&
        win.end - win.start + 1 >= LOCATE_MIN_WIN &&
        path &&
        !searchedPaths.has(path) &&
        !coverage.has(path)
      ) {
        return blockCall(
          `Locate-first: ${win.end - win.start + 1}-line window on '${shown}', which no search has named this session. \`rg -n <term> ${shown.replace(/^.*\//, "")}\`, then read the hit's range.`,
        );
      }
      // R1b (2026-10-10 session audit): first read of a large file requested
      // whole — block with the targeted-window fix. Windows narrower than
      // BIG_READ_WIN lines pass untouched, small files pass, R1 covers
      // re-reads of what is already certified in context.
      if (
        ruleEnabled("largeReadGuard") &&
        (win.end === Infinity || win.end - win.start >= BIG_READ_WIN)
      ) {
        const snap = await snapshot(path);
        if (snap && snap.size > BIG_READ_BYTES) {
          return blockCall(
            `Token Economy (Big read): '${shown}' is ~${Math.round(snap.size / 1024)}KB — target it with the piread tool (rg the symbol, then piread {path, offset, limit} ≤${BIG_READ_WIN} lines).`,
          );
        }
      }
      const prior = coverage.get(path);
      if (path && prior && coversAll(prior.spans, win)) {
        // freshness: only block while mtime+size still match the certified snapshot —
        // any external change (bash, IDE, git) shows up in stat without guessing
        // from command text; missing baseline or stat failure allows the re-read
        const now = path ? await snapshot(path) : undefined;
        if (
          now &&
          prior.stat &&
          now.mtimeMs === prior.stat.mtimeMs &&
          now.size === prior.stat.size
        ) {
          // 2026-10-11: report the span CONTAINING the requested window —
          // spans[0]..spans[last] overstated coverage when the union has gaps
          const sp =
            prior.spans.find(
              (s) => s.start <= win.start && win.start <= s.end,
            ) ?? prior.spans[0];
          const lo = sp.start;
          const hi = sp.end;
          return blockCall(
            `Token Economy (Re-read): ${lo === hi ? `line ${lo}` : `lines ${lo}–${hi === Infinity ? "EOF" : hi}`} of '${shown}' are already in context ` +
              `(${prior.kind}, file unchanged). Read another window via piread or act on what is there.`,
          );
        }
        coverage.delete(path); // changed on disk (or no baseline) — the read is legitimate
      }
      pendingReads.set(event.toolCallId, { path, win });
    }

    if (isToolCallEventType("write", event)) {
      // S4 fix 3: malformed write input — explicit block, never an analyzer throw
      if (typeof event.input.path !== "string" || !event.input.path.trim())
        return blockCall(
          "Permission Gate (Malformed): write call has no path string — re-send the tool call with input.path.",
        );
      const path = normPath(event.input.path, ctx?.cwd);
      // S4 fix 8: same symlink-resolved protected-path confirm as edit
      const prot = ruleEnabled("destructiveConfirm")
        ? protectedPathReason("write", path)
        : undefined;
      if (prot) {
        const r = await confirmDestructive(`write:${path}`, prot, ctx);
        if (r) return blockCall(r);
      }
      // S5 M1+M3+M2 (2026-10-16): write binding (spec §5.1–§5.3). A blind
      // full overwrite silently reverts external changes — the worst failure
      // class — so writes to EXISTING files bind like edits: stat drift since
      // the last certified read blocks Stale; same-stat content drift blocks
      // through the hash chain (drop coverage on that block, or R1 would
      // block the corrective re-read); a never-read existing file blocks
      // Unread (one targeted read is the cheap recovery). New/deleted files
      // pass — nothing to bind; missing stat/hash fails open throughout.
      {
        const display = String(event.input.path ?? "");
        const shown = display.length > 57 ? `…${display.slice(-56)}` : display;
        const prior = coverage.get(path);
        if (prior) {
          const now = await snapshot(path);
          if (
            prior.stat &&
            now &&
            (prior.stat.mtimeMs !== now.mtimeMs || prior.stat.size !== now.size)
          )
            return blockCall(
              `Anchor Guard (Stale): '${shown}' changed on disk since your last read (mtime/size) — re-read it, then re-send the write.`,
            );
          if (prior.stat && now && prior.hash) {
            const h = await hashFile(path);
            if (h && h !== prior.hash) {
              coverage.delete(path); // disproven spans/stat — let the re-read through
              return blockCall(
                `Anchor Guard (Stale): '${shown}' changed without mtime/size change (fast write / restored mtime) — re-read before overwriting.`,
              );
            }
          }
        } else {
          let exists = false;
          try {
            await lstat(path);
            exists = true;
          } catch {
            /* ENOENT: creating a new file — nothing to bind */
          }
          if (exists)
            return blockCall(
              `Anchor Guard (Unread): '${shown}' exists but was never read this session — read it before overwriting.`,
            );
        }
      }
      // whole file content is in context after a write — every window overlaps it
      pendingEdits.set(event.toolCallId, {
        path,
        spans: [{ start: 1, end: Infinity }],
        kind: "write",
      });
    }

    if (!isBashKind(event)) return;
    const cmd = (event.input as { command?: unknown }).command;
    // S4 fix 3: malformed bash input — a missing/non-string command never
    // reaches the analyzers (splitSegments would throw → fail-open wrap)
    if (typeof cmd !== "string" || cmd.trim() === "")
      return blockCall(
        "Permission Gate (Malformed): bash call has no command string — re-send the tool call with input.command.",
      );
    // P2 (2026-10-18): pibash-first. Built-in `bash` is blocked so the native
    // pipeline (same schema, full bash-kind rule set — H1/R10/destructive/
    // toolchain) runs; pibash itself falls back to the built-in executor when
    // its binary is missing, so no manual fallback is needed. Skipped when the
    // pibash extension is opted out (PI_NATIVE_BASH=0) — then `pibash` does not
    // exist and blocking `bash` would strand the agent.
    if (
      ruleEnabled("nativeBashFirst") &&
      event.toolName === "bash" &&
      process.env.PI_NATIVE_BASH !== "0"
    )
      return blockCall(
        "Token Economy (Pibash-first): use the pibash tool (pibash {command, timeout}) for shell work instead of bash — same schema and bash-kind gate rules; pibash falls back to the built-in executor itself.",
      );
    pendingBashFull.set(event.toolCallId, cmd);

    // Re-block (2026-10-08 extensions audit): the audit's one RETRY-SAME case
    // re-sent a blocked `git clone + git log` verbatim — twice — because the
    // second block just repeated the original reason, giving the model no
    // signal that the re-send itself was the mistake. Escalate instead.
    // 2026-10-08 B1 fix: an edit/write since the block invalidates the
    // re-send pattern the same way it legitimizes an R10 verify re-run —
    // command-shape rules still re-block on their own check if they apply.
    // Short window: the pattern is an immediate re-send; a different block
    // in between naturally re-arms the original rule.
    if (
      ruleEnabled("reblockEscalation") &&
      lastBlockedBash &&
      lastBlockedBash.cmd === cmd &&
      lastBlockedBash.mut === mutationSeq &&
      Date.now() - lastBlockedBash.ts < REBLOCK_WINDOW_MS
    ) {
      return blockCall(
        `Token Economy (Re-block): this exact command was blocked ${Math.round((Date.now() - lastBlockedBash.ts) / 1000)}s ago ` +
          `(${lastBlockedBash.family}) — that reason still applies. Change the command per it; a verbatim re-send only gets blocked again.`,
      );
    }

    // split into segments; each checked independently (quote-aware — a quoted
    // ';' is part of the command, not a separator). normalizeSegment strips env
    // prefixes and git global flags once, here, and the SAME normalized
    // segments feed self-modify, R9 and destructive (2026-10-11:
    // destructive judged the raw segment, so `git -C . push` skipped
    // the confirm while R9 caught `git -C x commit`)
    const normSegs = splitSegments(cmd).map(normalizeSegment);

    for (const seg of normSegs) {
      // R9: commit message must follow the commitlint conventional pattern
      if (ruleEnabled("commitMessageLint") && /^git commit\b/.test(seg)) {
        const lint = validateCommitMessages(seg);
        if (lint) return blockCall(lint);
      }
    }

    // TC1/TC2/SS1/SS2/SS3/PB1/NM1 (2026-10-13 audit): toolchain pins + search
    // scope/rg-first/fd-first —
    // BEFORE H2 for the same reason as R9: never ask the confirm dialog for a
    // command a rule rejects anyway
    const isDarwin = process.platform === "darwin";
    for (const seg of normSegs) {
      const tc = toolchainCheck(seg, cmd, ctx?.cwd, {
        pnpm: ruleEnabled("toolchainPnpm"),
        node: ruleEnabled("toolchainNode"),
      });
      if (tc) return blockCall(tc);
      const sc = searchCheck(seg, isDarwin, {
        scope: ruleEnabled("searchScope"),
        portability: ruleEnabled("searchPortability"),
        midPipe: ruleEnabled("searchMidPipe"),
        findFirst: ruleEnabled("findFirst"),
        nodeModules: ruleEnabled("dependencyInternals"),
      });
      if (sc) return blockCall(sc);
    }

    // H2 (2026-10-08): destructive/mutating commands need explicit user
    // approval — AFTER lint and self-modify (never ask permission for a
    // command commitlint will reject anyway) and BEFORE R10. Approval order:
    // an affirmative in the invoking/latest user message (single ask — chat
    // approval was previously unwired: the dialog double-asked in UI mode and
    // headless was unwinnable), else the UI confirm dialog, else fail CLOSED,
    // teaching the model to ask in chat and wait (suite t08/t09: 6/6 without).
    // H2 (2026-10-08): destructive/mutating commands need explicit user
    // approval — AFTER lint and self-modify (never ask permission for a
    // command commitlint will reject anyway) and BEFORE R10. Approval order:
    // chat approval → remembered verbatim → UI confirm dialog → fail CLOSED.
    // S4 (2026-10-15): ladder extracted into confirmDestructive(), shared
    // with the write/edit protected-path confirm (fix 8); strict `=== true`
    // approval (fix 2) lives there.
    if (ruleEnabled("destructiveConfirm") && normSegs.some(segmentDestructive)) {
      const r = await confirmDestructive(
        cmd,
        `'${cmd.slice(0, 33)}' mutates files, deps, or history and`, // 33c clamp: reason stays ≤ the 220c diet cap for any cmd length
        ctx,
      );
      if (r) return blockCall(r);
    }

    // R10 (2026-10-06 audit; rekeyed 2026-10-07): identical re-run guard — the
    // SAME command (fd-merges like 2>&1 stripped, whitespace collapsed) re-run
    // with no intervening edit/write re-sends output already in context (gh run
    // list double-polls 31 s apart, identical vitest re-runs). Keyed on the full
    // command, not a pipe-truncated base — base keys collided every command
    // sharing a preamble (`nvm use` keyed four different test runs, `KEY=$(…)`
    // keyed different curls, heredoc `cat > f` truncated to base `cat`) and
    // taught token-level escapes (block-impact audit: compliance 0.06, mean net
    // −1.83; Hermes-agent #18076 converges on identical name+args keying).
    // Watchers and retries of failed runs are exempt; the run is recorded on
    // tool_result.
    const base = cmd
      .replace(/\b\d>&\d\b\s?/g, " ")
      .replace(/\s+/g, " ")
      .trim(); // \b: '2>&1' at command start strips too
    const watcher =
      /(^|\s)(watch|sleep)\b/.test(base) ||
      /(^|\s)tail\s+(-[a-zA-Z]*[fF])/.test(base) ||
      /--watch\b/.test(base);
    const prior = lastBashRun.get(base);
    if (
      ruleEnabled("rerunGuard") &&
      prior &&
      !prior.failed &&
      !watcher &&
      prior.mut === mutationSeq &&
      Date.now() - prior.ts < RERUN_WINDOW_MS
    ) {
      return blockCall(
        `Token Economy (Re-run): '${base.slice(0, 60)}' ran ${Math.round((Date.now() - prior.ts) / 1000)}s ago, no ` +
          `edit/write since — output already in context. Re-run only after a change. Poll: 'sleep N && cmd'. Batch independent calls in one turn.`,
      );
    }
    pendingBash.set(event.toolCallId, base);
    // R1c: remember which paths this command targeted, so a later wide read of
    // one counts as a located lookup rather than a guess.
    if (ruleEnabled("locateFirst")) recordSearchedPaths(normSegs, ctx?.cwd);
    return;
  });

  // H1 cap handler (2026-10-08) — registered BEFORE the bookkeeping handler
  // below so the pendingBash* maps still identify the call; handlers compose,
  // and this one's RETURN value overlays the truncated content onto what the
  // model sees while bookkeeping (R10 records, Re-block arming) still runs.
  on("tool_result", async (event) => {
    // AT1: a completed native-tool call is the adoption signal (blocked calls
    // never reach tool_result, and the gate's own blocks carry a family).
    if (ruleEnabled("adoptionTelemetry") && !event.isError) recordAdoption(event.toolName);
    if (
      !pendingBashFull.has(event.toolCallId) &&
      !pendingBash.has(event.toolCallId)
    )
      return;
    // 2026-10-11: failing commands are capped too (verified: pi's bash tool
    // sets isError on non-zero exit — test/tsc floods were the largest
    // error outputs and sailed through uncapped). Only the gate's own
    // synthesized block results pass through untouched.
    if (blockFamilyOf(event)) return;
    // 2026-10-22 native-pass-through: pibash's Rust Tier-1 engine already pruned
    // this result to the model-visible budget (2 KB / 40 lines) with
    // diagnostic-aware windows. Running the scrub + H1 cap on top would re-cut
    // the rescued error/stack lines. Detect the compression signal and pass it
    // through raw.
    if (isRustCompressed(event)) return;
    // 2026-10-13 output scrub (rtk-optimizer principles): ANSI strip +
    // test/build aggregation runs first, in place; the H1 cap below then
    // truncates/elides whatever is left. Failures/errors always survive.
    if (ruleEnabled("outputScrub")) scrubBashText(event.content ?? []);
    if (!ruleEnabled("outputCap")) return;
    return capBashOutput(event);
  });

  // H1b read cap (2026-10-21) — reads had no post-cap: pibash/bash get H1's
  // 40/2KB, but a piread/read window rode straight into context (audit: piread
  // median 1.6KB, p90 8.5KB, max 40KB). Registered as its own tool_result
  // handler so it applies to piread AND the built-in read uniformly, and
  // independent of the coverage bookkeeping below. Skipped for images and for
  // the gate's own synthesized blocks; non-blocking (overlay only).
  on("tool_result", async (event) => {
    if (!ruleEnabled("readOutputCap")) return;
    if (event.toolName !== "read" && event.toolName !== "piread") return;
    if (blockFamilyOf(event)) return;
    if (
      (event.content ?? []).some(
        (b) => (b as { type?: unknown })?.type === "image",
      )
    )
      return; // images are not text — the built-in already size-checks them
    return capReadOutput(event);
  });

  on("tool_result", async (event) => {
    const read = pendingReads.get(event.toolCallId);
    if (read !== undefined) {
      pendingReads.delete(event.toolCallId);
      if (event.isError || !read.path) return;
      const content: unknown[] = event.content ?? [];
      // image result: whole file in context — no continuation windows exist
      if (content.some((b) => (b as { type?: unknown })?.type === "image")) {
        coverage.set(read.path, {
          spans: [{ start: 1, end: Infinity }],
          kind: "read",
          stat: await snapshot(read.path),
        });
        return;
      }
      // certify the ACTUAL returned lines — requested offset/limit lie at
      // EOF edges and on 2000-line/50KB truncation
      const snap = await snapshot(read.path);
      const details = (
        event as {
          details?: {
            truncation?: { outputLines?: unknown; truncated?: unknown };
            compaction?: { strategy?: unknown; omittedChars?: unknown } | null;
          };
        }
      ).details;
      const trunc = details?.truncation;
      // Head-tail compaction kept only the head and tail of the body; the
      // elided middle never entered context, so it must stay uncertified. A
      // whole-file request used to certify 1..Infinity regardless, which made
      // the omitted middle unreadable for the rest of the session.
      const compaction = details?.compaction;
      const elided =
        !!compaction &&
        compaction.strategy !== "none" &&
        typeof compaction.omittedChars === "number" &&
        compaction.omittedChars > 0;
      const counted = countTextLines(content);
      const lines =
        typeof trunc?.outputLines === "number"
          ? trunc.outputLines
          : counted.lines;
      const truncated = trunc ? trunc.truncated === true : counted.truncated;
      if (lines > 0) {
        // an untruncated, uncompacted whole-file request certifies everything —
        // nothing exists past EOF, so any later window is already in context
        const wholeFile =
          read.win.start === 1 &&
          read.win.end === Infinity &&
          !truncated &&
          !elided;
        certify(
          coverage,
          read.path,
          wholeFile
            ? { start: 1, end: Infinity }
            : { start: read.win.start, end: read.win.start + lines - 1 },
          "read",
          snap,
        );
      }
      return;
    }
    const bashBlockedCmd = pendingBashFull.get(event.toolCallId);
    if (bashBlockedCmd !== undefined) {
      pendingBashFull.delete(event.toolCallId);
      // our synthesized block results carry isError + a family-prefixed
      // text; a real command failure ("bash: xyz: command not found") must
      // not arm the escalation — hence the prefix match, not isError alone
      const fam = blockFamilyOf(event);
      if (fam && fam !== "Permission Gate (Destructive)") {
        // 2026-10-11: the destructive family never arms Re-block — its
        // verbatim re-send must re-prompt (the user may now approve in
        // chat), not be told the old reason still stands
        const reblocked = fam.includes("(Re-block)");
        lastBlockedBash = {
          cmd: bashBlockedCmd,
          family: reblocked && lastBlockedBash ? lastBlockedBash.family : fam,
          ts: Date.now(),
          mut: mutationSeq,
        };
      }
    }
    const bashBase = pendingBash.get(event.toolCallId);
    if (bashBase !== undefined) {
      pendingBash.delete(event.toolCallId);
      lastBashRun.set(bashBase, {
        ts: Date.now(),
        mut: mutationSeq,
        failed: event.isError === true,
      });
      // H5/B20: a successful mutating bash command bumps mutationSeq like an
      // edit/write — failures and watchers never do (a failed pull changed
      // nothing). 2026-10-11: git -C . pull & co. normalize first; a successful
      // DESTRUCTIVE_BASH match counts too (item 7)
      if (
        !event.isError &&
        isMutatingCommand(String(event.input?.command ?? ""))
      )
        mutationSeq++;
      return;
    }
    const entry = pendingEdits.get(event.toolCallId);
    if (entry === undefined) return;
    pendingEdits.delete(event.toolCallId);
    if (!entry.path) return; // malformed pathless call — nothing to track
    if (event.isError) {
      // failed edit/write: content may have drifted — a re-read is legitimate
      coverage.delete(entry.path);
    } else {
      // R10: a successful edit/write mutates the tree — verify re-runs become legitimate
      mutationSeq++;
      // item 6 (2026-10-11): prior spans describe the exact pre-edit bytes.
      // Drop the path's coverage when any anchor was fuzzy (its line-shift
      // contribution is unknown) or the file drifted between certification
      // and this edit (external writer) — certifying against the fresh
      // post-edit stat used to re-validate those stale spans by accident.
      // Applies with AND without exact spans (a fuzzy-only call has none).
      const prior = coverage.get(entry.path);
      const drifted =
        entry.kind === "edit" &&
        prior !== undefined &&
        (entry.fuzzy === true ||
          prior.stat === undefined ||
          entry.preStat === undefined ||
          prior.stat.mtimeMs !== entry.preStat.mtimeMs ||
          prior.stat.size !== entry.preStat.size);
      if (drifted) coverage.delete(entry.path);
      // fuzzy-matched anchors carry no spans — nothing more to certify (errs allow);
      // snapshot AFTER our own edit so mtime reflects the post-edit content
      if (entry.spans) {
        const snap = await snapshot(entry.path);
        // B4/H9 (2026-10-08): every line below the first edited original line
        // shifted when line counts changed — stale coverage spans there
        // describe different content and must not block re-reads. Truncate
        // at the first edited line, then certify the fresh post-edit spans.
        const cur = coverage.get(entry.path);
        if (cur && entry.firstEditedLine !== undefined) {
          const kept = cur.spans.filter((s) => s.end < entry.firstEditedLine!);
          coverage.set(entry.path, { ...cur, spans: kept });
        }
        for (const s of entry.spans)
          certify(coverage, entry.path, s, entry.kind, snap);
      }
      // S5 M3 (2026-10-16): chain the post-op content hash — the next
      // edit/write on this path compares it to catch same-stat drift
      // (spec §5.3). Over-cap files store undefined → chain cleanly off.
      const cur = coverage.get(entry.path);
      if (cur) cur.hash = await hashFile(entry.path);
    }
  });

  // cadence nudge (2026-10-11): NON-blocking — appended once to the next real
  // tool_result when turns or context tokens cross the AGENTS.md Token
  // Economy thresholds; never rides a synthesized block result
  on("tool_result", async (event, ctx) => {
    if (cadenceFired) return;
    const usage = ctx?.getContextUsage?.();
    const overCtx =
      !!usage && usage.tokens !== null && usage.tokens >= CADENCE_CTX_TOKENS;
    if (!ruleEnabled("cadenceNudge")) return;
    if (turnsSeen < CADENCE_TURNS && !overCtx) return;
    if (blockFamilyOf(event)) return;
    cadenceFired = true;
    return {
      content: [
        ...(event.content ?? []),
        {
          type: "text",
          text: `Cadence: ~${CADENCE_TURNS} turns / high context this session — the prefix now dominates cost. Propose compaction or a fresh session (AGENTS.md Token Economy: past ~150K context or ~200 turns).`,
        },
      ],
    };
  });

  on("session_compact", async () => {
    // the compaction summary replaced earlier read/edit content — nothing
    // is in context anymore, so every re-read and re-run is legitimate again
    coverage.clear();
    // 2026-10-11: cadence too — compaction just shrank the prefix, and the
    // summary starts a fresh turn budget
    turnsSeen = 0;
    cadenceFired = false;
    pendingReads.clear();
    pendingEdits.clear();
    pendingBash.clear();
    lastBashRun.clear();
    pendingBashFull.clear();
    lastBlockedBash = undefined;
  });

  // R1 resume hydration (2026-10-07): a resumed/continued session replays its
  // prior branch into context — replay that branch's read/write tool entries
  // through the same certify() path so dup-read coverage survives a process
  // restart (2026-10-05 audit: 258 dup reads / ~3,089K across 95 sessions;
  // post-resume reads were the untracked slice). Source of truth is
  // ctx.sessionManager.getBranch() — pi's own in-context projection — so a
  // fresh session (empty branch) is a natural no-op; `--continue` (reason
  // "startup"), in-process switches ("resume"/"fork") and reloads all work
  // without file-format guessing. Edits are skipped (span derivation needs
  // anchor validation — skipping only loses savings, never adds a false
  // block); R10 is skipped (10-min window makes it moot). Truncation is
  // derived from the replayed text; stale entries are dropped lazily by the
  // stat-mismatch check at the next read attempt.
  on("session_start", async (event, ctx) => {
    void event;
    // in-process switches reuse this module — drop the previous session's
    // coverage/pending state so only the new session's branch is certified
    coverage.clear();
    pendingReads.clear();
    pendingEdits.clear();
    pendingBash.clear();
    lastBashRun.clear();
    pendingBashFull.clear();
    lastBlockedBash = undefined;
    turnsSeen = 0;
    cadenceFired = false;
    const raw = ctx.sessionManager.getBranch();
    if (raw.length === 0) return;
    // only the post-compaction slice is in context (same rule as the
    // session_compact handler and the handoff extension's branch walk)
    let compactIdx = -1;
    let firstKeptId: string | undefined;
    for (let i = raw.length - 1; i >= 0; i--) {
      const e = raw[i] as { type?: string; firstKeptEntryId?: string };
      if (e.type === "compaction") {
        compactIdx = i;
        firstKeptId = e.firstKeptEntryId;
        break;
      }
    }
    const keptIdx = firstKeptId
      ? raw.findIndex((e) => (e as { id?: string }).id === firstKeptId)
      : -1;
    const branch =
      compactIdx < 0
        ? raw
        : [
            ...(keptIdx >= 0 ? raw.slice(keptIdx, compactIdx) : []),
            ...raw.slice(compactIdx + 1),
          ];
    const pending = new Map<
      string,
      {
        path: string;
        win: LineSpan;
        write?: boolean;
        edited?: boolean;
        ts?: number;
      }
    >();
    for (const entry of branch) {
      if ((entry as { type?: string }).type !== "message") continue;
      // H6 (2026-10-08): entry ISO timestamp — hydration certifies only while
      // the file still predates the replayed read (mtime <= ts, 1s slack);
      // a file changed after that read certifies nothing (stale content)
      const entryTs =
        Date.parse(
          String((entry as { timestamp?: unknown }).timestamp ?? ""),
        ) || 0;
      const msg = (
        entry as { message?: { role?: string; content?: unknown[] } }
      ).message;
      if (!msg || !Array.isArray(msg.content)) continue;
      if (msg.role === "assistant") {
        for (const b of msg.content) {
          const call = b as {
            type?: string;
            id?: string;
            name?: string;
            arguments?: Record<string, unknown>;
          };
          if (call?.type !== "toolCall" || !call.id) continue;
          if (
            (call.name === "piread" ||
              call.name === "read" ||
              call.name === "write" ||
              call.name === "edit" ||
              call.name === "piedit") &&
            typeof call.arguments?.path === "string"
          ) {
            const path = normPath(call.arguments.path);
            if (!path) continue;
            if (call.name === "write") {
              pending.set(call.id, {
                path,
                win: { start: 1, end: Infinity },
                write: true,
                ts: entryTs,
              });
              continue;
            }
            // H6/B7 (2026-10-08): a replayed edit's anchors can't be re-validated
            // here — clear coverage for the path instead of certifying stale
            // spans (errs allow; the pre-edit content is not what's on disk)
            if (call.name === "edit" || call.name === "piedit") {
              pending.set(call.id, {
                path,
                win: { start: 1, end: Infinity },
                edited: true,
                ts: entryTs,
              });
              continue;
            }
            const start = Math.max(
              1,
              typeof call.arguments.offset === "number"
                ? call.arguments.offset
                : 1,
            );
            pending.set(call.id, {
              path,
              win: {
                start,
                end:
                  typeof call.arguments.limit === "number"
                    ? start + call.arguments.limit - 1
                    : Infinity,
              },
              ts: entryTs,
            });
          }
        }
      } else if (msg.role === "toolResult") {
        const res = msg as unknown as {
          isError?: boolean;
          content?: unknown[];
        };
        const id = (msg as unknown as { toolCallId?: string }).toolCallId;
        if (!id) continue;
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        if (res.isError || !(res.content ?? []).length) continue;
        if (p.edited) {
          coverage.delete(p.path); // B7: the replayed edit invalidated prior spans
          continue;
        }
        if (
          p.write ||
          (res.content ?? []).some(
            (b) => (b as { type?: string })?.type === "image",
          )
        ) {
          const snap = await snapshot(p.path);
          // H6: certify only when the file predates this replayed write/read
          if (!(snap && p.ts && snap.mtimeMs > p.ts + 1000))
            coverage.set(p.path, {
              spans: [{ start: 1, end: Infinity }],
              kind: p.write ? "write" : "read",
              stat: snap,
            });
          continue;
        }
        const snap = await snapshot(p.path);
        // 2026-10-11: reads get the freshness rule writes already had —
        // a file changed after the replayed read certifies nothing
        if (snap && p.ts && snap.mtimeMs > p.ts + 1000) continue;
        const counted = countTextLines(res.content ?? []);
        if (counted.lines <= 0) continue;
        const wholeFile =
          p.win.start === 1 && p.win.end === Infinity && !counted.truncated;
        certify(
          coverage,
          p.path,
          wholeFile
            ? { start: 1, end: Infinity }
            : { start: p.win.start, end: p.win.start + counted.lines - 1 },
          "read",
          snap,
        );
      }
    }
  });
}
