import { Area, AreaChart, ComposedChart } from "recharts";
import { Bar, BarChart, CartesianGrid, Cell, Line, Pie, PieChart, XAxis, YAxis } from "recharts";
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
import type { Snapshot } from "@/types";

const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];


const dayConfig = { cost: { label: "cost $", color: "var(--chart-1)" } } satisfies ChartConfig;
const projectConfig = { cost: { label: "cost $", color: "var(--chart-2)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function OverviewTab({ snapshot }: { snapshot: Snapshot }) {
  const agg = snapshot.aggregates;
  const days = Object.entries(agg.byDay)
    .map(([day, cost]) => ({ day, cost }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-30);
  const projects = agg.byProject.slice(0, 8).map((p) => ({ project: p.project.split("/").pop() || p.project, cost: p.cost }));
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
      if (!toolTotals.has(name)) toolTotals.set(name, { name, calls: 0, cost });
    }
  }
  const tools = [...toolTotals.values()]
    .map((t) => ({ ...t, cost: Number(t.cost.toFixed(4)) }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls)
    .slice(0, 8);
  const avgCost = agg.totals.sessions > 0 ? agg.totals.cost / agg.totals.sessions : 0;
  const fmtDuration = (sec: number) =>
    sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
  const families = Object.entries(agg.blocksByFamily).sort((a, b) => b[1] - a[1]);
  void families;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard icon={Layers} label="sessions" value={String(agg.totals.sessions)} />
        <StatCard icon={MessageSquare} label="turns" value={String(agg.totals.turns)} />
        <StatCard icon={CircleDollarSign} label="total cost" value={`$${agg.totals.cost.toFixed(2)}`} />
        <StatCard icon={Wrench} label="tool calls" value={String(agg.totals.toolCalls)} />
        <StatCard icon={Calculator} label="avg cost / session" value={`$${avgCost.toFixed(3)}`} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatCard icon={Database} label="cache hit rate" value={`${agg.cacheHitRate}%`} />
        <StatCard icon={Brain} label="reasoning share" value={`${agg.reasoningShare}%`} />
        <StatCard icon={Timer} label="avg session length" value={fmtDuration(agg.avgDurationSec)} />
        <StatCard icon={ShieldAlert} label="gate blocks / session" value={String(agg.blocksPerSession)} hint={agg.gate ? `${agg.gate.total} total` : undefined} />
        <StatCard icon={Repeat2} label="repeat calls" value={`${agg.repeatPct}%`} />
        <StatCard icon={Archive} label="compactions" value={String(snapshot.sessions.reduce((n, s) => n + s.compactions, 0))} />
      </div>

      {(agg.alerts?.length ?? 0) > 0 && (
        <Card className="border-chart-5/40">
          <CardHeader>
            <CardTitle className="text-sm">budget alerts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {agg.alerts.map((a) => (
              <Badge
                key={a.sessionId}
                variant={a.level === "over" ? "destructive" : "secondary"}
                className="font-mono text-xs"
              >
                {a.sessionId.slice(0, 8)} · {(a.project.split("/").pop() || a.project)} · ${a.cost.toFixed(2)} / ${a.budget.toFixed(2)} · {a.pct}%
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {families.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>gate blocks by family:</span>
          {families.map(([family, count]) => (
            <span key={family} className="rounded bg-chart-5/15 px-2 py-0.5 text-foreground">
              {family} ×{count}
            </span>
          ))}
        </div>
      )}

      {families.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>gate blocks by family:</span>
          {families.map(([family, count]) => (
            <span key={family} className="rounded bg-chart-5/15 px-2 py-0.5 text-foreground">
              {family} ×{count}
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              cost by day (last 30)
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                today ${agg.spend.today.toFixed(2)} · 7d ${agg.spend.week.toFixed(2)}
                {agg.spend.projectedToday !== null && ` · projected ${agg.spend.projectedToday.toFixed(2)}`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={dayConfig} className="h-56 w-full">
              <AreaChart data={days}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={48} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <Area dataKey="cost" type="monotone" fill="var(--color-cost)" fillOpacity={0.25} stroke="var(--color-cost)" strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">cost by project (top 8)</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={projectConfig} className="h-56 w-full">
              <BarChart data={projects}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="project" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} angle={-18} height={44} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={48} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">model mix (by cost)</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={{}} className="h-56 w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={modelMix} dataKey="cost" nameKey="model" innerRadius={48} strokeWidth={2}>
                  {modelMix.map((entry, index) => (
                    <Cell key={entry.model} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {modelMix.map((m, i) => (
                <span key={m.model} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  {m.model} · ${m.cost.toFixed(2)} · {m.turns}t
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">tool usage (top 8)</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={toolConfig} className="h-56 w-full">
              <ComposedChart data={tools}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} angle={-18} height={44} />
                <YAxis yAxisId="cost" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={48} />
                <YAxis yAxisId="calls" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={36} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar yAxisId="cost" dataKey="cost" fill="var(--color-cost)" radius={4} />
                <Line yAxisId="calls" dataKey="calls" type="monotone" stroke="var(--color-calls)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
