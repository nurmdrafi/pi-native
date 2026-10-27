/**
 * Permission gate — mechanical enforcement of AGENTS.md tool-call rules.
 * Blocks violations with a corrective reason before the tool runs, or caps
 * output after it; every block reason carries the fix.
 *
 * CURRENT rules (IDs are stable; family = block-reason prefix):
 * | ID  | Family / mechanism            | Enforces |
 * |-----|-------------------------------|----------|
 * | AG  | Anchor Guard                  | edit oldText: existence (exact+fuzzy), uniqueness, no intra-call overlap; snippet on a miss; 2nd+ miss per file per turn appends a loop-break hint |
 * | R1  | Token Economy (Re-read)       | no read whose window is fully covered by in-context spans (reads/edits/writes/@file injections); stat-mismatch invalidation |
 * | R1b | Token Economy (Big read)      | whole-file (no-limit) or >=500-line-window read of a >10KB file blocked with a targeted-window fix |
 * | R1c | Locate-first                  | a >=100-line window on a path no search command named this session is blocked — `rg` first, then read the hit's range |
 * | R1x | Token Economy (Re-read)       | partial-overlap re-read: >=50% of a read's rendered lines already in context — warn (default) notes on the tool_result, error blocks at call time (requested window + pending same-batch sibling); same stat-freshness as R1 |
 * | P1  | Token Economy (Piread-first)  | built-in read of a text file blocked — use the piread tool; images keep `read` (piread delegates them internally) |
 * | P2  | Token Economy (Pibash-first)  | built-in bash blocked — use the pibash tool (same schema, full bash-kind rules; pibash falls back itself) |
 * | H1  | output cap (non-blocking)     | bash output capped at 100 lines / 4KB UTF-8; oversized first line head+tail; tail spilled to $TMPDIR/pgate-spill; errors capped too |
 * | H1b | read cap (non-blocking)       | read/piread result over 300 lines / 8KB truncated to the head, full text spilled to $TMPDIR/pgate-spill with a pointer — reads had no post-cap before |
 * | H2  | Permission Gate (Destructive) | destructive commands need approval: chat yes / UI confirm; fail closed headless; re-send re-prompts |
 * | R9  | Commitlint                    | conventional-commit headers, subject case, body line length (incl. heredoc bodies), pre-hook |
 * | TC1 | Toolchain (pnpm)              | npm/npx/yarn in a pnpm repo (packageManager/pnpm-lock) — pnpm run/exec/dlx |
 * | TC2 | Toolchain (Node)              | node-family binary under an exact x.y.z Node pin (.nvmrc/engines) the interpreter misses — nvm use first |
 * | SS1 | Search (Scope)                | recursive grep with no path/glob scope — scope it or use rg |
 * | PB1 | Portability (grep -P)         | grep -P on darwin — rg / grep -E |
 * | R10 | Token Economy (Re-run)         | identical command re-run within 10 min without an edit/write/mutating-bash since is blocked |
 * | RB  | Token Economy (Re-block)      | verbatim re-send of a just-blocked command escalates (never armed for H2) |
 * | CN  | cadence nudge (non-blocking)  | tool_result note at ~200 user turns / ~150K context tokens (AGENTS.md Token Economy); resets on compaction |
 * | LG1 | loop guard                      | same-target churn: note at 4th landed same-path edit/write in a user turn, one-shot block of that path's next mutation at the 7th; 3 consecutive tool errors note once; resets per user turn + compaction |
 *
 * Destructive matching is a TRIPWIRE, not a boundary — see destructive.ts.
 * Change history lives in git log; this table lists what is CURRENTLY enforced.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { config, ruleBlocks, ruleEnabled, ruleSeverity } from "./config.ts";

/** Bash-kind predicate: `bash` plus the native `pibash` tool (2026-10-18
 * pibash adoption). Both share the bash schema and both must run the full
 * bash rule set — H1 output cap, R10 re-run guard, destructive analysis,
 * malformed-input check, and mutation tracking. `isToolCallEventType` has no
 * `pibash` overload (pi only types built-in names), so the native name is
 * checked alongside it; the input shape is the bash input shape. */
