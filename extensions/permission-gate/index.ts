/**
 * Permission gate — mechanical enforcement of AGENTS.md tool-call rules.
 * Blocks violations with a corrective reason before the tool runs, or caps
 * output after it; every block reason carries the fix.
 *
 * CURRENT rules (IDs are stable; family = block-reason prefix):
 * | ID  | Family / mechanism            | Enforces |
 * |-----|-------------------------------|----------|
 * | AG  | Anchor Guard                  | edit oldText: existence (exact+fuzzy), uniqueness, no intra-call overlap; anchor lines must be in context — a line this session's own search PRINTED certifies like a read span (2026-10-27), a path-only result (`rg -l`, `wc -l`) certifies nothing; snippet on a miss; 2nd+ miss per file per turn appends a loop-break hint; a target inside a compaction gap (piread details.compaction.omissions[], else marker walk) names the sanctioned sub-window remedy read (C2/C3 2026-10-27); Stale bind (stat or hash drift since the certified read) with every anchor exact in the CURRENT file passes with a Stale-relaxed note (M2 skipped, coverage dropped; miss/fuzzy/duplicate reverts to the Stale warn) (2026-10-29) |
 * | R1  | Token Economy (Re-read)       | no read whose window is fully covered by in-context spans (reads/edits/writes/@file injections); stat-mismatch invalidation; single-file view commands in bash results credit their printed H1-visible lines (VC, 2026-10-29) |
 * | R1b | Token Economy (Big read)      | whole-file (no-limit) or >=500-line-window read of a >10KB file blocked with a targeted-window fix |
 * | R1c | Locate-first                  | a >=100-line window on a path no search named this session — as an argv operand or a line its output printed (`path:line:`, bare `NN:` for a single-file search, `wc -l` count rows) — is blocked unless the window covers a reported hit line; the block lists those hit lines and the piread call that covers them |
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
 * | R11 | Loop Guard (Failure loop)     | >=5 consecutive tool failures with no landed mutation since the streak began: the next shell call is blocked (a red-green cycle edits between runs, so it never arms) |
 * | PH1 | Phase label (Advisory)        | labels the turn's stage and notes once per turn when a verify-family command fails right after an edit; never blocks, and never displaces H1's cap |
 * | RB  | Token Economy (Re-block)      | verbatim re-send of a just-blocked command escalates (never armed for H2) |
 * | CN  | cadence nudge (non-blocking)  | tool_result note at ~120 user turns / ~150K context tokens (AGENTS.md Token Economy); resets on compaction |
 * | LG1 | loop guard                      | same-target churn: note at 4th landed same-path edit/write in a user turn, one-shot block of that path's next mutation at the 7th; 3 consecutive tool errors note once; resets per user turn + compaction |
 *
 * Destructive matching is a TRIPWIRE, not a boundary — see destructive.ts.
 * Change history lives in git log; this table lists what is CURRENTLY enforced.
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { config, ruleBlocks, ruleEnabled, ruleSeverity } from "./loader.ts";

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
  statSync,
} from "fs";
import { readFile, lstat } from "fs/promises";
import { basename, dirname, join } from "path";

import { toLF, validateEditAnchors } from "./rules/anchor-guard.ts";
import { blockFamilyOf, capBashOutput, capReadOutput, isRustCompressed, visibleLineCount } from "./rules/bash-cap.ts";
import { scrubBashText } from "./rules/output-scrub.ts";
import {
  APPROVED_WINDOW_MS,
  APPROVAL_RE,
  PROTECTED_PREFIX_RE,
  isMutatingCommand,
  normalizeSegment,
  segmentDestructive,
  splitSegments,
} from "./rules/destructive.ts";
import { validateCommitMessages } from "./rules/commitlint.ts";
import {
  certify,
  countFileLines,
  countTextLines,
  coversAll,
  HASH_CAP_BYTES,
  hashFile,
  hashText,
  normPath,
  overlapLines,
  renderedCoverageFromBlocks,
  renderedSpansFromBlocks,
  recordGaps,
  shiftSpansForEdit,
  snapshot,
  viewCommandOf,
} from "./rules/read-coverage.ts";
import type {
  CompactionOmission,
  CoverageEntry,
  LineSpan,
  ViewCommand,
} from "./rules/read-coverage.ts";
import { toolchainCheck } from "./rules/toolchain.ts";
import { isVerifyCommand } from "./rules/phase.ts";
import {
  FAILURE_LOOP_AT,
  createTurnState,
  lg1GateMutation,
  lg1RecordMutation,
  lg1RecordResult,
  phaseRecord,
  resetTurnParts,
} from "./rules/turn-state.ts";
import {
  effectiveCwd,
  enumeratesPaths,
  hitAnchorsWindow,
  hitLinesLabel,
  hitWindowHint,
  isSearchSegment,
  searchCheck,
  swallowCheck,
  readerBypassCheck,
  searchHitsFrom,
  searchedPathsFrom,
} from "./rules/search-guard.ts";

// ---- R1b + cadence thresholds (see index header table: R1b, CN) ----
/** big-read gate: a whole-file-ish request for a file larger than this is
 * blocked with a targeted-window reason (44KB/51KB whole-file reads rode two
 * sessions' prefixes; the read tool's own 2000-line/50KB truncation is too
 * generous to be the only brake). 2026-10-18: floor lowered 24KB→10KB —
 * piread compacts any read past its 2KB model budget, so a ~14KB whole read
 * came back with 11.5KB elided and still counted as "read" (2026-10-18
 * whole-read session). The gate must fire before compaction does. */
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
 * user turns (~120) or estimated context tokens (~150K) before proposing a
 * compaction/fresh-session hop (2026-10-10: 354/303-turn marathons re-billed
 * ~100M cacheRead each with zero compactions; 2026-10-29 pidx audit: the
 * 281/177-turn permission-gate sessions paid 85–94% of spend in cacheRead —
 * rounds × prefix turns quadratic, and it is sunk well before 200). The
 * nudge is NON-blocking (2026-10-11): appended to the next tool_result —
 * the blocking variant cost a re-issue turn and the model could not act on
 * it mid-call anyway. */
