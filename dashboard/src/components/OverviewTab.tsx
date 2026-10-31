import { Fragment, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart, Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import {
  Brain,
  Calculator,
  CircleDollarSign,
  Database,
  Gauge,
  Hourglass,
  PiggyBank,
  Repeat2,
  ShieldAlert,
  Timer,
  TrendingUp,
  TriangleAlert,
  CalendarClock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/StatCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { fmtCount, fmtDuration, fmtLatency, fmtMoney, basename } from "@/lib/format";
import {
  GATE_SHARE_BUCKETS,
  GATE_SHARE_HIGH,
  dayKey,
  failureStreakLeague,
  gateShareBucket,
  perCall,
  perCallRate,
  toolLeaderboard,
} from "@/lib/derive";
import type { Snapshot } from "@/types";

const dayConfig = { cost: { label: "cost", color: "var(--chart-1)" } } satisfies ChartConfig;
const projectConfig = { cost: { label: "cost", color: "var(--chart-1)" } } satisfies ChartConfig;
const modelCostConfig = { cost: { label: "cost", color: "var(--chart-1)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;
/** Model mix slices are identities, not ranks: each model keeps a stable hue
 * — hash the name into the five-color ramp (chart-4 is the mix chart's home
 * hue), advancing past collisions so the slices on screen stay distinct. */
const MIX_COLORS = [
  "var(--chart-4)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-5)",
];
function mixPalette(models: string[]): Record<string, string> {
  const taken: string[] = [];
  const out: Record<string, string> = {};
  for (const model of models) {
    let h = 0;
    for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
    let i = h % MIX_COLORS.length;
    while (taken.includes(MIX_COLORS[i]) && taken.length < MIX_COLORS.length)
      i = (i + 1) % MIX_COLORS.length;
    out[model] = MIX_COLORS[i];
    taken.push(MIX_COLORS[i]);
  }
  return out;
}

const money = (v: number) => (v >= 1 ? fmtMoney(v) : `$${v.toFixed(2)}`);
const scatterConfig = { session: { label: "session", color: "var(--chart-1)" } } satisfies ChartConfig;
/** Ratios are secondary metrics — one hue (chart-2), two stops of its ladder. */
const ratioTrendConfig = {
  cacheHitRate: { label: "cache hit rate", color: "var(--chart-2)" },
  reasoningShare: { label: "reasoning share", color: "var(--chart-2)" },
} satisfies ChartConfig;
const toolRateConfig = { perCall: { label: "per call", color: "var(--chart-1)" } } satisfies ChartConfig;
const compactionConfig = { count: { label: "compactions", color: "var(--chart-3)" } } satisfies ChartConfig;
/** Token streams keep one hue each across every chart that shows them. */
const tokenStackConfig = {
  input: { label: "input", color: "var(--chart-1)" },
  output: { label: "output", color: "var(--chart-2)" },
  reasoning: { label: "reasoning", color: "var(--chart-3)" },
  cacheRead: { label: "cache read", color: "var(--chart-4)" },
  cacheWrite: { label: "cache write", color: "var(--chart-5)" },
} satisfies ChartConfig;
const gateShareConfig = { sessions: { label: "sessions", color: "var(--chart-5)" } } satisfies ChartConfig;

/** Scatter tooltip leads with who the dot is, then where it sits. */
function ScatterTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { x: number; y: number; project: string; id: string } }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-sm">
      <div className="font-medium">{p.project}</div>
      <div className="font-mono text-muted-foreground">{p.id}</div>
      <div className="mt-1 tabular-nums">
        {fmtDuration(p.x)} · {money(p.y)}
      </div>
    </div>
  );
}

/** Cost-by-day tooltip: cost leads, then the day's volume when the counts
 * rollup shipped it. */
function DayTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { day: string; cost: number; turns: number | null; calls: number | null } }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-sm">
      <div className="font-medium tabular-nums">{p.day.slice(5)}</div>
      <div className="mt-1 tabular-nums">{money(p.cost)}</div>
      {p.turns !== null && (
        <div className="tabular-nums text-muted-foreground">{fmtCount(p.turns)} turns</div>
      )}
      {p.calls !== null && (
        <div className="tabular-nums text-muted-foreground">{fmtCount(p.calls)} calls</div>
      )}
    </div>
  );
}

