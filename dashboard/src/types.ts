export interface SessionSummary {
  sessionId: string;
  project: string;
  path: string;
  /** Lineage: "main" sessions run standalone; "subagent" sessions were
   * spawned by a parent session, named (basename) in `parentSession` — null
   * for main sessions. */
  kind: "main" | "subagent";
  parentSession: string | null;
  turns: number;
  cost: number;
  models: string[];
  toolCalls: number;
  tools: Record<string, number>;
  toolCosts: Record<string, number>;
  firstTs: string | null;
  lastTs: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  reasoningShare: number;
  durationSec: number;
  tokensPerTurn: number;
  avgTurnCost: number;
  compactions: number;
  blocksByTool: Record<string, number>;
  /** Per-tag gate counts for this session: blocks, warns, the tools that
   * triggered them, and the same counts bucketed by local day. */
  gateTags: Record<string, {
    block: number;
    warn: number;
    tools: Record<string, number>;
    toolsBlock: Record<string, number>;
    toolsWarn: Record<string, number>;
    byDay?: Record<string, { block: number; warn: number }>;
  }>;
  subagents: SubagentMetrics;
  agent: {
    repeatWithoutChange: number;
    failureStreakCalls: number;
    maxFailureStreak: number;
    blocks: number;
    blocksByFamily: Record<string, number>;
    gateTokenSharePct: number;
  };
}

export interface ProjectRollup {
  project: string;
  sessions: number;
  turns: number;
  cost: number;
}

export interface ModelRollup {
  model: string;
  turns: number;
  cost: number;
}

export interface SpendSummary {
  today: number;
  week: number;
  projectedToday: number | null;
  days: { day: string; cost: number }[];
}

export interface CostAlert {
  sessionId: string;
  project: string;
  cost: number;
  budget: number;
  pct: number;
  level: "near" | "over";
}

export interface TimelineBucket {
  start: number;
  turns: number;
  cost: number;
  calls: number;
}

export interface AgentBreakdown {
  agent: string;
  spawns: number;
  messages: number;
  errors: number;
  avgLatencyMs: number;
  /** 50th-percentile call→result latency in ms, pooled per message from the
   * transcripts per session; aggregates message-weight per-session means.
   * Absent when the pool holds fewer than two samples. */
  p50LatencyMs?: number;
  /** 95th-percentile call→result latency in ms; same pooling as
   * p50LatencyMs. Absent when the pool holds fewer than two samples. */
  p95LatencyMs?: number;
  /** Median lag in ms from this agent's spawn call to the instance's first
   * subagent_message call, pooled across instances; aggregates weight each
   * session's median by its spawn count. Absent when fewer than two timed
   * pairs exist. */
  spawnToFirstMsgMs?: number;
}

export interface SubagentMetrics {
  spawns: number;
  messages: number;
  lists: number;
  errors: number;
  avgLatencyMs: number;
  /** 50th-percentile call→result latency in ms. Per-session values pool
   * per-message latencies from the transcripts; aggregate values
   * message-weight per-session means. Absent when the pool holds fewer than
   * two samples. */
  p50LatencyMs?: number;
  /** 95th-percentile call→result latency in ms; same pooling as
   * p50LatencyMs. Absent when the pool holds fewer than two samples. */
  p95LatencyMs?: number;
  /** Aggregates only: daily spawn counts from the raw transcripts' subagent
   * calls, clipped to the snapshot's day window and sorted by day. Absent
   * when the aggregate was built without raw extracts or saw no spawns. */
  timeline?: SubagentSpawnDay[];
  byAgent: AgentBreakdown[];
}

/** One day of the global subagent spawn timeline. */
export interface SubagentSpawnDay {
  day: string;
  spawns: number;
}

export interface SpawnRecord {
  id: string;
  ts: string | null;
  agent: string;
  name: string | null;
}

export interface GateRule {
  id: string;
  /** Stable rule id used in source comments and block reasons (SE2, R1, …). */
  code: string;
  /** What the rule claims, in words — the docs' name for it. */
  label: string;
  /** Rule family the gate groups by. */
  group: string;
  severity: string;
  family: string | null;
  /** Blocked calls this rule caused, counted from session transcripts. */
  blocks: number;
  /** Advisory notes this rule appended to successful results. */
  warns: number;
  /** Tool that triggered it most often, when any. */
  topTool: string | null;
  /** Daily [blocks, warns] aligned to GateSummary.days; absent on older
   * snapshots, empty when the window spans no days. */
  trend?: number[][];
  /** Estimated spend its blocked calls avoided — blocks × the tool's average
   * call cost. Absent on older snapshots. */
  avoidedSpend?: number;
  /** Transcript tags (live and retired) whose counts feed this row. */
  tags?: string[];
}

