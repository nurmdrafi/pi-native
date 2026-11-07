import { Fragment, useState } from "react";
import { ArrowDown, ArrowUpDown, ChevronDown, ChevronRight, X } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts";
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
import { cacheCostAudit } from "@/lib/cache-cost";
import { basename, fmtCount, fmtLatency, fmtMoney } from "@/lib/format";
import type { SessionDetail } from "@/types";
import type {
  DetailWithLineage,
  PromptWithText,
  SessionLineage,
  TurnWithDuration,
} from "@/types-feeds";

/** Each token series is its own meaning, so each carries its own ramp hue:
 * input chart-1 (primary volume), output chart-2 (secondary series),
 * reasoning chart-4 (model mix), cache read chart-3 (raw counts). The cache
 * family keeps one hue — cache write rides chart-3 at a lower fill opacity —
 * and the turn total overlays chart-1 as a dashed line instead of stacking
 * (it already contains the buckets). chart-5 stays reserved for blocks — red
 * must never read as a token error. */
const tokenConfig = {
  input: { label: "input", color: "var(--chart-1)" },
  output: { label: "output", color: "var(--chart-2)" },
  reasoning: { label: "reasoning", color: "var(--chart-4)" },
  cacheRead: { label: "cache read", color: "var(--chart-3)" },
  cacheWrite: { label: "cache write", color: "var(--chart-3)" },
  totalTokens: { label: "total", color: "var(--chart-1)" },
} satisfies ChartConfig;
/** One shared depth: the hues separate the stacks, opacity only quiets them. */
const TOKEN_FILL_OPACITY = 0.72;
/** The cache-write bucket sits under the same hue as cache read, so a lower
 * fill keeps the two buckets readable when they stack. */
const CACHE_WRITE_FILL_OPACITY = 0.45;
/** Stacked buckets; the turn total is deliberately not among them. */
const STACKED_TOKEN_KEYS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

const costConfig = { cumulative: { label: "cumulative $", color: "var(--chart-1)" } } satisfies ChartConfig;
const toolConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "calls", color: "var(--chart-3)" },
} satisfies ChartConfig;
const timelineConfig = {
  cost: { label: "cost ($)", color: "var(--chart-1)" },
  calls: { label: "tool calls", color: "var(--chart-3)" },
} satisfies ChartConfig;

/** A parent or child reference in the lineage line: a real link when the
 * host provides a handler, plain monospace text otherwise. */