export function OverviewTab({
  snapshot,
  onOpenSession,
}: {
  snapshot: Snapshot;
  onOpenSession: (sessionId: string) => void;
}) {
  const agg = snapshot.aggregates;
  const [mixMode, setMixMode] = useState<"cost" | "tokens">("cost");
  const dayRows = Object.entries(agg.byDay)
    .map(([day, cost]) => ({
      day,
      cost,
      turns: agg.byDayCounts?.[day]?.turns ?? null,
      calls: agg.byDayCounts?.[day]?.calls ?? null,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const days = dayRows.slice(-30);
  // Last 7 days against the 7 before them: the delta reads on the 7d card.
  const sum = (rows: { cost: number }[]) => rows.reduce((n, d) => n + d.cost, 0);
  const last7 = sum(dayRows.slice(-7));
  const prior7 = sum(dayRows.slice(-14, -7));
  const delta =
    prior7 > 0
      ? `${last7 >= prior7 ? "+" : ""}${Math.round(((last7 - prior7) / prior7) * 100)}% vs prior 7d`
      : last7 > 0
        ? "first week of spend"
        : null;
  // Amber speaks only for warning: a doubled week of spend is one, a mild
  // rise is not — the hint keeps its number either way.
  const spendSurge = prior7 > 0 && last7 >= prior7 * 2;
  const peak = days.reduce((a, b) => (b.cost > a.cost ? b : a), days[0] ?? { day: "", cost: 0 });
  const topProject = agg.byProject[0];
  const topShare =
    topProject && agg.totals.cost > 0
      ? Math.round((topProject.cost / agg.totals.cost) * 1000) / 10
      : null;
  const compactions = snapshot.sessions.reduce((n, s) => n + s.compactions, 0);
  const compactionDays = (agg.compactionsByDay ?? []).slice(-30);
  const activeProjects = [...new Set(snapshot.active.map((a) => basename(a.project)))].slice(0, 4);
  // Absolute token pools behind the two share metrics, so the percentages can
  // be checked against real volumes at a glance.
  const tokens = snapshot.sessions.reduce(
    (acc, s) => ({
      input: acc.input + s.inputTokens,
      output: acc.output + s.outputTokens,
      cached: acc.cached + s.cacheReadTokens,
      reasoning: acc.reasoning + s.reasoningTokens,
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0 },
  );
  const projects = agg.byProject
    .slice(0, 8)
    .map((p) => ({ project: basename(p.project), cost: p.cost }));
  const modelMix = agg.modelMix.slice(0, 5);
  // Token view of the same mix: total tokens decides the slice set.
  const tokenModels = [...(agg.modelTokenMix ?? [])]
    .map((m) => ({ ...m, total: m.input + m.output + m.reasoning + m.cacheRead + m.cacheWrite }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const hasTokenMix = tokenModels.length > 0;
  // One palette across both views so a model keeps its hue when toggling.
  const mixColors = mixPalette([
    ...new Set([...modelMix, ...tokenModels].map((m) => m.model)),
  ]);
  // Project × day grid: last 30 day columns, top 10 projects by window cost.
  const heat = (() => {
    const pd = agg.projectDay;
    if (!pd || pd.projects.length === 0 || pd.days.length === 0) return null;
    const from = Math.max(0, pd.days.length - 30);
    const days = pd.days.slice(from);
    const cells = pd.cells.map((row) => row.slice(from));
    const totals = cells.map((row) => row.reduce((n, v) => n + (v || 0), 0));
    const order = pd.projects
      .map((_, i) => i)
      .sort((a, b) => totals[b] - totals[a])
      .slice(0, 10);
    const rows = order.map((i) => ({
      name: pd.projects[i],
      cells: cells[i] ?? [],
      total: totals[i],
    }));
    const max = Math.max(1, ...rows.flatMap((r) => r.cells.map((v) => v || 0)));
    return { days, rows, max };
  })();
  // Same rollup as the donut above: each model's own recorded usage cost.
  const modelCosts = [...agg.modelMix].sort((a, b) => b.cost - a.cost).slice(0, 8);
  const multiModel = snapshot.sessions.some((s) => (s.models?.length ?? 0) > 1);
  const toolLeague = toolLeaderboard(snapshot.sessions);
  const tools = toolLeague.slice(0, 10);
  const families = Object.entries(agg.gate?.byFamily ?? {}).sort((a, b) => b[1] - a[1]);
  const alerts = agg.alerts ?? [];
  const over = alerts.filter((a) => a.level === "over");
  const near = alerts.filter((a) => a.level !== "over");

  // Longest failed-call runs; severity rides on the number, never the row.
  const streaks = failureStreakLeague(snapshot.sessions).slice(0, 8);
  const dots = snapshot.sessions
    .filter((s) => s.durationSec > 0 || s.cost > 0)
    .map((s) => ({
      x: s.durationSec,
      y: s.cost,
      project: basename(s.project),
      id: s.sessionId.slice(0, 8),
    }));
  // Per-day mean of per-session ratios, aligned to the spend-day axis.
  const ratiosByDay = new Map<string, { hit: number; reason: number; n: number }>();
  for (const s of snapshot.sessions) {
    if (!s.firstTs) continue;
    const key = dayKey(s.firstTs);
    const d = ratiosByDay.get(key) ?? { hit: 0, reason: 0, n: 0 };
    d.hit += s.cacheHitRate;
    d.reason += s.reasoningShare;
    d.n += 1;
    ratiosByDay.set(key, d);
  }
  const ratioDays = agg.spend.days.map(({ day }) => {
    const d = ratiosByDay.get(day);
    return {
      day,
      cacheHitRate: d ? Math.round((d.hit / d.n) * 10) / 10 : null,
      reasoningShare: d ? Math.round((d.reason / d.n) * 10) / 10 : null,
    };
  });
  const ratioWindow = ratioDays.slice(-30);
  const hasRatios = ratioWindow.some((d) => d.cacheHitRate !== null);
  // $/call needs volume before it means anything — thin tools stay off.
  const minCallsPerTool = 10;
  const toolRates = toolLeague
    .filter((t) => t.calls >= minCallsPerTool && t.cost > 0)
    .map((t) => ({ name: t.name, perCall: perCallRate(t.cost, t.calls) ?? 0, calls: t.calls, cost: t.cost }))
    .sort((a, b) => b.perCall - a.perCall)
    .slice(0, 8);
  const gateShareCounts = snapshot.sessions.reduce(
    (acc, s) => {
      acc[gateShareBucket(s.agent.gateTokenSharePct)] += 1;
      return acc;
    },
    [0, 0, 0, 0, 0],
  );
  const gateShareData = GATE_SHARE_BUCKETS.map((bucket, i) => ({
    bucket,
    sessions: gateShareCounts[i],
  }));
  const gateShareHigh = gateShareCounts[GATE_SHARE_HIGH];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard icon={CircleDollarSign} label="today" value={fmtMoney(agg.spend.today)} />
        <StatCard
          icon={TrendingUp}
          label="last 7 days"
          value={fmtMoney(agg.spend.week)}
          hint={delta ?? undefined}
          hintClassName={spendSurge ? "text-warn-foreground" : undefined}
        />
        <StatCard
          icon={CalendarClock}
          label="projected today"
          value={agg.spend.projectedToday !== null ? fmtMoney(agg.spend.projectedToday) : "—"}
          hint={agg.spend.projectedToday !== null ? undefined : "early in the day"}
        />
        <StatCard
          icon={Calculator}
          label="total cost"
          value={fmtMoney(agg.totals.cost)}
          hint={`${fmtCount(agg.totals.sessions)} sessions`}
        />
        <StatCard
          icon={PiggyBank}
          label="avg cost / session"
          value={fmtMoney(agg.totals.sessions ? agg.totals.cost / agg.totals.sessions : 0)}
          hint={`${fmtCount(agg.totals.turns)} turns · ${fmtCount(agg.totals.toolCalls)} calls`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard
          icon={Database}
          label="cache hit rate"
          value={`${agg.cacheHitRate}%`}
          hint={`in ${fmtCount(tokens.input)} · cached ${fmtCount(tokens.cached)}`}
        />
        <StatCard
          icon={Brain}
          label="reasoning share"
          value={`${agg.reasoningShare}%`}
          hint={`out ${fmtCount(tokens.output)} · reasoning ${fmtCount(tokens.reasoning)}`}
        />
        <StatCard
          icon={Timer}
          label="avg session length"
          value={fmtDuration(agg.avgDurationSec)}
          hint={`${compactions} compactions`}
        />
        <StatCard
          icon={ShieldAlert}
          label="gate blocks / session"
          value={String(agg.blocksPerSession)}
          hint={agg.gate ? `${agg.gate.total} total` : undefined}
        />
        <StatCard icon={Repeat2} label="repeat calls" value={`${agg.repeatPct}%`} />
        <StatCard
          icon={PiggyBank}
          label="avoided spend"
          value={fmtMoney(agg.gate?.avoidedSpend ?? 0)}
          hint="estimate · fix list"
          href="#/gate"
        />
        {agg.duration && (
          <StatCard
            icon={Hourglass}
            label="duration p50 / p95"
            value={
              agg.duration.p50Sec != null && agg.duration.p95Sec != null
                ? `${fmtDuration(agg.duration.p50Sec)} / ${fmtDuration(agg.duration.p95Sec)}`
                : "—"
            }
            hint={
              agg.duration.p50Sec != null && agg.duration.p95Sec != null
                ? "median / 95th percentile session"
                : "fewer than two timed sessions"
            }
          />
        )}
        {agg.turnLatency && (
          <StatCard
            icon={Gauge}
            label="turn latency p50 / p95"
            value={
              agg.turnLatency.p50Ms != null && agg.turnLatency.p95Ms != null
                ? `${fmtLatency(agg.turnLatency.p50Ms)} / ${fmtLatency(agg.turnLatency.p95Ms)}`
                : "—"
            }
            hint={
              agg.turnLatency.p50Ms != null && agg.turnLatency.p95Ms != null
                ? "median / 95th percentile turn"
                : "fewer than two timed turns"
            }
          />
        )}
        {agg.errors && (
          <StatCard
            icon={TriangleAlert}
            label="tool error rate"
            value={`${Math.round(agg.errors.toolErrorRate * 1000) / 10}%`}
            hint={`${fmtCount(agg.errors.toolErrors)} failed tool calls`}
            hintClassName={agg.errors.toolErrorRate > 0 ? "text-warn-foreground" : undefined}
          />
        )}
      </div>

      {snapshot.active.length > 0 && (
        <p className="text-xs text-muted-foreground">
          <a href="#/live" className="text-foreground underline-offset-2 hover:underline">
            {snapshot.active.length} session{snapshot.active.length === 1 ? "" : "s"} writing now
          </a>{" "}
          · {activeProjects.join(", ")}
        </p>
      )}

      {alerts.length > 0 && (
        <Card className={over.length > 0 ? "border-error/40" : "border-warn/45"}>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              budget alerts
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {over.length} over · {near.length} near (80%+ of budget)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {[...over, ...near].map((a) => (
              <Badge
                key={a.sessionId}
                variant={a.level === "over" ? "destructive" : "secondary"}
                className="font-mono text-xs"
                asChild
              >
                <button
                  type="button"
                  onClick={() => onOpenSession(a.sessionId)}
                  title={`open session ${a.sessionId}`}
                  aria-label={`open session ${a.sessionId.slice(0, 8)}, ${a.level} budget`}
                >
                  {a.sessionId.slice(0, 8)} · {basename(a.project)} · {fmtMoney(a.cost)} /{" "}
                  {fmtMoney(a.budget)} · {a.pct}%
                </button>
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              cost by day
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                last 30 days
                {peak.cost > 0 && ` · peak ${peak.day.slice(5)} ${money(peak.cost)}`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={dayConfig} className="h-56 w-full">
              <AreaChart data={days}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d: string) => d.slice(5)}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  minTickGap={24}
                />
                <YAxis
                  tickFormatter={money}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  width={52}
                />
                <ChartTooltip content={<DayTip />} />
                <Area
                  dataKey="cost"
                  type="monotone"
                  fill="var(--color-cost)"
                  fillOpacity={0.12}
                  stroke="var(--color-cost)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              model mix (by {mixMode === "cost" ? "cost" : "tokens"})
            </CardTitle>
            {hasTokenMix && (
              <div
                data-slot="card-action"
                role="group"
                aria-label="model mix metric"
                className="flex rounded-md border p-0.5 text-xs"
              >
                {(["cost", "tokens"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setMixMode(mode)}
                    aria-pressed={mixMode === mode}
                    className={`rounded-[5px] px-2 py-0.5 transition-colors ${
                      mixMode === mode
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent>
            {mixMode === "tokens" ? (
              <ChartContainer config={tokenStackConfig} className="h-56 w-full">
                <BarChart data={tokenModels} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={fmtCount}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="model"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={124}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="input" stackId="tokens" fill="var(--color-input)" />
                  <Bar dataKey="output" stackId="tokens" fill="var(--color-output)" />
                  <Bar dataKey="reasoning" stackId="tokens" fill="var(--color-reasoning)" />
                  <Bar dataKey="cacheRead" stackId="tokens" fill="var(--color-cacheRead)" />
                  <Bar dataKey="cacheWrite" stackId="tokens" fill="var(--color-cacheWrite)" />
                </BarChart>
              </ChartContainer>
            ) : (
              <ChartContainer
                config={Object.fromEntries(
                  modelMix.map((m) => [m.model, { label: m.model, color: mixColors[m.model] }]),
                )}
                className="h-56 w-full"
              >
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Pie data={modelMix} dataKey="cost" nameKey="model" innerRadius={48} strokeWidth={2}>
                    {modelMix.map((entry) => (
                      <Cell key={entry.model} fill={mixColors[entry.model]} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
            {mixMode === "tokens" && (
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {Object.entries(tokenStackConfig).map(([key, cfg]) => (
                  <li key={key} className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: cfg.color }} />
                    {cfg.label}
                  </li>
                ))}
              </ul>
            )}
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {mixMode === "tokens"
                ? tokenModels.map((m) => (
                    <li key={m.model} className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: mixColors[m.model] }}
                      />
                      {m.model} · {fmtCount(m.total)} tokens
                    </li>
                  ))
                : modelMix.map((m) => (
                    <li key={m.model} className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: mixColors[m.model] }} />
                      {m.model} · {fmtMoney(m.cost)} · {fmtCount(m.turns)} turns
                    </li>
                  ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              cost by project
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                top {projects.length}
                {topShare !== null && ` · leader ${topShare}% of spend`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {projects.length === 0 ? (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no recorded spend
              </div>
            ) : (
              <ChartContainer config={projectConfig} className="h-56 w-full">
                <BarChart data={projects} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={money}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="project"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={124}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              tools — cost and calls
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                top {tools.length} by cost
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tools.length === 0 ? (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no tool calls recorded
              </div>
            ) : (
              <ChartContainer config={toolConfig} className="h-56 w-full">
                <ComposedChart data={tools}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10 }}
                    interval={0}
                    angle={-18}
                    height={44}
                  />
                  <YAxis
                    yAxisId="cost"
                    tickFormatter={money}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={52}
                  />
                  <YAxis
                    yAxisId="calls"
                    orientation="right"
                    tickFormatter={fmtCount}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={40}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar yAxisId="cost" dataKey="cost" fill="var(--color-cost)" radius={4} />
                  <Line
                    yAxisId="calls"
                    dataKey="calls"
                    type="monotone"
                    stroke="var(--color-calls)"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {heat && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              project × day cost
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                last {heat.days.length} days · top {heat.rows.length} projects
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <div
                className="grid gap-[2px]"
                style={{
                  gridTemplateColumns: `minmax(96px, auto) repeat(${heat.days.length}, minmax(12px, 1fr))`,
                }}
              >
                <div />
                {heat.days.map((day, i) => (
                  <div
                    key={day}
                    className="pb-1 text-[10px] leading-none text-muted-foreground"
                  >
                    {i % Math.max(1, Math.ceil(heat.days.length / 16)) === 0 ? day.slice(5) : ""}
                  </div>
                ))}
                {heat.rows.map((row) => (
                  <Fragment key={row.name}>
                    <div
                      className="truncate text-[11px] text-muted-foreground"
                      title={`${row.name} · ${money(row.total)} total`}
                    >
                      {basename(row.name)}
                    </div>
                    {heat.days.map((day, di) => {
                      const v = row.cells[di] || 0;
                      return (
                        <div
                          key={`${row.name}:${day}`}
                          title={`${row.name} · ${day} · ${money(v)}`}
                          className="h-4 rounded-[2px]"
                          style={
                            v > 0
                              ? {
                                  background: "var(--chart-1)",
                                  opacity: 0.15 + (0.85 * v) / heat.max,
                                }
                              : { background: "var(--muted)" }
                          }
                        />
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              darker = more spend · hover a cell for the day's cost
            </p>
          </CardContent>
        </Card>
      )}

      {compactionDays.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              compactions by day
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                last {compactionDays.length} days ·{" "}
                {fmtCount(compactionDays.reduce((n, d) => n + d.count, 0))} total
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={compactionConfig} className="h-56 w-full">
              <LineChart data={compactionDays}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d: string) => d.slice(5)}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  minTickGap={24}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  width={36}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  dataKey="count"
                  type="monotone"
                  stroke="var(--color-count)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
            <p className="mt-2 text-xs text-muted-foreground">
              context-window compactions per day, all sessions
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">
            cost by model
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              top {modelCosts.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {modelCosts.length === 0 ? (
            <div className="flex h-56 items-center text-xs text-muted-foreground">
              no model data
            </div>
          ) : (
            <>
              <ChartContainer config={modelCostConfig} className="h-56 w-full">
                <BarChart data={modelCosts} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    type="number"
                    tickFormatter={money}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="model"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={124}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
                </BarChart>
              </ChartContainer>
              {multiModel && (
                <div className="mt-2 text-xs text-muted-foreground">
                  multi-model sessions metered per model
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              failure streak league
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                top {streaks.length} · longest run of failed calls
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {streaks.length === 0 ? (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no failed-call streaks recorded
              </div>
            ) : (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="h-8">
                      project
                    </TableHead>
                    <TableHead scope="col" className="h-8">
                      session
                    </TableHead>
                    <TableHead scope="col" className="h-8 text-right">
                      max streak
                    </TableHead>
                    <TableHead scope="col" className="h-8 text-right">
                      calls in streaks
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {streaks.map((s) => (
                    <TableRow
                      key={s.sessionId}
                      tabIndex={0}
                      role="button"
                      aria-label={`open session ${s.sessionId.slice(0, 8)}, max failure streak ${s.agent.maxFailureStreak}`}
                      className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => onOpenSession(s.sessionId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenSession(s.sessionId);
                        }
                      }}
                    >
                      <TableCell className="max-w-[160px] truncate" title={s.project}>
                        {basename(s.project)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {s.sessionId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-error-foreground">
                        {s.agent.maxFailureStreak}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtCount(s.agent.failureStreakCalls)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              duration vs cost
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {dots.length} sessions
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dots.length === 0 ? (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no sessions with duration or spend
              </div>
            ) : (
              <ChartContainer config={scatterConfig} className="h-56 w-full">
                <ScatterChart margin={{ left: 4, right: 12, top: 8 }}>
                  <CartesianGrid />
                  <XAxis
                    type="number"
                    dataKey="x"
                    tickFormatter={fmtDuration}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    tickFormatter={money}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={52}
                  />
                  <ChartTooltip content={<ScatterTip />} />
                  <Scatter data={dots} fill="var(--chart-1)" fillOpacity={0.55} />
                </ScatterChart>
              </ChartContainer>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              one dot = one session · x duration · y cost
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              cache & reasoning by day
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                last {ratioWindow.length} spend days
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hasRatios ? (
              <>
                <ChartContainer config={ratioTrendConfig} className="h-56 w-full">
                  <LineChart data={ratioWindow}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(d: string) => d.slice(5)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${Math.round(v)}%`}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 11 }}
                      width={44}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line
                      dataKey="cacheHitRate"
                      type="monotone"
                      stroke="var(--color-cacheHitRate)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      dataKey="reasoningShare"
                      type="monotone"
                      stroke="var(--color-reasoningShare)"
                      strokeOpacity={0.65}
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <li className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: "var(--chart-2)" }} />
                    cache hit rate
                  </li>
                  <li className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: "var(--chart-2)", opacity: 0.65 }}
                    />
                    reasoning share
                  </li>
                </ul>
              </>
            ) : (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no timestamped sessions to trend
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              mean of per-session ratios — sessions weigh equally, not tokens
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              tool cost per call
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                top {toolRates.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {toolRates.length === 0 ? (
              <div className="flex h-56 items-center text-xs text-muted-foreground">
                no tools with enough calls to rate
              </div>
            ) : (
              <ChartContainer config={toolRateConfig} className="h-56 w-full">
                <BarChart data={toolRates} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={perCall}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={124}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="perCall" fill="var(--color-perCall)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              cost ÷ calls per tool, summed over sessions · under {minCallsPerTool} calls hidden
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">
            gate token share
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {snapshot.sessions.length} sessions · pct of billed input tokens
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.sessions.length === 0 ? (
            <div className="flex h-56 items-center text-xs text-muted-foreground">no sessions</div>
          ) : (
            <>
              <ChartContainer config={gateShareConfig} className="h-56 w-full">
                <BarChart data={gateShareData}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    unit="%"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={36}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="sessions" fill="var(--color-sessions)" radius={4} maxBarSize={64} />
                </BarChart>
              </ChartContainer>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {gateShareData.map((b, i) => {
                  const high = i === GATE_SHARE_HIGH && b.sessions > 0;
                  return (
                    <li key={b.bucket} className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-sm"
                        style={{ background: high ? "var(--warn)" : "var(--chart-5)" }}
                      />
                      <span className={high ? "text-warn" : undefined}>
                        {b.bucket}% · {b.sessions}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            est. gate tokens as pct of billed input · {gateShareHigh} sessions over 20%
          </p>
        </CardContent>
      </Card>

      {families.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>gate blocks by family:</span>
          {families.map(([family, count]) => (
            <a
              key={family}
              href="#/gate"
              className="rounded bg-error/10 px-2 py-0.5 text-foreground transition-colors hover:bg-error/20"
            >
              {family} ×{count}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
