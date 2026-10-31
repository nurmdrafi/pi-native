export interface SessionSummary {
  sessionId: string;
  project: string;
  path: string;
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