const CADENCE_TURNS = 120;
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
  /** R1c/C4: bash toolCallId -> the cwd its search hits resolve against;
   * set only for search/enumeration commands. `singleFile` marks a search that
   * named exactly one regular file, whose output therefore carries no path
   * prefix. */
  const pendingSearchCalls = new Map<
    string,
    { cwd: string | undefined; singleFile?: string }
  >();
  /** R1c/C4: files a search's OUTPUT named, -> the hit lines it reported
   * (empty set = path-only result, e.g. `rg -l` — any window). */
  const searchHits = new Map<string, Set<number>>();
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
  // 2026-10-08 extensions audit (Re-block): pendingBash is only set AFTER all
  // checks pass, so blocked calls leave no tool_result-side trace — keep the
  // verbatim cmd keyed by toolCallId to recognize our own synthesized block
  // results. One lastBlockedBash slot: only the immediately preceding blocked
  // bash call can be "re-sent verbatim".
  const pendingBashFull = new Map<string, string>();
  /** View-command credit (bashViewCredit): bash toolCallId -> parsed
   * single-file view (head/tail/sed -n/cat), awaiting its tool_result */
  const pendingViews = new Map<string, ViewCommand>();

  /** Turn state for the temporal rules (R10/EB/LG1/R11/PH1/CN) — one value,
   * threaded into rules/turn-state.ts, which documents each field. LG1's
   * per-turn counters exist because the observed grind is same-target churn
   * (task.md x9, index.ts x8 inside single user-turns), not error streaks.
   * The AG miss ledger keeps its own map below but shares the turn reset. */
  const turn = createTurnState();
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
  /** Per-turn reset; the AG miss ledger shares the turn boundary. */
  function lg1Reset(): void {
    resetTurnParts(turn);
    agMisses.clear();
  }
  /** PH1 helper: true when a bash result is already at H1's model-visible budget,
   * where the cap (not a phase note) must survive the handler composition. */
  function oversizedBashResult(event: { content?: unknown }): boolean {
    const text = (event.content as { text?: unknown }[] | undefined ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
    return text.split("\n").length > 40 || Buffer.byteLength(text, "utf8") > 2_048;
  }

  /** R11: block the next shell call when the streak says the agent is circling —
   * repeated failures with nothing landed in between. */
  function failureLoopGate(): { block: true; reason: string } | undefined {
    if (!ruleEnabled("failureLoopGuard")) return undefined;
    if (turn.lg1ErrStreak < FAILURE_LOOP_AT) return undefined;
    if (turn.mutationSeq !== turn.lg1ErrMutSeq) return undefined;
    return enforce(
      "failureLoopGuard",
      `Loop Guard (R11): ${turn.lg1ErrStreak} consecutive tool failures with no landed change — stop retrying. Say what the failure reports and what you changed, then ask the user before continuing.`,
    );
  }

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
  /** `warn` severity: proceed without blocking; the reason rides the tool
   * result as a note (pendingWarns) so warn rules teach instead of
   * silently passing (fixes the taught-but-discarded desync, 2026-10-28). */
  const pendingWarns = new Map<string, string[]>();
  const warnCall = (reason: string, id?: string): undefined => {
    if (id) {
      const a = pendingWarns.get(id) ?? [];
      a.push(reason);
      pendingWarns.set(id, a);
    }
    return undefined;
  };
  /**
   * Apply a rule decision at its configured severity: `error` blocks, `warn`
   * records the reason against the call id (when given) and proceeds.
   */
  const enforce = (
    key: Parameters<typeof ruleSeverity>[0],
    reason: string,
    id?: string,
  ): { block: true; reason: string } | undefined => (ruleBlocks(key) ? blockCall(reason) : warnCall(reason, id));
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
    turn.turnsSeen++;
    const prompt = event.messageType === "user" ? event.prompt : "";
    promptApproves = APPROVAL_RE.test(prompt);
    // LG1: a new user turn is the loop boundary — churn/error counters reset
    lg1Reset();
    // PH1: a new user turn re-arms the phase label
    turn.turnPhase = "idle";
    turn.phaseNoted = false;
  });

  on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("edit", event) || isToolCallEventType("piedit", event)) {
      // S4 fix 3: malformed edit input — explicit block, never an analyzer throw
      if (typeof event.input.path !== "string" || !event.input.path.trim())
        return blockCall(
          "Permission Gate (Malformed): edit call has no path string — re-send the tool call with input.path.",
        );
      const path = normPath(event.input.path, ctx?.cwd);
      const lg1Block = lg1GateMutation(turn, path);
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
            searchHits.get(path),
          )
        : undefined;
      if (checked && "block" in checked) {
        // S5 M3: the hash disproved the certified spans/stat — drop them, or
        // R1 would block the corrective re-read as a dup-read (deadlock)
        if (checked.stale) coverage.delete(path);
        // AG blocks; AG2 is relaxable, so its configured severity decides
        // (2026-10-27: "anchor outside the read window" was 42% of all anchor
        // blocks in live sessions, and the exact-match check still stands).
        const decision = enforce(
          checked.rule ?? "editAnchorGuard",
          checked.reason + agMissHint(path),
          event.toolCallId,
        );
        if (decision) return decision;
      }
      // a relaxed (warn) AG2 block carries no certified spans to register
      const validated = checked && !("block" in checked) ? checked : undefined;
      // Relaxation A (2026-10-29): a Stale bind whose every anchor matched
      // the CURRENT file exactly passes with a note instead of the Stale
      // warn — the exact match is the binding evidence, the note carries
      // the drift risk. The old coverage still drops (its other spans
      // describe disproven bytes); the edit's own spans re-certify fresh
      // at tool_result.
      if (validated?.staleNote) {
        warnCall(validated.staleNote, event.toolCallId);
        coverage.delete(path);
      }
      pendingEdits.set(event.toolCallId, {
        path,
        spans: validated?.spans,
        firstEditedLine: validated?.firstEditedLine,
        regions: validated?.regions,
        delta: validated?.delta,
        preStat: validated?.preStat,
        fuzzy: validated?.fuzzy,
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
      // session is a guess about where the content sits. C4 (2026-10-26
      // session): "named" covers both argv operands and `path:line:` hits a
      // search PRINTED — and an output-named path is readable only across a
      // reported hit line, which is the rule text itself: read the hit's range.
      // Deliberately narrow: whole-file reads belong to R1b, and windows under
      // LOCATE_MIN_WIN are ordinary targeted reads that must stay frictionless.
      if (
        ruleEnabled("locateFirst") &&
        win.end !== Infinity &&
        win.end - win.start + 1 >= LOCATE_MIN_WIN &&
        path &&
        !searchedPaths.has(path) &&
        !hitAnchorsWindow(searchHits, path, win) &&
        !coverage.has(path)
      ) {
        const hits = searchHits.get(path);
        const hint = hits ? hitWindowHint(hits) : undefined;
        return blockCall(
          hint && hits
            ? `Locate-first: no hit in this ${win.end - win.start + 1}-line window (hits ${hitLinesLabel(hits)}) — piread {path:'${shown}', offset:${hint.offset}, limit:${hint.limit}}. Hits recorded; do not re-search.`
            : `Locate-first: '${shown}' was never named by a search this session — locate first (\`rg -n <term> ${shown.replace(/^.*\//, "")}\`), then piread the hit's line ±3.`,
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
      const lg1Block = lg1GateMutation(turn, path);
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
    // R11: circling — repeated failures with nothing landed since the streak began
    const r11 = failureLoopGate();
    if (r11) return r11;
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
      turn.lastBlockedBash &&
      turn.lastBlockedBash.cmd === cmd &&
      turn.lastBlockedBash.mut === turn.mutationSeq &&
      Date.now() - turn.lastBlockedBash.ts < REBLOCK_WINDOW_MS
    ) {
      return blockCall(
        `Token Economy (Re-block): this exact command was blocked ${Math.round((Date.now() - turn.lastBlockedBash.ts) / 1000)}s ago ` +
          `(${turn.lastBlockedBash.family}) — that reason still applies. Change the command per it; a verbatim re-send only gets blocked again.`,
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
        replaceFlag: ruleEnabled("searchReplaceFlag"),
      });
      if (sc) {
        const key = sc.startsWith("Search (Scope)")
          ? "searchScope"
          : sc.startsWith("Search (Mid-pipe)")
            ? "searchMidPipe"
            : sc.startsWith("Search (fd-first)")
              ? "findFirst"
              : sc.startsWith("Search (rg -r)")
                ? "searchReplaceFlag"
                : "searchPortability";
        const r = enforce(key, sc, event.toolCallId);
        if (r) return r;
      }
    }

    // SE1 (2026-10-28): `|| true` swallows failure exit codes — command-level
    // check (splitSegments splits on `||`, so no segment carries the shape).
    // Warn by default; the reason rides the tool result as a note.
    const sw = swallowCheck(cmd);
    if (sw) {
      const r = enforce("errorSwallow", sw, event.toolCallId);
      if (r) return r;
    }
    const rb = readerBypassCheck(cmd);
    if (rb) {
      const r = enforce("readerBypass", rb, event.toolCallId);
      if (r) return r;
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
    const prior = turn.lastBashRun.get(base);
    if (
      ruleEnabled("rerunGuard") &&
      prior &&
      !prior.failed &&
      !watcher &&
      prior.mut === turn.mutationSeq &&
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
    // View-command credit (2026-10-29): parse the call, credit at result —
    // a single-file view whose output maps 1:1 onto file lines. Regular
    // files only (a directory operand errors and prints nothing creditable).
    if (ruleEnabled("bashViewCredit")) {
      const view = viewCommandOf(cmd, ctx?.cwd, normPath, existsSync);
      if (view && statSync(view.path, { throwIfNoEntry: false })?.isFile())
        pendingViews.set(event.toolCallId, view);
    }
    // R1c: remember which paths this command targeted, so a later wide read of
    // one counts as a located lookup rather than a guess.
    if (ruleEnabled("locateFirst")) {
      recordSearchedPaths(normSegs, ctx?.cwd);
      // C4 (2026-10-26 session): argv operands never credit files a search
      // merely PRINTS — remember the effective cwd (session cwd advanced by
      // `cd <dir> &&` prefixes inside the command) so the tool_result
      // handler can resolve the relative `path:line:` forms rg prints.
      const search = normSegs.some(isSearchSegment);
      if (search || normSegs.some(enumeratesPaths)) {
        // enumeration rows (`wc -l`) name files too; a search whose output has
        // no path prefix (rg/awk/sed on ONE file) anchors by bare `NN:` lines.
        // The sole operand must be a regular file — `rg foo src/` names a
        // directory, and crediting bare lines to it would credit everything.
        const targets = search
          ? searchedPathsFrom(normSegs, ctx?.cwd, normPath, existsSync)
          : [];
        // 2026-10-28: a compound (`echo hdr; rg A <f>; echo hdr;
        // rg B <f>`) lists the SAME file once per search segment — without the
        // dedupe the length-2 list defeated singleFile and the bare NN: lines
        // rg printed certified nothing. Two searches of one file name one file.
        const sole = [...new Set(targets)];
        const soleFile =
          sole.length === 1 &&
          statSync(sole[0], { throwIfNoEntry: false })?.isFile() === true;
        pendingSearchCalls.set(event.toolCallId, {
          cwd: effectiveCwd(normSegs, ctx?.cwd, normPath),
          singleFile: soleFile ? sole[0] : undefined,
        });
      }
    }
    return;
  });

  // R1c/C4 hit seeding (2026-10-27 research/gate-locate-first-seed.md): on the
  // result of an rg-family command, credit the files its output names,
  // anchored to the hit lines it reported — the block message's own promise
  // ("a search has named") finally covers what searches print. Registered
  // BEFORE the H1 cap so parsing sees raw result text (scrub/cap mutate the
  // content in place); non-blocking by design. Fail-closed: only results whose
  // toolCall passed isSearchSegment are parsed (an `echo <path>` result never
  // seeds) and every candidate path must exist (searchHitsFrom).
  on("tool_result", async (event) => {
    const call = pendingSearchCalls.get(event.toolCallId);
    if (!call) return;
    pendingSearchCalls.delete(event.toolCallId);
    if (!ruleEnabled("locateFirst")) return;
    const text = (event.content ?? [])
      .map((b) => (b as { text?: unknown }).text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    for (const [p, lines] of searchHitsFrom(
      text,
      call.cwd,
      normPath,
      existsSync,
      call.singleFile,
    )) {
      const cur = searchHits.get(p);
      if (!cur) searchHits.set(p, lines);
      else for (const l of lines) cur.add(l);
    }
  });

  // View-command span credit (2026-10-29): the printed lines of a
  // single-file view (head/tail/sed -n N,Mp/cat) enter context like a read
  // window — certify them so a later edit anchored on them skips the forced
  // re-read (Claude Code parity). SE2 still prefers piread (structured
  // windows, no cap); the warn teaches the preference, this credits what
  // was actually seen. Registered before the H1 cap like the searchHits
  // handler; clamped to the H1-visible line budget so capped-off lines
  // never certify. Stat-only, like plain reads (spec §7 R2).
  on("tool_result", async (event) => {
    const view = pendingViews.get(event.toolCallId);
    if (!view) return;
    pendingViews.delete(event.toolCallId);
    if (event.isError) return;
    let text = (event.content ?? [])
      .map((b) => (b as { text?: unknown }).text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    const visible = visibleLineCount(text);
    if (visible <= 0) return;
    let start = view.from;
    if (view.last !== undefined) {
      // tail -n K: the printed lines are the file's LAST K — map through
      // the current line count (over-cap files skip the credit: mapping a
      // tail through a multi-MB read costs more than the re-read it saves)
      const total = await countFileLines(view.path);
      if (!total || total <= 0) return;
      start = Math.max(1, total - view.last + 1);
    }
    const end = Math.min(start + visible - 1, view.to);
    if (end < start) return;
    const snap = await snapshot(view.path);
    if (!snap) return;
    certify(coverage, view.path, { start, end }, "read", snap);
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
            compaction?: {
              strategy?: unknown;
              omittedChars?: unknown;
              omissions?: CompactionOmission[] | null;
            } | null;
          };
        }
      ).details;
      const trunc = details?.truncation;
      // Head-tail compaction kept only the head and tail of the body; the
      // elided middle never entered context, so it must stay uncertified. A
      // whole-file request used to certify 1..Infinity regardless, which made
      // the omitted middle unreadable for the rest of the session.
      const compaction = details?.compaction;
      const omissions = compaction?.omissions ?? undefined;
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
          const rendered = elided
            ? renderedCoverageFromBlocks(
                content,
                read.win.start,
                omissions,
                read.win.end,
              )
            : undefined;
          const spans = rendered?.spans;
          if (spans && spans.length > 0) {
            for (const s of spans) certify(coverage, read.path, s, "read", snap);
            recordGaps(coverage, read.path, rendered.gaps);
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
            ? renderedSpansFromBlocks(
                content,
                read.win.start,
                omissions,
                read.win.end,
              )
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
        turn.lastBlockedBash = {
          cmd: bashBlockedCmd,
          family: reblocked && turn.lastBlockedBash ? turn.lastBlockedBash.family : fam,
          ts: Date.now(),
          mut: turn.mutationSeq,
        };
      }
    }
    const bashBase = pendingBash.get(event.toolCallId);
    if (bashBase !== undefined) {
      pendingBash.delete(event.toolCallId);
      turn.lastBashRun.set(bashBase, {
        ts: Date.now(),
        mut: turn.mutationSeq,
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
        turn.mutationSeq++;
      const lg1ErrNote = lg1RecordResult(turn, event.isError === true);
      if (lg1ErrNote)
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: lg1ErrNote },
          ],
        };
      const phNote = phaseRecord(
        turn,
        isVerifyCommand(String(event.input?.command ?? "")) ? "verify" : "other",
        event.isError === true,
      );
      // H1 owns oversized results: returning content here would replace the cap
      // (later handlers win the composition), so the note is skipped when the
      // output is already at H1's 40-line / 2 KB budget.
      const warnList = pendingWarns.get(event.toolCallId) ?? [];
      pendingWarns.delete(event.toolCallId);
      const warnNote = warnList.join(" ");
      const notes = [phNote, warnNote].filter(Boolean).join(" ");
      if (notes && !oversizedBashResult(event))
        return {
          content: [...(event.content ?? []), { type: "text", text: notes }],
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
      lg1Note = lg1RecordResult(turn, true);
    } else {
      // R10: a successful edit/write mutates the tree — verify re-runs become legitimate
      turn.mutationSeq++;
      // LG1: count the landed mutation; may arm the one-shot loop block
      lg1Note = lg1RecordMutation(turn, entry.path);
      phaseRecord(turn, "edit", false);
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
            // pre-edit gap line numbers are stale after the shift; new
            // reads re-record fresh gaps (C3)
            gaps: undefined,
          });
        }
        // search-printed line numbers are pre-edit coordinates — shift them
        // by the edit's exact delta instead of dropping (2026-10-28: the
        // drop decertified lines the diff proves moved; the session watched
        // ~5 needless Unread blocks from it). Fuzzy/drifted edits deleted
        // coverage above and never reach here with spans.
        const hits = searchHits.get(entry.path);
        if (hits && hits.size > 0 && entry.firstEditedLine !== undefined) {
          const shiftedHits = shiftSpansForEdit(
            [...hits].map((n) => ({ start: n, end: n })),
            entry.firstEditedLine,
            entry.delta ?? 0,
            entry.regions,
          );
          searchHits.set(
            entry.path,
            new Set(shiftedHits.map((s) => s.start)),
          );
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
    // edit-path warn notes (AG family at warn since 2026-10-28): flush
    // pendingWarns exactly like the bash branch — a warn whose reason never
    // reaches the model is a silent pass, not a teaching layer.
    const warnNote = (pendingWarns.get(event.toolCallId) ?? []).join(" ");
    pendingWarns.delete(event.toolCallId);
    const notes = [lg1Note, warnNote].filter(Boolean).join(" ");
    if (notes)
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: notes },
        ],
      };
  });

  // cadence nudge (2026-10-11): NON-blocking — appended once to the next real
  // tool_result when turns or context tokens cross the AGENTS.md Token
  // Economy thresholds; never rides a synthesized block result
  on("tool_result", async (event, ctx) => {
    if (turn.cadenceFired) return;
    const usage = ctx?.getContextUsage?.();
    const overCtx =
      !!usage && usage.tokens !== null && usage.tokens >= CADENCE_CTX_TOKENS;
    if (!ruleEnabled("cadenceNudge")) return;
    if (turn.turnsSeen < CADENCE_TURNS && !overCtx) return;
    if (blockFamilyOf(event)) return;
    turn.cadenceFired = true;
    return {
      content: [
        ...(event.content ?? []),
        {
          type: "text",
          text: `Cadence: ~${CADENCE_TURNS} turns / high context this session — the prefix now dominates cost. Propose compaction or a fresh session (AGENTS.md Token Economy: past ~150K context or ~${CADENCE_TURNS} turns).`,
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
    turn.turnsSeen = 0;
    turn.cadenceFired = false;
    // LG1: compaction starts a fresh turn budget like cadence
    lg1Reset();
    pendingReads.clear();
    pendingEdits.clear();
    pendingBash.clear();
    turn.lastBashRun.clear();
    pendingBashFull.clear();
    turn.lastBlockedBash = undefined;
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
    turn.lastBashRun.clear();
    pendingBashFull.clear();
    pendingSearchCalls.clear();
    searchHits.clear();
    turn.lastBlockedBash = undefined;
    turn.turnsSeen = 0;
    turn.cadenceFired = false;
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
