import { X } from "lucide-react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts";
import { errorRate, errorRateLabel } from "@/components/SubagentsTab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { sortedSkillRows } from "@/lib/burn";
import { fmtLatency, fmtMoney } from "@/lib/format";
import type { SessionDetail } from "@/types";

/** Token counts are one meaning — one hue, depth by opacity. */
const tokenConfig = {
  input: { label: "input", color: "var(--chart-3)" },
  output: { label: "output", color: "var(--chart-3)" },
  reasoning: { label: "reasoning", color: "var(--chart-3)" },
  cacheRead: { label: "cache read", color: "var(--chart-3)" },
} satisfies ChartConfig;
const TOKEN_FILL = { input: 0.5, output: 0.38, reasoning: 0.26, cacheRead: 0.15 } as const;

const costConfig = { cumulative: { label: "cumulative $", color: "var(--chart-1)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;
const timelineConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "tool calls", color: "var(--chart-3)" },
} satisfies ChartConfig;

function MiniStat({ label, value, error }: { label: string; value: string; error?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`truncate text-sm font-semibold tabular-nums ${error ? "text-error-foreground" : ""}`}
      >
        {value}
      </div>
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
  const skillRows = sortedSkillRows(detail.skills);
  const skillUses = skillRows.reduce((sum, [, uses]) => sum + uses, 0);
  const timeline = (detail.timeline ?? []).map((b) => ({
    time: new Date(b.start).toISOString().slice(11, 16),
    cost: b.cost,
    calls: b.calls,
  }));
  const subagents =
    detail.subagents ?? { spawns: 0, messages: 0, lists: 0, errors: 0, avgLatencyMs: 0, byAgent: [] };
  const spawns = detail.subagentSpawns ?? [];
  const prompts = detail.prompts ?? [];
  const gate = detail.summary.agent;
  const gateFamilies = Object.entries(gate.blocksByFamily ?? {}).sort((a, b) => b[1] - a[1]);
  const gateTagList = Object.entries(detail.summary.gateTags ?? {}).sort(
    (a, b) => b[1].block + b[1].warn - (a[1].block + a[1].warn),
  );
  const gateTools = Object.entries(detail.summary.blocksByTool ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="shrink-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold break-all">{detail.project}</span>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{detail.sessionId}</span>
          {onClose && (
            <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={onClose} aria-label="close detail">
              <X className="size-4" />
            </Button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{detail.summary.models.join(" + ")}</span>
          <span>
            {detail.summary.durationSec >= 3600
              ? `${(detail.summary.durationSec / 3600).toFixed(1)}h`
              : `${Math.round(detail.summary.durationSec / 60)}m`}
          </span>
          <span>{detail.summary.turns} turns</span>
          <span>{fmtMoney(detail.summary.cost, 2)} total</span>
          <span>cache {detail.summary.cacheHitRate}%</span>
        </div>
        {(detail.compactions > 0 ||
          detail.summary.agent.maxFailureStreak > 1 ||
          detail.summary.agent.blocks > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {detail.compactions > 0 && (
              <Badge variant="outline">{detail.compactions} compaction{detail.compactions > 1 ? "s" : ""}</Badge>
            )}
            {detail.summary.agent.maxFailureStreak > 1 && (
              <Badge variant="outline">max streak {detail.summary.agent.maxFailureStreak}</Badge>
            )}
            {detail.summary.agent.blocks > 0 && (
              <Badge variant="outline">{detail.summary.agent.blocks} blocks</Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <Tabs defaultValue="charts" className="flex h-full flex-col">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="charts">charts</TabsTrigger>
            <TabsTrigger value="timeline">timeline</TabsTrigger>
            <TabsTrigger value="tools">tools</TabsTrigger>
            <TabsTrigger value="calls">calls</TabsTrigger>
            <TabsTrigger value="skills">skills</TabsTrigger>
            <TabsTrigger value="prompts">prompts ({prompts.length})</TabsTrigger>
            <TabsTrigger value="subagents">subagents</TabsTrigger>
            <TabsTrigger value="gate">gate</TabsTrigger>
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
                        fillOpacity={TOKEN_FILL[key]}
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
                <div className="mb-1 text-xs text-muted-foreground">tokens by model</div>
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

          <TabsContent value="skills" className="mt-3 min-h-0 flex-1">
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="skills used" value={String(skillRows.length)} />
              <MiniStat label="total uses" value={String(skillUses)} />
              <MiniStat label="compactions" value={String(detail.compactions)} />
            </div>
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted-foreground">skill usage — uses</div>
              {skillRows.length === 0 ? (
                <div className="text-xs text-muted-foreground">no skills recorded in this session</div>
              ) : (
                <ScrollArea className="h-36 rounded border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">skill</TableHead>
                        <TableHead scope="col" className="text-right">uses</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {skillRows.map(([name, uses]) => (
                        <TableRow key={name}>
                          <TableCell className="font-mono text-xs">{name}</TableCell>
                          <TableCell className="text-right tabular-nums">{uses}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </div>
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

          <TabsContent value="gate" className="mt-3 min-h-0 flex-1">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <MiniStat label="blocks" value={String(gate.blocks)} />
              <MiniStat label="repeat w/o change" value={String(gate.repeatWithoutChange)} />
              <MiniStat label="failure streak calls" value={String(gate.failureStreakCalls)} />
              <MiniStat label="max streak" value={String(gate.maxFailureStreak)} />
              <MiniStat label="gate token share" value={`${gate.gateTokenSharePct}%`} />
            </div>
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted-foreground">blocks by family</div>
              {gateFamilies.length === 0 ? (
                <div className="text-xs text-muted-foreground">no gate activity in this session</div>
              ) : (
                <div className="space-y-1">
                  {gateFamilies.map(([fam, n]) => (
                    <div key={fam} className="flex justify-between text-xs">
                      <span className="font-mono">{fam}</span>
                      <span className="tabular-nums text-muted-foreground">{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">gate tags — blocks · warns</div>
                {gateTagList.length === 0 ? (
                  <div className="text-xs text-muted-foreground">no gate tags in this session</div>
                ) : (
                  <div className="space-y-1">
                    {gateTagList.map(([tag, c]) => (
                      <div key={tag} className="flex justify-between text-xs">
                        <span className="font-mono">{tag}</span>
                        <span className="tabular-nums text-muted-foreground">{c.block} · {c.warn}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">blocks by tool</div>
                {gateTools.length === 0 ? (
                  <div className="text-xs text-muted-foreground">no blocked tools</div>
                ) : (
                  <div className="space-y-1">
                    {gateTools.map(([tool, n]) => (
                      <div key={tool} className="flex justify-between text-xs">
                        <span className="font-mono">{tool}</span>
                        <span className="tabular-nums text-muted-foreground">{n}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="subagents" className="mt-3 min-h-0 flex-1">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <MiniStat label="spawns" value={String(subagents.spawns)} />
              <MiniStat label="messages" value={String(subagents.messages)} />
              <MiniStat label="lists" value={String(subagents.lists)} />
              <MiniStat label="errors" value={String(subagents.errors)} error={subagents.errors > 0} />
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
                        <TableHead scope="col" className="text-right">error rate</TableHead>
                        <TableHead scope="col" className="text-right">avg latency</TableHead>
                        <TableHead scope="col" className="text-right">p50 · p95</TableHead>
                        <TableHead scope="col" className="text-right">spawn lag</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(subagents.byAgent ?? []).map((a) => {
                        const rate = errorRate(a.errors, a.messages);
                        return (
                          <TableRow key={a.agent}>
                            <TableCell className="font-mono text-xs">{a.agent}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.spawns}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.messages}</TableCell>
                            <TableCell
                              className={`text-right tabular-nums ${a.errors > 0 ? "text-error-foreground" : ""}`}
                            >
                              {a.errors}
                            </TableCell>
                            <TableCell
                              className={`text-right tabular-nums ${rate !== null && rate > 0 ? "text-error-foreground" : ""}`}
                            >
                              {errorRateLabel(a.errors, a.messages)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmtLatency(a.avgLatencyMs)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {a.p50LatencyMs != null
                                ? `${fmtLatency(a.p50LatencyMs)} · ${fmtLatency(a.p95LatencyMs ?? a.p50LatencyMs)}`
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {a.spawnToFirstMsgMs != null ? fmtLatency(a.spawnToFirstMsgMs) : "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
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