export interface GateSummary {
  total: number;
  byFamily: Record<string, number>;
  rules: GateRule[];
  bySeverity: { error: number; warn: number; off: number };
  familySeverity: Record<string, string | null>;
  blocksByTool: Record<string, number>;
  /** Same events split per tool and per outcome, for the stacked tool chart. */
  byTool: { tool: string; blocks: number; warns: number }[];
  /** Days the per-rule trend arrays are aligned to, ascending. */
  days?: string[];
  avoidedSpend: number;
  /** Guard tags seen in transcripts that no config rule claims — a mapping
   * drift signal, shown rather than silently dropped. */
  unmappedTags: { tag: string; blocks: number; warns: number }[];
}

export interface PromptItem {
  ts: string | null;
  preview: string;
}

/** Volume counts for one day of the byDay cost series. */
export interface DayCountMetrics {
  turns: number;
  calls: number;
}

/** Per-model token totals behind the cost mix. */
export interface ModelTokenRollup {
  model: string;
  turns: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface Aggregates {
  byDay: Record<string, number>;
  byProject: ProjectRollup[];
  totals: { sessions: number; turns: number; cost: number; toolCalls: number };
  modelMix: ModelRollup[];
  cacheHitRate: number;
  reasoningShare: number;
  blocksTotal: number;
  blocksByFamily: Record<string, number>;
  blocksPerSession: number;
  repeatPct: number;
  avgDurationSec: number;
  spend: SpendSummary;
  alerts: CostAlert[];
  subagents: SubagentMetrics;
  gate: GateSummary;
  /** Median / p95 session duration in seconds; null when fewer than two
   * timed sessions. Absent on older snapshots. */
  duration?: { p50Sec: number | null; p95Sec: number | null };
  /** Median / p95 turn latency in ms; null when fewer than two sampled
   * turns. Absent on older snapshots. */
  turnLatency?: { p50Ms: number | null; p95Ms: number | null };
  /** Tool-call error rollup. toolErrorRate and each byTool rate are
   * fractions (0–1), not percents. Absent on older snapshots. */
  errors?: {
    toolErrors: number;
    toolErrorRate: number;
    byTool: { tool: string; errors: number; calls: number; rate: number }[];
  };
  /** Daily volume behind byDay's costs. Absent on older snapshots. */
  byDayCounts?: Record<string, DayCountMetrics>;
  /** Context-window compactions per day, days ascending. Absent on older
   * snapshots. */
  compactionsByDay?: { day: string; count: number }[];
  /** Project-by-day cost grid: cells[projectIndex][dayIndex]. Absent on
   * older snapshots. */
  projectDay?: { projects: string[]; days: string[]; cells: number[][] };
  /** Per-model token totals. Absent on older snapshots. */
  modelTokenMix?: ModelTokenRollup[];
}

export interface ActiveSession {
  file: string;
  path?: string;
  sessionId?: string | null;
  project: string;
  turns: number;
  cost: number;
}

export interface Snapshot {
  generatedAt: string;
  /** Start time of the server process; absent on snapshots from older builds. */
  serverStartedAt?: string;
  /** Date window the numbers cover; null bounds mean "all time". */
  range: { from: string | null; to: string | null };
  sessions: SessionSummary[];
  aggregates: Aggregates;
  active: ActiveSession[];
}

export interface TurnDetail {
  i: number;
  ts: string | null;
  model: string | null;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface CallDetail {
  name: string;
  ts: string;
  cmd: string | null;
  path: string | null;
  /** Turn cost shared evenly across the turn's calls (rid join); 0 when the
   * call never matched a billed turn. */
  cost: number;
}

export interface SessionDetail {
  sessionId: string;
  project: string;
  summary: SessionSummary;
  turns: TurnDetail[];
  calls: CallDetail[];
  compactions: number;
  skills: Record<string, number>;
  usageByModel: Record<string, { turns: number; costTotal: number }>;
  timeline: TimelineBucket[];
  prompts: PromptItem[];
  subagents: SubagentMetrics;
  subagentSpawns: SpawnRecord[];
}

export interface LiveTurnEvent {
  kind: "turn";
  ts: string | null;
  model: string | null;
  cost: number;
  durationMs: number | null;
  toolCalls: number;
}

export interface LivePayload {
  file: string;
  events: LiveTurnEvent[];
}