function LineageLink({
  name,
  sessionId,
  onOpenSession,
}: {
  name: string | null;
  sessionId: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const short = sessionId.slice(0, 8);
  const label = name ? `${name} (${short})` : short;
  return onOpenSession ? (
    <button
      type="button"
      onClick={() => onOpenSession(sessionId)}
      title={`open ${sessionId}`}
      className="rounded-sm font-mono text-[11px] text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {label}
    </button>
  ) : (
    <span className="font-mono text-[11px]" title={sessionId}>
      {label}
    </span>
  );
}

/** The header lineage line: "child of <parent>" when this session was
 * spawned, "spawned n: <children>" when it spawned — from the registry join
 * the detail endpoint attaches. Hidden when the join found neither. */
function LineageRow({
  lineage,
  onOpenSession,
}: {
  lineage: SessionLineage;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span>lineage</span>
      {lineage.parent && (
        <>
          <span>child of</span>
          <LineageLink
            name={lineage.parent.name}
            sessionId={lineage.parent.sessionId}
            onOpenSession={onOpenSession}
          />
        </>
      )}
      {lineage.parent && lineage.children.length > 0 && <span aria-hidden>·</span>}
      {lineage.children.length > 0 && (
        <>
          <span>spawned {lineage.children.length}:</span>
          {lineage.children.map((c, i) => (
            <Fragment key={`${c.sessionId}-${i}`}>
              {i > 0 && <span aria-hidden>,</span>}
              <LineageLink name={c.name} sessionId={c.sessionId} onOpenSession={onOpenSession} />
            </Fragment>
          ))}
        </>
      )}
    </div>
  );
}

/** Turn-chart tooltip label: names the turn and appends its wall-clock
 * duration only when the raw-file join produced one — absent stays silent
 * rather than showing a fake 0s. */
function turnTooltipLabel(
  label: unknown,
  payload: ReadonlyArray<{ payload?: { turn?: number; durationMs?: number } }>,
) {
  const point = payload?.[0]?.payload;
  if (!point) return label == null ? "" : String(label);
  const dur = point.durationMs != null ? ` · ${fmtLatency(point.durationMs)}` : "";
  return `turn ${point.turn ?? label}${dur}`;
}

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
  onOpenSession,
}: {
  detail: SessionDetail;
  onClose?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  // Calls tab: cost column sorts desc-first (expensive calls surface first);
  // the toggle flips to ascending. Order resets per session.
  const [callsSort, setCallsSort] = useState<"desc" | "asc">("desc");
  // Prompts tab: one disclosure per prompt — the row shows the preview, the
  // expanded body the full text (falling back to the preview when the raw
  // read missed and only the extract preview shipped).
  const [openPrompts, setOpenPrompts] = useState<Set<number>>(() => new Set());
  const togglePrompt = (i: number) =>
    setOpenPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const sortedCalls = [...detail.calls].sort((a, b) =>
    callsSort === "desc" ? b.cost - a.cost : a.cost - b.cost,
  );

  let running = 0;
  const turns = detail.turns as TurnWithDuration[];
  const costCurve = turns.map((t) => {
    running += t.cost;
    return {
      turn: t.i,
      cumulative: Number(running.toFixed(6)),
      ...(t.durationMs != null && { durationMs: t.durationMs }),
    };
  });
  const tokens = turns.map((t) => ({
    turn: t.i,
    input: t.input,
    output: t.output,
    reasoning: t.reasoning,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    totalTokens: t.totalTokens,
  }));
  const cacheAudit = cacheCostAudit(detail.turns);
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
  const prompts = (detail.prompts ?? []) as PromptWithText[];
  const lineage = (detail as DetailWithLineage).lineage;
  const gate = detail.summary.agent;
  const gateFamilies = Object.entries(gate.blocksByFamily ?? {}).sort((a, b) => b[1] - a[1]);
  const gateTagList = Object.entries(detail.summary.gateTags ?? {}).sort(
    (a, b) => b[1].block + b[1].warn - (a[1].block + a[1].warn),
  );
  const gateTools = Object.entries(detail.summary.blocksByTool ?? {}).sort((a, b) => b[1] - a[1]);
  const isSubagent = detail.summary.kind === "subagent";
  const parentName = detail.summary.parentSession ? basename(detail.summary.parentSession) : null;

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
          {cacheAudit.refreshes > 0 && (
            <span title="prompt-prefix refreshes billed at the cache-write rate">
              {cacheAudit.refreshes} cache refresh{cacheAudit.refreshes > 1 ? "es" : ""}
            </span>
          )}
          {cacheAudit.misses > 0 && (
            <span title="approximate tokens re-billed uncached across cache misses">
              {cacheAudit.misses} cache miss{cacheAudit.misses > 1 ? "es" : ""} · {fmtCount(cacheAudit.missTokens)} re-billed
            </span>
          )}
          {typeof detail.summary.tokensPerTurn === "number" && detail.summary.tokensPerTurn > 0 && (
            <span>{fmtCount(detail.summary.tokensPerTurn)} tokens/turn</span>
          )}
          {typeof detail.summary.avgTurnCost === "number" && detail.summary.avgTurnCost > 0 && (
            <span>{fmtMoney(detail.summary.avgTurnCost, 4)}/turn</span>
          )}
        </div>
        {lineage && (lineage.parent || lineage.children.length > 0) && (
          <LineageRow lineage={lineage} onOpenSession={onOpenSession} />
        )}
        {(isSubagent ||
          detail.compactions > 0 ||
          detail.summary.agent.maxFailureStreak > 1 ||
          detail.summary.agent.blocks > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {isSubagent && (
              <Badge
                variant="outline"
                className="gap-1.5 border py-0 text-[11px] font-medium border-border bg-muted text-muted-foreground"
                title={parentName ? `subagent of ${parentName}` : undefined}
              >
                <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
                subagent
              </Badge>
            )}
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
            <TabsTrigger value="charts">charts ({detail.turns.length})</TabsTrigger>
            <TabsTrigger value="timeline">timeline ({timeline.length})</TabsTrigger>
            <TabsTrigger value="tools">tools ({tools.length})</TabsTrigger>
            <TabsTrigger value="calls">calls ({detail.calls.length})</TabsTrigger>
            <TabsTrigger value="skills">skills ({skillRows.length})</TabsTrigger>
            <TabsTrigger value="prompts">prompts ({prompts.length})</TabsTrigger>
            {!isSubagent && (
              <TabsTrigger value="subagents">subagents ({subagents.spawns})</TabsTrigger>
            )}
            <TabsTrigger value="gate">gate ({gate.blocks})</TabsTrigger>
            <TabsTrigger value="audit">audit ({cacheAudit.lines.length})</TabsTrigger>
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
                    <ChartTooltip
                      content={
                        <ChartTooltipContent indicator="line" labelFormatter={turnTooltipLabel} />
                      }
                    />
                    <Line dataKey="cumulative" type="monotone" stroke="var(--color-cumulative)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartContainer>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">tokens per turn</div>
                <ChartContainer config={tokenConfig} className="h-44 w-full">
                  <ComposedChart data={tokens}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="turn" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52} />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent indicator="line" labelFormatter={turnTooltipLabel} />
                      }
                    />
                    {STACKED_TOKEN_KEYS.map((key) => (
                      <Area
                        key={key}
                        dataKey={key}
                        type="monotone"
                        stackId="t"
                        fill={`var(--color-${key})`}
                        fillOpacity={key === "cacheWrite" ? CACHE_WRITE_FILL_OPACITY : TOKEN_FILL_OPACITY}
                        stroke={`var(--color-${key})`}
                        strokeWidth={1.5}
                      />
                    ))}
                    <Line
                      dataKey="totalTokens"
                      type="monotone"
                      stroke="var(--color-totalTokens)"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={false}
                    />
                  </ComposedChart>
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
                <TableHeader>
                  <TableRow>
                    <TableHead className="font-medium">tool</TableHead>
                    <TableHead className="font-medium">command</TableHead>
                    <TableHead className="font-medium">time</TableHead>
                    <TableHead className="font-medium" aria-sort={callsSort === "desc" ? "descending" : "ascending"}>
                      <button
                        type="button"
                        onClick={() => setCallsSort(callsSort === "desc" ? "asc" : "desc")}
                        className="inline-flex items-center gap-1 text-xs hover:text-foreground"
                      >
                        cost
                        {callsSort === "desc" ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ArrowUpDown className="size-3" aria-hidden />
                        )}
                      </button>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedCalls.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{c.name}</TableCell>
                      <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={c.cmd ?? c.path ?? ""}>
                        {c.cmd ?? c.path ?? ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {c.ts ? c.ts.slice(11, 19) : ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                        {c.cost != null ? fmtMoney(c.cost, 4) : "—"}
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
                  {prompts.map((p, i) => {
                    const open = openPrompts.has(i);
                    const full = (p.text && p.text.trim()) || p.preview;
                    return (
                      <div key={i}>
                        <button
                          type="button"
                          onClick={() => togglePrompt(i)}
                          aria-expanded={open}
                          className="flex w-full items-start gap-2 p-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {p.ts ? p.ts.slice(11, 19) : "--:--:--"}
                          </span>
                          {open ? (
                            <ChevronDown className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs">{p.preview}</span>
                        </button>
                        {open && (
                          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                            {full}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="gate" className="mt-3 min-h-0 flex-1">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <MiniStat label="blocks" value={String(gate.blocks)} error={gate.blocks > 0} />
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

          <TabsContent value="audit" className="mt-3 min-h-0 flex-1">
            <div className="mb-1 text-xs text-muted-foreground">
              cache-cost audit trail — refresh warnings · miss notices
            </div>
            {cacheAudit.lines.length === 0 ? (
              <div className="text-xs text-muted-foreground">no cache-cost events in this session</div>
            ) : (
              <ScrollArea className="h-44 rounded border">
                <div className="space-y-1 p-2">
                  {cacheAudit.lines.map((l) => (
                    <div
                      key={`${l.level}-${l.turn}`}
                      className={`font-mono text-xs ${
                        l.level === "warn" ? "text-warn-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {l.text}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          {!isSubagent && (
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
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}
