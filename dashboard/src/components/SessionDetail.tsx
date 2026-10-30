import { X } from "lucide-react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtLatency } from "@/lib/format";
import type { SessionDetail } from "@/types";

const tokenConfig = {
  input: { label: "input", color: "var(--chart-1)" },
  output: { label: "output", color: "var(--chart-2)" },
  reasoning: { label: "reasoning", color: "var(--chart-3)" },
  cacheRead: { label: "cache read", color: "var(--chart-4)" },
} satisfies ChartConfig;

const costConfig = { cumulative: { label: "cumulative $", color: "var(--chart-1)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;
const timelineConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "tool calls", color: "var(--chart-3)" },
} satisfies ChartConfig;

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SessionDetailPanel({
  detail,
  onClose,
}: {
  detail: SessionDetail;
  onClose?: () => void;
}) {
  let running = 0;
  const costCurve = detail.turns.map((t) => {
    running += t.cost;
    return { turn: t.i, cumulative: Number(running.toFixed(6)) };
  });
  const tokens = detail.turns.map((t) => ({
    turn: t.i,
    input: t.input,
    output: t.output,
    reasoning: t.reasoning,
    cacheRead: t.cacheRead,
  }));
  const toolCounts = new Map<string, number>();
  for (const c of detail.calls) toolCounts.set(c.name, (toolCounts.get(c.name) ?? 0) + 1);
  const tools = [...toolCounts.entries()]
    .map(([name, calls]) => ({ name, calls, cost: Number((detail.summary.toolCosts?.[name] ?? 0).toFixed(4)) }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const skills = Object.entries(detail.skills);
  const timeline = (detail.timeline ?? []).map((b) => ({
    time: new Date(b.start).toISOString().slice(11, 16),
    cost: b.cost,
    calls: b.calls,
  }));
  const subagents =
    detail.subagents ?? { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] };
  const spawns = detail.subagentSpawns ?? [];
  const prompts = detail.prompts ?? [];

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="shrink-0">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span className="break-all">{detail.project}</span>
          <span className="font-mono text-xs text-muted-foreground">{detail.sessionId}</span>
          {detail.summary.models.map((m) => (
            <Badge key={m} variant="secondary">{m}</Badge>
          ))}
          {detail.compactions > 0 && (
            <Badge variant="outline">{detail.compactions} compaction{detail.compactions > 1 ? "s" : ""}</Badge>
          )}
          <Badge variant="secondary">cache {detail.summary.cacheHitRate}%</Badge>
          <Badge variant="secondary">
            {detail.summary.durationSec >= 3600
              ? `${(detail.summary.durationSec / 3600).toFixed(1)}h`
              : `${Math.round(detail.summary.durationSec / 60)}m`}
          </Badge>
          <Badge variant="secondary">{detail.summary.tokensPerTurn.toLocaleString()} tok/turn</Badge>
          <Badge variant="secondary">${detail.summary.avgTurnCost.toFixed(4)}/turn</Badge>
          {detail.summary.agent.repeatWithoutChange > 0 && (
            <Badge variant="outline">{detail.summary.agent.repeatWithoutChange} repeats</Badge>
          )}
          {detail.summary.agent.maxFailureStreak > 1 && (
            <Badge variant="outline">max streak {detail.summary.agent.maxFailureStreak}</Badge>
          )}
          {detail.summary.agent.blocks > 0 && (
            <Badge variant="outline">{detail.summary.agent.blocks} blocks</Badge>
          )}
          {onClose && (
            <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={onClose} aria-label="close detail">
              <X className="size-4" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <Tabs defaultValue="charts" className="flex h-full flex-col">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="charts">charts</TabsTrigger>
            <TabsTrigger value="timeline">timeline</TabsTrigger>
            <TabsTrigger value="tools">tools</TabsTrigger>
            <TabsTrigger value="calls">calls</TabsTrigger>
            <TabsTrigger value="prompts">prompts ({prompts.length})</TabsTrigger>
            <TabsTrigger value="subagents">subagents</TabsTrigger>
          </TabsList>

          <TabsContent value="charts" className="mt-3 min-h-0 flex-1">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">cumulative cost per turn</div>
                <ChartContainer config={costConfig} className="h-44 w-full">
                  <LineChart data={costCurve}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="turn" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52} />
                    <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                    <Line dataKey="cumulative" type="monotone" stroke="var(--color-cumulative)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartContainer>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">tokens per turn</div>
                <ChartContainer config={tokenConfig} className="h-44 w-full">
                  <AreaChart data={tokens}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="turn" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52} />
                    <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                    {(["input", "output", "reasoning", "cacheRead"] as const).map((key) => (
                      <Area
                        key={key}
                        dataKey={key}
                        type="monotone"
                        stackId="t"
                        fill={`var(--color-${key})`}
                        fillOpacity={0.3}
                        stroke={`var(--color-${key})`}
                        strokeWidth={1.5}
                      />
                    ))}
                  </AreaChart>
                </ChartContainer>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="timeline" className="mt-3 min-h-0 flex-1">
            {timeline.length === 0 ? (
              <div className="text-xs text-muted-foreground">no timestamped activity</div>
            ) : (
              <ChartContainer config={timelineConfig} className="h-56 w-full">
                <ComposedChart data={timeline}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="cost" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52} />
                  <YAxis yAxisId="calls" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={36} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar yAxisId="cost" dataKey="cost" fill="var(--color-cost)" radius={3} />
                  <Line yAxisId="calls" dataKey="calls" type="monotone" stroke="var(--color-calls)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ChartContainer>
            )}
          </TabsContent>

          <TabsContent value="tools" className="mt-3 min-h-0 flex-1">
            <div className="grid gap-4 lg:grid-cols-[minmax(200px,1fr)_minmax(220px,1fr)]">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">tool calls</div>
                {tools.length === 0 ? (
                  <div className="text-xs text-muted-foreground">none</div>
                ) : (
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
                )}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">skills loaded</div>
                {skills.length === 0 ? (
                  <div className="text-xs text-muted-foreground">none</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {skills.map(([name, count]) => (
                      <Badge key={name} variant="outline">{name}×{count}</Badge>
                    ))}
                  </div>
                )}
                <div className="mb-1 mt-4 text-xs text-muted-foreground">tokens by model</div>
                <div className="space-y-1">
                  {Object.entries(detail.usageByModel).map(([model, u]) => (
                    <div key={model} className="flex justify-between text-xs">
                      <span className="font-mono">{model}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {u.turns} turns · ${u.costTotal.toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="calls" className="mt-3 min-h-0 flex-1">
            <div className="mb-1 text-xs text-muted-foreground">
              call log — {detail.calls.length} calls
            </div>
            <ScrollArea className="h-64 rounded border">
              <Table>
                <TableBody>
                  {detail.calls.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{c.name}</TableCell>
                      <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={c.cmd ?? c.path ?? ""}>
                        {c.cmd ?? c.path ?? ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {c.ts ? c.ts.slice(11, 19) : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="prompts" className="mt-3 min-h-0 flex-1">
            {prompts.length === 0 ? (
              <div className="text-xs text-muted-foreground">no user prompts recorded</div>
            ) : (
              <ScrollArea className="h-64 rounded border">
                <div className="divide-y">
                  {prompts.map((p, i) => (
                    <div key={i} className="flex gap-3 p-2">
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {p.ts ? p.ts.slice(11, 19) : "--:--:--"}
                      </span>
                      <span className="text-xs">{p.preview}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="subagents" className="mt-3 min-h-0 flex-1">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <MiniStat label="spawns" value={String(subagents.spawns)} />
              <MiniStat label="messages" value={String(subagents.messages)} />
              <MiniStat label="lists" value={String(subagents.lists)} />
              <MiniStat label="errors" value={String(subagents.errors)} />
              <MiniStat label="avg latency" value={fmtLatency(subagents.avgLatencyMs)} />
            </div>
            {(subagents.byAgent ?? []).length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted-foreground">per agent</div>
                <ScrollArea className="h-36 rounded border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">agent</TableHead>
                        <TableHead scope="col" className="text-right">spawns</TableHead>
                        <TableHead scope="col" className="text-right">messages</TableHead>
                        <TableHead scope="col" className="text-right">errors</TableHead>
                        <TableHead scope="col" className="text-right">avg latency</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(subagents.byAgent ?? []).map((a) => (
                        <TableRow key={a.agent}>
                          <TableCell className="font-mono text-xs">{a.agent}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.spawns}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.messages}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.errors}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtLatency(a.avgLatencyMs)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            )}
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted-foreground">spawns — {spawns.length}</div>
              {spawns.length > 0 ? (
                <ScrollArea className="h-36 rounded border">
                  <Table>
                    <TableBody>
                      {spawns.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                            {s.ts ? s.ts.slice(11, 19) : "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{s.agent}</TableCell>
                          <TableCell className="font-mono text-xs">{s.name ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              ) : (
                <div className="text-xs text-muted-foreground">no subagents spawned in this session</div>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Derived from subagent, subagent_message and subagents_list tool calls joined with their
              results and raw spawn arguments.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
