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

export interface SubagentMetrics {
  spawns: number;
  messages: number;
  lists: number;
  errors: number;
  avgLatencyMs: number;
}

export interface GateRule {
  id: string;
  severity: string;
}

export interface GateSummary {
  total: number;
  byFamily: Record<string, number>;
  rules: GateRule[];
  bySeverity: { error: number; warn: number; off: number };
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
