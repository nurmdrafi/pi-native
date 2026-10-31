/**
 * Client mirrors of the subagent feeds the server attaches to the snapshot
 * and session detail (scripts/feeds.mjs shapes). Kept beside the feature
 * instead of types.ts: every field is nullable exactly where the reader
 * degrades, and the arrays are optional because older snapshots (and any
 * feeds read failure server-side) ship without them.
 */
import type { PromptItem, SessionDetail, Snapshot, TurnDetail } from "./types";

/** Stall classification of a child's activity snapshot, by snapshot age. */
export type StallState = "healthy" | "stalled" | "unknown";

/** How a stall state is toned in the UI: amber only for the stalled warning,
 * neutral chrome for healthy, muted for unknown. */
export type StallTone = "warn" | "neutral" | "muted";

/** One live child agent: its spawner's latest activity snapshot for it. */
export interface ChildStatus {
  /** The child's own id (the activity file's name). */
  childId: string;
  /** The spawner session owning the snapshot (the artifact dir name). */
  sessionId: string;
  /** Registry-resolved instance name; null when unresolvable. */
  name: string | null;
  phase: "starting" | "active" | "waiting" | "done";
  /** Tool name while a tool call runs; null between calls. */
  activeTool: string | null;
  /** What the child is busy with (turn, tool, provider); null when idle. */
  activeScope: string | null;
  /** Epoch ms of the current activity span; null when not active. */
  activeSinceMs: number | null;
  /** Epoch ms since the child last asked its orchestrator; null otherwise. */
  waitingSinceMs: number | null;
  /** The child's current turn ordinal; null when unknown. */
  turnIndex: number | null;
  /** Epoch ms of the snapshot this row was built from. */
  updatedAtMs: number;
  /** Last lifecycle event name the extension recorded; null when none. */
  latestEvent: string | null;
  stallState: StallState;
}

/** One durable subagent outcome record (the result inbox). */
export interface SubagentResult {
  id: string | null;
  /** Epoch ms; null when the record carried no timestamp. */
  ts: number | null;
  name: string | null;
  agent: string | null;
  /** Process exit code; null when not recorded. */
  exitCode: number | null;
  elapsedMs: number | null;
  costUsd: number | null;
  summary: string | null;
  /** Terminal error message; null on clean exits. */
  error: string | null;
}

/** Snapshot plus the live feeds; the feeds are optional so older payloads
 * (and any server-side feeds failure) stay type-safe. */
export type SnapshotWithFeeds = Snapshot & {
  children?: ChildStatus[];
  subagentResults?: SubagentResult[];
};

/** Prompt carrying the full text; `text` is optional because raw-file reads
 * can miss, leaving only the extract's preview. */
export type PromptWithText = PromptItem & { text?: string };

/** Turn with the raw-file durationMs join; present only when the join hit. */
export type TurnWithDuration = TurnDetail & { durationMs?: number };

/** Registry-joined lineage attached to the session detail; omitted when the
 * join found neither a parent nor children. */
export interface SessionLineage {
  /** This session's spawner, when the session is a subagent child. */
  parent: { sessionId: string; name: string } | null;
  /** Children this session spawned, by its own registry. */
  children: { name: string; sessionId: string; sessionFile: string | null }[];
}

export type DetailWithLineage = SessionDetail & { lineage?: SessionLineage };
