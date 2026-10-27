/**
 * Turn state for the temporal rules that share a turn boundary: R10 (re-run),
 * EB (re-block), LG1 (loop guard), R11 (failure loop), PH1 (phase label), and
 * CN (cadence nudge).
 *
 * Extracted from `index.ts` (2026-10-28): these rules were closures over one
 * `let`/`Map` binding each, spread across ~120 lines of the extension factory,
 * so adding a rule meant adding another binding plus another helper that could
 * only be read against the enclosing scope. The state is now a single value and
 * every transition is a function of it — a rule reads what it needs from the
 * argument. `mutationSeq` is the shared clock: R10, EB and R11 all ask whether
 * something landed, so one counter answers all three and they cannot disagree.
 */
import { ruleEnabled } from "../config.ts";
import { type ActionKind, type Phase, nextPhase } from "./phase.ts";

/** LG1: note at the 4th landed same-path mutation, arm the one-shot block at the 7th. */
const LG1_NOTE_AT = 4;
const LG1_ARM_AT = 7;

/** R11: consecutive tool failures, with no landed mutation since the streak began,
 * before escalation. 5 sits above any healthy red-green cycle; the mutation
 * snapshot (not the raw count) is what keeps TDD from tripping it. */
export const FAILURE_LOOP_AT = 5;

export interface BashRun {
  ts: number;
  mut: number;
  failed: boolean;
}

export interface BlockedBash {
  cmd: string;
  family: string;
  ts: number;
  mut: number;
}

export interface TurnState {
  /** Landed mutations this session (edit, write, mutating bash). Monotonic:
   * R10/EB/R11 compare against it, so it must survive a per-turn reset. */
  mutationSeq: number;
  /** R10: base command -> last-run record; a re-run is compared against it. */
  lastBashRun: Map<string, BashRun>;
  /** EB: one slot — only the immediately preceding blocked bash call can be
   * "re-sent verbatim". */
  lastBlockedBash: BlockedBash | undefined;
  /** CN: user turns seen; reset on compaction and session start. */
  turnsSeen: number;
  cadenceFired: boolean;
  /** LG1: landed same-path mutations this turn, and the paths already noted. */
  lg1Mutations: Map<string, number>;
  lg1Noted: Set<string>;
  /** LG1: path whose next mutation is blocked once. */
  lg1Armed: string | undefined;
  /** LG1/R11: consecutive tool errors. The counter runs even when loopGuard is
   * off so failureLoopGuard can be enabled on its own. */
  lg1ErrStreak: number;
  lg1ErrNoted: boolean;
  /** R11: mutationSeq when the current streak began — a landed mutation since
   * then disarms the escalation (a red-green cycle is not a loop). */
  lg1ErrMutSeq: number;
  /** PH1: the turn's stage label and its one-note latch. */
  turnPhase: Phase;
  phaseNoted: boolean;
}

export function createTurnState(): TurnState {
  return {
    mutationSeq: 0,
    lastBashRun: new Map(),
    lastBlockedBash: undefined,
    turnsSeen: 0,
    cadenceFired: false,
    lg1Mutations: new Map(),
    lg1Noted: new Set(),
    lg1Armed: undefined,
    lg1ErrStreak: 0,
    lg1ErrNoted: false,
    lg1ErrMutSeq: 0,
    turnPhase: "idle",
    phaseNoted: false,
  };
}

/** LG1/PH1/R11 per-turn reset. `mutationSeq` is deliberately kept — it is the
 * "nothing landed since" evidence, not a turn counter. */
export function resetTurnParts(t: TurnState): void {
  t.lg1Mutations.clear();
  t.lg1Noted.clear();
  t.lg1Armed = undefined;
  t.lg1ErrStreak = 0;
  t.lg1ErrNoted = false;
  t.lg1ErrMutSeq = 0;
}

/** One-shot block of an armed path's next mutation — called from the
 * edit/write tool_call paths after malformed-input validation. */
export function lg1GateMutation(
  t: TurnState,
  path: string,
): string | undefined {
  if (!ruleEnabled("loopGuard") || t.lg1Armed !== path) return undefined;
  const n = t.lg1Mutations.get(path) ?? LG1_ARM_AT;
  t.lg1Armed = undefined;
  return `Loop Guard (LG1): ${path} was edited ${n} times this turn — possible loop. Stop: summarize what you tried and what remains, then ask the user before continuing.`;
}

/** Landed-mutation counter; the note text rides the landing result. */
export function lg1RecordMutation(
  t: TurnState,
  path: string,
): string | undefined {
  if (!ruleEnabled("loopGuard")) return undefined;
  const n = (t.lg1Mutations.get(path) ?? 0) + 1;
  t.lg1Mutations.set(path, n);
  if (n === LG1_ARM_AT) {
    t.lg1Armed = path;
    return `Loop Guard (LG1): ${path} edited ${n} times this turn — if you are circling, state what is left to finish or ask the user.`;
  }
  if (n === LG1_NOTE_AT && !t.lg1Noted.has(path)) {
    t.lg1Noted.add(path);
    return `Loop Guard (LG1): ${path} edited ${n} times this turn — if you are circling, state what is left to finish or ask the user.`;
  }
  return undefined;
}

/** Consecutive tool errors (bash + edit/write): note once at 3 (LG1), escalate at
 * FAILURE_LOOP_AT (R11). */
export function lg1RecordResult(
  t: TurnState,
  isError: boolean,
): string | undefined {
  if (!isError) {
    t.lg1ErrStreak = 0;
    return undefined;
  }
  if (t.lg1ErrStreak === 0) t.lg1ErrMutSeq = t.mutationSeq;
  t.lg1ErrStreak++;
  if (!ruleEnabled("loopGuard")) return undefined;
  if (t.lg1ErrStreak === 3 && !t.lg1ErrNoted) {
    t.lg1ErrNoted = true;
    return "Loop Guard (LG1): 3 consecutive tool errors — if the same fix keeps failing, stop and ask the user instead of retrying.";
  }
  return undefined;
}

/** PH1: advance the turn's phase label and, on entering `recovering`, emit the
 * single note this rule allows per turn. Advisory only — it never blocks. */
export function phaseRecord(
  t: TurnState,
  kind: ActionKind,
  failed: boolean,
): string | undefined {
  const prev = t.turnPhase;
  t.turnPhase = nextPhase(t.turnPhase, { kind, failed });
  if (!ruleEnabled("phaseNudge")) return undefined;
  if (t.turnPhase !== "recovering" || prev === "recovering" || t.phaseNoted)
    return undefined;
  t.phaseNoted = true;
  return "Phase (PH1): recovering — the last verify failed right after an edit. Change the code before running it again; an unchanged re-run is what R10 blocks, a failure streak is what R11 blocks.";
}
