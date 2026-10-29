/**
 * Turn-limit helpers for the handoff extension.
 *
 * A "turn" is one user message that started an agent run, counted from session
 * entries so the count survives restarts. Like the permission-gate cadence
 * rule (AGENTS.md Token Economy), the budget resets at a compaction: only user
 * messages after the last compaction entry count. When the count reaches the
 * limit, the extension offers a handoff and pre-fills the input line with
 * `/handoff <suggested goal>` (goal capped at five words).
 */
import { CADENCE_TURNS } from "../permission-gate/cadence.ts";

/** Default limit is the shared cadence definition — one budget, two consumers. */
export const DEFAULT_TURN_LIMIT = CADENCE_TURNS;
export const TURN_LIMIT_ENV = "HANDOFF_TURN_LIMIT";
export const MAX_GOAL_WORDS = 5;
/** Short replies like "yes" make poor goal suggestions; prefer meatier ones. */
const MIN_GOAL_WORDS = 3;

/** Minimal shape of a session entry needed here (structural, not the full type). */
export interface TurnEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | { type?: string; text?: string }[];
  };
}

function entryText(entry: TurnEntry): string {
  const { message } = entry;
  if (!message || message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

/** User-message entries after the last compaction — the current turn budget. */
export function countTurns(entries: readonly TurnEntry[]): number {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      start = i + 1;
      break;
    }
  }
  return entries
    .slice(start)
    .filter((entry) => entry.type === "message" && entryText(entry).trim() !== "")
    .length;
}

/** Limit from the environment; falls back to the default when unset or invalid. */
export function resolveTurnLimit(env: Record<string, string | undefined>): number {
  const raw = env[TURN_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TURN_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_TURN_LIMIT;
  return value;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter((word) => word !== "");
}

/** Last user text with enough words, capped at MAX_GOAL_WORDS; "" when none. */
export function suggestGoal(entries: readonly TurnEntry[]): string {
  const texts = entries
    .filter((entry) => entry.type === "message")
    .map(entryText)
    .map((text) => text.trim())
    .filter((text) => text !== "");
  const goal =
    [...texts].reverse().find((text) => words(text).length >= MIN_GOAL_WORDS) ?? texts.at(-1) ?? "";
  return words(goal).slice(0, MAX_GOAL_WORDS).join(" ");
}

/** The command line to pre-fill: `/handoff <goal>`, or bare `/handoff` when empty. */
export function handoffCommandText(goal: string): string {
  const trimmed = goal.trim();
  return trimmed === "" ? "/handoff" : `/handoff ${trimmed}`;
}

/** Whether the turn limit has been reached and the user has not been asked yet. */
export function shouldPromptForHandoff(turns: number, limit: number, alreadyAsked: boolean): boolean {
  return !alreadyAsked && limit > 0 && turns >= limit;
}
