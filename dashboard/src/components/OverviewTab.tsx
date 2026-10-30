import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  Archive,
  Brain,
  Calculator,
  CircleDollarSign,
  Database,
  Layers,
  MessageSquare,
  Repeat2,
  ShieldAlert,
  Timer,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/StatCard";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { fmtCount, fmtDuration, fmtMoney, basename } from "@/lib/format";
import type { Snapshot } from "@/types";

const dayConfig = { cost: { label: "cost", color: "var(--chart-1)" } } satisfies ChartConfig;
const projectConfig = { cost: { label: "cost", color: "var(--chart-2)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;
const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const money = (v: number) => (v >= 1 ? fmtMoney(v) : `$${v.toFixed(2)}`);

export function OverviewTab({ snapshot }: { snapshot: Snapshot }) {
  const agg = snapshot.aggregates;
  const days = Object.entries(agg.byDay)
    .map(([day, cost]) => ({ day, cost }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-30);
  const projects = agg.byProject
    .slice(0, 8)
    .map((p) => ({ project: basename(p.project), cost: p.cost }));
  const modelMix = agg.modelMix.slice(0, 5);
  const toolTotals = new Map<string, { name: string; calls: number; cost: number }>();
  for (const s of snapshot.sessions) {
    for (const [name, count] of Object.entries(s.tools)) {
      const t = toolTotals.get(name) ?? { name, calls: 0, cost: 0 };
      t.calls += count;
      t.cost += s.toolCosts?.[name] ?? 0;
      toolTotals.set(name, t);
    }
    for (const [name, cost] of Object.entries(s.toolCosts ?? {})) {
      if (!toolTotals.has(name)) toolTotals.set(name, { name, calls: 0, cost: 0 });
      toolTotals.get(name)!.cost += cost;
    }
  }
  const tools = [...toolTotals.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls).slice(0, 10);
  const families = Object.entries(agg.gate?.byFamily ?? {}).sort((a, b) => b[1] - a[1]);
  const alerts = agg.alerts ?? [];
  const over = alerts.filter((a) => a.level === "over");
  const near = alerts.filter((a) => a.level !== "over");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard icon={Layers} label="sessions" value={fmtCount(agg.totals.sessions)} />
        <StatCard icon={MessageSquare} label="turns" value={fmtCount(agg.totals.turns)} />
        <StatCard icon={CircleDollarSign} label="total cost" value={fmtMoney(agg.totals.cost)} />
        <StatCard icon={Wrench} label="tool calls" value={fmtCount(agg.totals.toolCalls)} />
        <StatCard
          icon={Calculator}
          label="avg cost / session"
          value={fmtMoney(agg.totals.sessions ? agg.totals.cost / agg.totals.sessions : 0, 3)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard icon={Database} label="cache hit rate" value={`${agg.cacheHitRate}%`} />
        <StatCard icon={Brain} label="reasoning share" value={`${agg.reasoningShare}%`} />
        <StatCard icon={Timer} label="avg session length" value={fmtDuration(agg.avgDurationSec)} />
        <StatCard
          icon={ShieldAlert}
          label="gate blocks / session"
          value={String(agg.blocksPerSession)}
          hint={agg.gate ? `${agg.gate.total} total` : undefined}
        />
        <StatCard icon={Repeat2} label="repeat calls" value={`${agg.repeatPct}%`} />
        <StatCard
          icon={Archive}
          label="compactions"
          value={String(snapshot.sessions.reduce((n, s) => n + s.compactions, 0))}
        />
      </div>

      {alerts.length > 0 && (
        <Card
          className={
            over.length > 0 ? "border-destructive/40" : "border-amber-500/40"
          }
        >
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
              >
                {a.sessionId.slice(0, 8)} · {basename(a.project)} · {fmtMoney(a.cost)} /{" "}
                {fmtMoney(a.budget)} · {a.pct}%
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
                last 30 days · today {fmtMoney(agg.spend.today)} · 7d{" "}
                {fmtMoney(agg.spend.week)}
                {agg.spend.projectedToday !== null &&
                  ` · projected today ${fmtMoney(agg.spend.projectedToday)}`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={dayConfig} className="h-56 w-full">
              <AreaChart data={days}>
                <defs>
                  <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-cost)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--color-cost)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
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
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <Area
                  dataKey="cost"
                  type="monotone"
                  fill="url(#fillCost)"
                  stroke="var(--color-cost)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">model mix (by cost)</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={Object.fromEntries(
                modelMix.map((m, i) => [m.model, { label: m.model, color: PIE_COLORS[i % PIE_COLORS.length] }]),
              )}
              className="h-56 w-full"
            >
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={modelMix} dataKey="cost" nameKey="model" innerRadius={48} strokeWidth={2}>
                  {modelMix.map((entry, index) => (
                    <Cell key={entry.model} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {modelMix.map((m, i) => (
                <li key={m.model} className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
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

      {families.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>gate blocks by family:</span>
          {families.map(([family, count]) => (
            <a
              key={family}
              href="#/gate"
              className="rounded bg-chart-5/15 px-2 py-0.5 text-foreground transition-colors hover:bg-chart-5/25"
            >
              {family} ×{count}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