function isBashKind(event: { toolName: string }): boolean {
  return event.toolName === "bash" || event.toolName === "pibash";
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
import { blockFamilyOf, capBashOutput, capReadOutput, isRustCompressed } from "./bash-cap.ts";
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
  certify,
  countTextLines,
  coversAll,
  HASH_CAP_BYTES,
  hashFile,
  hashText,
  normPath,
  overlapLines,
  renderedSpansFromBlocks,
  shiftSpansForEdit,
  snapshot,
} from "./read-coverage.ts";
import type { CoverageEntry, LineSpan } from "./read-coverage.ts";
import { toolchainCheck } from "./toolchain.ts";
import { searchCheck, searchedPathsFrom } from "./search-guard.ts";

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
/** R1x overlap bar: fraction of a read's rendered lines already certified
 * that trips the note (warn) or block (error). 2026-10-26 session audit:
 * >=50% = 149 avoidable re-reads/wk across 33 sessions (vs 94 at 70%),
 * ~2.6K re-fetched lines — the ledgering slips (batch duplicate windows,
 * post-elision re-fetch of rendered runs) sit at 0.5-1.0; warn severity
 * carries a ~13%-of-reads note rate without gating anything. */
const R1X_OVERLAP = 0.5;
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
      regions?: { start: number; end: number; delta: number }[];
      delta?: number;
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
  /** LG1 (2026-10-26, week of session evidence): the observed grind is
   * same-target churn (task.md x9, index.ts x8 inside single user-turns),
   * NOT error streaks (none exceeded 3 all week). Note at the 4th landed
   * same-path mutation; the 7th arms a one-shot block of that path's next
   * mutation; 3 consecutive tool errors note once. Reset per user turn. */
  let lg1Mutations = new Map<string, number>();
  let lg1Noted = new Set<string>();
  let lg1Armed: string | undefined;
  let lg1ErrStreak = 0;
  let lg1ErrNoted = false;
  /** AG repeat-miss hint (2026-10-26 audit v2): anchor blocks are the
   * top LLM error class (94/wk) and cluster in churn turns (27% of all
   * blocks+errors). 2nd+ AG miss on one file in a turn appends a
   * loop-break hint to the block reason. Shares LG1's per-turn reset. */
  let agMisses = new Map<string, number>();
  const AG_MISS_HINT_AT = 2;
  function agMissHint(path: string): string {
    const n = (agMisses.get(path) ?? 0) + 1;
    agMisses.set(path, n);
    return n >= AG_MISS_HINT_AT
      ? ` [miss ${n} on this file this turn — piread the exact target lines, then resend once]`
      : "";
  }
  const LG1_NOTE_AT = 4;
  const LG1_ARM_AT = 7;
  function lg1Reset(): void {
    lg1Mutations.clear();
    lg1Noted.clear();
    lg1Armed = undefined;
    lg1ErrStreak = 0;
    lg1ErrNoted = false;
    agMisses.clear();
  }
  /** one-shot block of an armed path's next mutation — called from the
   * edit/write tool_call paths after malformed-input validation */
  function lg1GateMutation(path: string): string | undefined {
    if (!ruleEnabled("loopGuard") || lg1Armed !== path) return undefined;
    const n = lg1Mutations.get(path) ?? LG1_ARM_AT;
    lg1Armed = undefined;
    return `Loop Guard (LG1): ${path} was edited ${n} times this turn — possible loop. Stop: summarize what you tried and what remains, then ask the user before continuing.`;
  }
  /** landed-mutation counter; the note text rides the landing result */
  function lg1RecordMutation(path: string): string | undefined {
    if (!ruleEnabled("loopGuard")) return undefined;
    const n = (lg1Mutations.get(path) ?? 0) + 1;
    lg1Mutations.set(path, n);
    if (n === LG1_ARM_AT) {
      lg1Armed = path;
      return `Loop Guard (LG1): ${path} edited ${n} times this turn — if you are circling, state what is left to finish or ask the user.`;
    }
    if (n === LG1_NOTE_AT && !lg1Noted.has(path)) {
      lg1Noted.add(path);
      return `Loop Guard (LG1): ${path} edited ${n} times this turn — if you are circling, state what is left to finish or ask the user.`;
    }
    return undefined;
  }
  /** consecutive tool errors (bash + edit/write): note once at 3, never blocks */
  function lg1RecordResult(isError: boolean): string | undefined {
    if (!ruleEnabled("loopGuard")) return undefined;
    if (!isError) {
      lg1ErrStreak = 0;
      return undefined;
    }
    lg1ErrStreak++;
    if (lg1ErrStreak === 3 && !lg1ErrNoted) {
      lg1ErrNoted = true;
      return "Loop Guard (LG1): 3 consecutive tool errors — if the same fix keeps failing, stop and ask the user instead of retrying.";
    }
    return undefined;
  }
  /** R10: bumped on every successful edit/write — a mutation makes verify re-runs legitimate */
  let mutationSeq = 0;
  /** H2: last user-approved destructive command (verbatim) + when */
  let lastApprovedDestructive: { cmd: string; ts: number } | undefined;
  /** H2/chat (2026-10-11): the latest user message approved destructive work —
   * counts as approval for the turn it arrived in (single ask; see APPROVAL_RE) */
  let promptApproves = false;

  /**
   * A block returns the reason to the model; nothing is persisted. Session
   * transcripts already record every call and result, so a second on-disk
   * store of the same events was duplicate weight.
   */
  const blockCall = (reason: string): { block: true; reason: string } => ({
    block: true,
    reason,
  });
  /** `warn` severity: proceed without blocking. */
  const warnCall = (_reason: string): undefined => undefined;
  /**
   * Apply a rule decision at its configured severity: `error` blocks, `warn`
   * returns undefined (call proceeds).
   */
  const enforce = (
    key: Parameters<typeof ruleSeverity>[0],
    reason: string,
  ): { block: true; reason: string } | undefined => (ruleBlocks(key) ? blockCall(reason) : warnCall(reason));
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
    // LG1: a new user turn is the loop boundary — churn/error counters reset
    lg1Reset();
  });

  on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("edit", event) || isToolCallEventType("piedit", event)) {
      // S4 fix 3: malformed edit input — explicit block, never an analyzer throw
      if (typeof event.input.path !== "string" || !event.input.path.trim())
        return blockCall(
          "Permission Gate (Malformed): edit call has no path string — re-send the tool call with input.path.",
        );
      const path = normPath(event.input.path, ctx?.cwd);
      const lg1Block = lg1GateMutation(path);
      if (lg1Block) return blockCall(lg1Block);
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
        ? await validateEditAnchors(
            event.input,
            ctx?.cwd,
            coverage.get(path),
            ruleEnabled("editRegionGuard"),
          )
        : undefined;
      if (checked && "block" in checked) {
        // S5 M3: the hash disproved the certified spans/stat — drop them, or
        // R1 would block the corrective re-read as a dup-read (deadlock)
        if (checked.stale) coverage.delete(path);
        return blockCall(checked.reason + agMissHint(path));
      }
      pendingEdits.set(event.toolCallId, {
        path,
        spans: checked?.spans,
        firstEditedLine: checked?.firstEditedLine,
        regions: checked?.regions,
        delta: checked?.delta,
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
        ruleEnabled("locateFirst") ||
        ruleEnabled("reReadConsume")) &&
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
      // R1b (2026-10-10 audit; demoted 2026-10-21): a whole read of a large
      // file is a real context cost, but the gate cannot see whether the whole
      // file IS the target (reviewing a module, reading a config end to end).
      // Blocking there traded a certain retry for a speculative saving, so the
      // cost is now recorded and the read proceeds. R1 still blocks genuine
      // duplicate reads, which is the part that is never intentional.
      if (
        ruleEnabled("largeReadGuard") &&
        (win.end === Infinity || win.end - win.start >= BIG_READ_WIN)
      ) {
        const snap = await snapshot(path);
        if (snap && snap.size > BIG_READ_BYTES) {
          const r = enforce(
            "largeReadGuard",
            `Token Economy (Big read): '${shown}' is ~${Math.round(snap.size / 1024)}KB — target it with the piread tool (rg the symbol, then piread {path, offset, limit} ≤${BIG_READ_WIN} lines).`,
          );
          if (r) return r;
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
      // R1x error tier (2026-10-26 revival): block a read whose REQUESTED
      // window re-fetches >=50% certified lines. At the shipped warn severity
      // this never blocks — the note rides the read's tool_result instead
      // (handler below). pendingReads catches the same-batch batch-slip: a
      // sibling read of the same path fired before any result certified it.
      if (ruleBlocks("reReadConsume") && path && win.end !== Infinity) {
        const cov = coverage.get(path);
        let covLines = 0;
        if (cov) {
          const now = await snapshot(path);
          if (
            now &&
            cov.stat &&
            (now.mtimeMs !== cov.stat.mtimeMs || now.size !== cov.stat.size)
          ) {
            coverage.delete(path); // stale stat — the re-read is legitimate
          } else {
            covLines = overlapLines(cov.spans, win);
          }
        }
        let pendLines = 0;
        for (const pr of pendingReads.values())
          if (pr.path === path)
            pendLines = Math.max(pendLines, overlapLines([pr.win], win));
        const frac =
          Math.max(covLines, pendLines) / (win.end - win.start + 1);
        if (frac >= R1X_OVERLAP)
          return blockCall(
            `Token Economy (Re-read): ~${Math.round(frac * 100)}% of lines ${win.start}–${win.end} of '${shown}' are already in context — shift the window to unread lines or act on what is there.`,
          );
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
      const lg1Block = lg1GateMutation(path);
      if (lg1Block) return blockCall(lg1Block);
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
          ) {
            // Drop the disproven spans BEFORE blocking: the file changed under
            // us (our own sed/pibash write, or an external edit), so the
            // certified window no longer describes this file. Keeping it would
            // re-block the edit even after the recommended re-read, turning a
            // one-shot recovery into a loop.
            coverage.delete(path);
            return blockCall(
              `Anchor Guard (Stale): '${shown}' changed on disk since your last read (your own shell write or an external edit) — re-read it, then re-send.`,
            );
          }
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

    // TC1/TC2/SS1/SS2/SS3/PB1 (2026-10-13 audit; demoted 2026-10-21): toolchain
    // pins + search hygiene encode a PREFERENCE, not a safety property — a
    // pnpm reponame or an `rg` vs `grep` choice cannot be judged by the gate from
    // a command string alone, and a block there costs a whole retry for a
    // convention the caller may have already considered, then let the
    // command run.
    const isDarwin = process.platform === "darwin";
    for (const seg of normSegs) {
      const tc = toolchainCheck(seg, cmd, ctx?.cwd, {
        pnpm: ruleEnabled("toolchainPnpm"),
        node: ruleEnabled("toolchainNode"),
      });
      if (tc) {
        const r = enforce(tc.startsWith("Toolchain (pnpm)") ? "toolchainPnpm" : "toolchainNode", tc);
        if (r) return r;
      }
      const sc = searchCheck(seg, isDarwin, {
        scope: ruleEnabled("searchScope"),
        portability: ruleEnabled("searchPortability"),
        midPipe: ruleEnabled("searchMidPipe"),
        findFirst: ruleEnabled("findFirst"),
      });
      if (sc) {
        const key = sc.startsWith("Search (Scope)")
          ? "searchScope"
          : sc.startsWith("Search (Mid-pipe)")
            ? "searchMidPipe"
            : sc.startsWith("Search (fd-first)")
              ? "findFirst"
              : "searchPortability";
        const r = enforce(key, sc);
        if (r) return r;
      }
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
      // R10 (demoted 2026-10-21): an unchanged re-run usually duplicates output,
      // but "usually" is not "always" — the mutation window misses changes made
      // by a subagent, another tool, or a watcher the gate does not track.
      // Record it and let it run; R1 catches the actual duplicate output.
      const r = enforce(
        "rerunGuard",
        `Token Economy (Re-run): '${base.slice(0, 60)}' ran ${Math.round((Date.now() - prior.ts) / 1000)}s ago, no ` +
          `edit/write since — output already in context. Re-run only after a change. Poll: 'sleep N && cmd'. Batch independent calls in one turn.`,
      );
      if (r) return r;
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
    // Blocked calls never reach tool_result; completed ones do and get
    // capped below. The gate's own synthesized block results are the
    // only tool_results that pass through untouched.
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
      // R1x: capture the pre-read coverage — the overlap note must measure
      // against what was in context BEFORE this read's own certification.
      const r1xPrior = coverage.get(read.path);
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
        if (wholeFile) {
          certify(coverage, read.path, { start: 1, end: Infinity }, "read", snap);
        } else {
          // §9 (2026-10-25): under head-tail compaction only the rendered
          // head/tail runs entered context — the omitted middle stays
          // uncertified, so it remains readable. Runs only when the result
          // reports compaction; every other read keeps the window math.
          const spans = elided
            ? renderedSpansFromBlocks(content, read.win.start)
            : undefined;
          if (spans && spans.length > 0) {
            for (const s of spans) certify(coverage, read.path, s, "read", snap);
          } else {
            certify(
              coverage,
              read.path,
              { start: read.win.start, end: read.win.start + lines - 1 },
              "read",
              snap,
            );
          }
        }
      }
      // R1x warn tier (2026-10-26): >=50% of this read's RENDERED lines were
      // already certified (stat-fresh) — append a note to the result; warn
      // never blocks. R1 (full coverage) blocks at call time; this catches
      // the partial ledgering slips (batch duplicate windows, post-elision
      // re-fetch of rendered runs) the 2026-10-26 session audit quantified.
      if (
        ruleEnabled("reReadConsume") &&
        lines > 0 &&
        r1xPrior?.stat &&
        snap &&
        r1xPrior.stat.mtimeMs === snap.mtimeMs &&
        r1xPrior.stat.size === snap.size
      ) {
        const runs =
          (elided
            ? renderedSpansFromBlocks(content, read.win.start)
            : undefined) ??
          [{ start: read.win.start, end: read.win.start + lines - 1 }];
        const num = runs.reduce(
          (a, s) => a + overlapLines(r1xPrior.spans, s),
          0,
        );
        const frac = lines > 0 ? num / lines : 0;
        if (num > 0 && frac >= R1X_OVERLAP) {
          const shown =
            read.path.length > 57 ? `…${read.path.slice(-56)}` : read.path;
          return {
            content: [
              ...(event.content ?? []),
              {
                type: "text",
                text: `Token Economy (Re-read): ${Math.round(frac * 100)}% of the ${lines} lines just read from '${shown}' were already in context (${r1xPrior.kind}, file unchanged) — act on them or aim the next window at unread lines.`,
              },
            ],
          };
        }
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
      const lg1ErrNote = lg1RecordResult(event.isError === true);
      if (lg1ErrNote)
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: lg1ErrNote },
          ],
        };
      return;
    }
    const entry = pendingEdits.get(event.toolCallId);
    if (entry === undefined) return;
    pendingEdits.delete(event.toolCallId);
    if (!entry.path) return; // malformed pathless call — nothing to track
    let lg1Note: string | undefined;
    if (event.isError) {
      // failed edit/write: content may have drifted — a re-read is legitimate
      coverage.delete(entry.path);
      lg1Note = lg1RecordResult(true);
    } else {
      // R10: a successful edit/write mutates the tree — verify re-runs become legitimate
      mutationSeq++;
      // LG1: count the landed mutation; may arm the one-shot loop block
      lg1Note = lg1RecordMutation(entry.path);
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
          entry.preStat === undefined ||
          (prior.stat !== undefined &&
            (prior.stat.mtimeMs !== entry.preStat.mtimeMs ||
              prior.stat.size !== entry.preStat.size)));
      if (drifted) coverage.delete(entry.path);
      // fuzzy-matched anchors carry no spans — nothing more to certify (errs allow);
      // snapshot AFTER our own edit so mtime reflects the post-edit content
      if (entry.spans) {
        const snap = await snapshot(entry.path);
        // B4/H9 (2026-10-08): lines below the first edited original line
        // shifted when line counts changed. Shift certified spans by the
        // edit's line delta (2026-10-18: replaces truncation — truncation
        // decertified valid spans and forced a re-read before every
        // follow-up edit), then certify the fresh post-edit spans.
        const cur = coverage.get(entry.path);
        if (cur && entry.firstEditedLine !== undefined) {
          coverage.set(entry.path, {
            ...cur,
            spans: shiftSpansForEdit(
              cur.spans,
              entry.firstEditedLine,
              entry.delta ?? 0,
              entry.regions,
            ),
          });
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
    if (lg1Note)
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: lg1Note },
        ],
      };
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
    // LG1: compaction starts a fresh turn budget like cadence
    lg1Reset();
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
