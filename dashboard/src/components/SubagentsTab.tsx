import { Fragment, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Percent,
  Timer,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatCard } from "@/components/StatCard";
import { basename, fmtCount, fmtLatency, fmtMoney } from "@/lib/format";
import type { Snapshot } from "@/types";

/* subagent-helpers:begin — pure, dependency-free functions. Extracted
 * verbatim by dashboard/tests/subagents.test.mjs and executed there under
 * node's built-in type stripping, so keep this block free of runtime
 * imports, JSX and side effects. */
import type { AgentBreakdown, SessionSummary } from "../types";

/** Share of routed messages that errored, as a 0..1 ratio. Null when no
 * messages were routed: an undefined rate, not a zero one. */
export function errorRate(errors: number, messages: number): number | null {
  return messages > 0 ? errors / messages : null;
}

/** errorRate as display copy: one decimal under 10%, none at or above,
 * "-" when the rate is undefined. */
export function errorRateLabel(errors: number, messages: number): string {
  const r = errorRate(errors, messages);
  if (r === null) return "-";
  const pct = Math.round(r * 1000) / 10;
  const digits = pct >= 10 || Number.isInteger(pct) ? 0 : 1;
  return `${pct.toFixed(digits)}%`;
}

export type AgentSortKey =
  | "agent"
  | "spawns"
  | "messages"
  | "errors"
  | "errorRate"
  | "avgLatencyMs"
  | "p95LatencyMs"
  | "spawnToFirstMsgMs";

/** Sort per-agent rows for a key and direction, returning a new array. A
 * null error rate (no messages) sorts as 0, so defined rates rank above
 * it in descending order. Optional metrics absent on a row also sort as 0. */
export function sortAgentRows(
  rows: AgentBreakdown[],
  key: AgentSortKey,
  dir: "asc" | "desc",
): AgentBreakdown[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === "agent") return a.agent.localeCompare(b.agent) * sign;
    const av = key === "errorRate" ? (errorRate(a.errors, a.messages) ?? 0) : (a[key] ?? 0);
    const bv = key === "errorRate" ? (errorRate(b.errors, b.messages) ?? 0) : (b[key] ?? 0);
    return (av - bv) * sign;
  });
}

/** One session that used a given agent, with that session's counts and
 * latency detail for the agent, plus the session's total cost. */
export type AgentSessionRow = {
  sessionId: string;
  project: string;
  spawns: number;
  messages: number;
  errors: number;
  avgLatencyMs: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  spawnToFirstMsgMs?: number;
  cost: number;
};

/** Sessions that used `agent`, busiest first, each with that session's
 * spawns, messages, errors and latency detail for the agent plus the
 * session's total cost. Pure projection of the snapshot. */
export function sessionsForAgent(
  sessions: SessionSummary[],
  agent: string,
): AgentSessionRow[] {
  const out: AgentSessionRow[] = [];
  for (const s of sessions) {
    const b = (s.subagents.byAgent ?? []).find((x) => x.agent === agent);
    if (!b) continue;
    out.push({
      sessionId: s.sessionId,
      project: s.project,
      spawns: b.spawns,
      messages: b.messages,
      errors: b.errors,
      avgLatencyMs: b.avgLatencyMs,
      p50LatencyMs: b.p50LatencyMs,
      p95LatencyMs: b.p95LatencyMs,
      spawnToFirstMsgMs: b.spawnToFirstMsgMs,
      cost: s.cost,
    });
  }
  return out.sort((a, b) => b.spawns + b.messages - (a.spawns + a.messages));
}
/* subagent-helpers:end */

const projectConfig = {
  spawns: { label: "spawns", color: "var(--chart-3)" },
  messages: { label: "messages", color: "var(--chart-3)" },
} satisfies ChartConfig;

const timelineConfig = {
  spawns: { label: "spawns", color: "var(--chart-3)" },
} satisfies ChartConfig;

type AgentSort = { key: AgentSortKey; dir: "asc" | "desc" };

function AgentSortHead({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: AgentSortKey;
  sort: AgentSort;
  onSort: (k: AgentSortKey) => void;
  className?: string;
}) {
  const Icon = sort.key === sortKey ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 text-inherit transition-colors hover:text-foreground ${
          sort.key === sortKey ? "text-foreground" : ""
        }`}
        aria-label={`sort by ${label}`}
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </TableHead>
  );
}

/** Optional drill-in: opens the session detail dialog for the given session. */
type OpenSession = (sessionId: string) => void;

/** Session-id cell content: plain text, or a keyboard-focusable button that
 * opens the session detail when a handler is wired. Same truncated id either
 * way; inherits the cell's font-mono text-xs. */
function SessionIdButton({ id, onOpenSession }: { id: string; onOpenSession?: OpenSession }) {
  if (!onOpenSession) return <>{id.slice(0, 14)}</>;
  return (
    <button
      type="button"
      onClick={() => onOpenSession(id)}
      aria-label={`open session ${id}`}
      className="cursor-pointer underline-offset-2 hover:underline"
    >
      {id.slice(0, 14)}
    </button>
  );
}

function AgentSessionList({
  sessions,
  agent,
  onOpenSession,
}: {
  sessions: Snapshot["sessions"];
  agent: string;
  onOpenSession?: OpenSession;
}) {
  const rows = sessionsForAgent(sessions, agent);
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground">no sessions recorded for this agent</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">session</TableHead>
          <TableHead scope="col">project</TableHead>
          <TableHead scope="col" className="text-right">spawns</TableHead>
          <TableHead scope="col" className="text-right">messages</TableHead>
          <TableHead scope="col" className="text-right">errors</TableHead>
          <TableHead scope="col" className="text-right">error rate</TableHead>
          <TableHead scope="col" className="text-right">avg latency</TableHead>
          <TableHead scope="col" className="text-right">p50 · p95</TableHead>
          <TableHead scope="col" className="text-right">spawn lag</TableHead>
          <TableHead scope="col" className="text-right">session cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const rate = errorRate(r.errors, r.messages);
          return (
            <TableRow key={r.sessionId}>
              <TableCell className="font-mono text-xs">
                <SessionIdButton id={r.sessionId} onOpenSession={onOpenSession} />
              </TableCell>
              <TableCell className="max-w-[220px] truncate text-xs" title={r.project}>
                {basename(r.project)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.spawns}</TableCell>
              <TableCell className="text-right tabular-nums">{r.messages}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${r.errors > 0 ? "text-error-foreground" : ""}`}
              >
                {r.errors}
              </TableCell>
              <TableCell
                className={`text-right tabular-nums ${rate !== null && rate > 0 ? "text-error-foreground" : ""}`}
              >
                {errorRateLabel(r.errors, r.messages)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtLatency(r.avgLatencyMs)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.p50LatencyMs != null
                  ? `${fmtLatency(r.p50LatencyMs)} · ${fmtLatency(r.p95LatencyMs ?? r.p50LatencyMs)}`
                  : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.spawnToFirstMsgMs != null ? fmtLatency(r.spawnToFirstMsgMs) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.cost, 3)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function SubagentsTab({
  snapshot,
  onOpenSession,
}: {
  snapshot: Snapshot;
  onOpenSession?: OpenSession;
}) {
  const agg = snapshot.aggregates.subagents;
  const aggRate = errorRate(agg.errors, agg.messages);
  const [sort, setSort] = useState<AgentSort>({ key: "spawns", dir: "desc" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const agents = useMemo(
    () => sortAgentRows(agg.byAgent ?? [], sort.key, sort.dir),
    [agg.byAgent, sort],
  );

  const rows = snapshot.sessions
    .filter((s) => s.subagents.spawns + s.subagents.messages + s.subagents.lists > 0)
    .sort(
      (a, b) =>
        b.subagents.spawns +
        b.subagents.messages -
        (a.subagents.spawns + a.subagents.messages),
    );

  const byProject = new Map<string, { project: string; spawns: number; messages: number }>();
  for (const s of rows) {
    const key = s.project.split("/").pop() || s.project;
    const p = byProject.get(key) ?? { project: key, spawns: 0, messages: 0 };
    p.spawns += s.subagents.spawns;
    p.messages += s.subagents.messages;
    byProject.set(key, p);
  }
  const projects = [...byProject.values()].sort((a, b) => b.spawns + b.messages - (a.spawns + a.messages));

  function onSort(key: AgentSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }

  function toggleAgent(agent: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Bot}
          label="subagent activity"
          value={fmtCount(agg.spawns + agg.messages)}
          hint={`${fmtCount(agg.spawns)} spawns · ${fmtCount(agg.messages)} messages`}
        />
        <StatCard
          icon={CircleAlert}
          label="spawn errors"
          value={String(agg.errors)}
          valueClassName={agg.errors > 0 ? "text-error-foreground" : undefined}
        />
        <StatCard
          icon={Timer}
          label="latency"
          value={fmtLatency(agg.p95LatencyMs ?? agg.avgLatencyMs)}
          hint={
            agg.p95LatencyMs != null
              ? `p95 · avg ${fmtLatency(agg.avgLatencyMs)}`
              : "mean of per-session means"
          }
        />
        <StatCard
          icon={Percent}
          label="error rate"
          value={errorRateLabel(agg.errors, agg.messages)}
          hint="errors / messages"
          valueClassName={aggRate !== null && aggRate > 0 ? "text-error-foreground" : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">subagent activity by project</CardTitle>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <div className="text-xs text-muted-foreground">no subagent activity recorded</div>
          ) : (
            <ChartContainer config={projectConfig} className="h-64 w-full">
              <BarChart data={projects}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="project"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10 }}
                  interval={0}
                  angle={-18}
                  height={44}
                />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="spawns" stackId="a" fill="var(--color-spawns)" fillOpacity={0.9} radius={[0, 0, 0, 0]} />
                <Bar dataKey="messages" stackId="a" fill="var(--color-messages)" fillOpacity={0.55} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {agg.timeline && agg.timeline.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">spawns per day</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={timelineConfig} className="h-56 w-full">
              <BarChart data={agg.timeline}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={40} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="spawns" fill="var(--color-spawns)" fillOpacity={0.9} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">
            per-agent breakdown
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              avg = mean of means · p50/p95 pooled per message
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <div className="text-xs text-muted-foreground">no named agents spawned yet</div>
          ) : (
            <ScrollArea className="max-h-96 rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="w-8">
                      <span className="sr-only">details</span>
                    </TableHead>
                    <AgentSortHead label="agent" sortKey="agent" sort={sort} onSort={onSort} />
                    <AgentSortHead label="spawns" sortKey="spawns" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="messages" sortKey="messages" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="errors" sortKey="errors" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="error rate" sortKey="errorRate" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="avg latency" sortKey="avgLatencyMs" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="p50 · p95" sortKey="p95LatencyMs" sort={sort} onSort={onSort} className="text-right" />
                    <AgentSortHead label="spawn lag" sortKey="spawnToFirstMsgMs" sort={sort} onSort={onSort} className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((a) => {
                    const rate = errorRate(a.errors, a.messages);
                    const open = expanded.has(a.agent);
                    return (
                      <Fragment key={a.agent}>
                        <TableRow>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => toggleAgent(a.agent)}
                              aria-expanded={open}
                              aria-label={open ? `collapse ${a.agent}` : `expand ${a.agent}`}
                              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                              {open ? (
                                <ChevronDown className="size-3.5" aria-hidden />
                              ) : (
                                <ChevronRight className="size-3.5" aria-hidden />
                              )}
                            </button>
                          </TableCell>
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
                          <TableCell className="text-right tabular-nums">
                            {fmtLatency(a.avgLatencyMs)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {a.p50LatencyMs != null
                              ? `${fmtLatency(a.p50LatencyMs)} · ${fmtLatency(a.p95LatencyMs ?? a.p50LatencyMs)}`
                              : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {a.spawnToFirstMsgMs != null ? fmtLatency(a.spawnToFirstMsgMs) : "—"}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow>
                            <TableCell colSpan={9} className="bg-muted/30 p-3">
                              <AgentSessionList
                                sessions={snapshot.sessions}
                                agent={a.agent}
                                onOpenSession={onOpenSession}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">sessions using subagents — {rows.length}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">none</div>
          ) : (
            <ScrollArea className="max-h-80 rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>session</TableHead>
                    <TableHead scope="col">project</TableHead>
                    <TableHead scope="col" className="text-right">spawns</TableHead>
                    <TableHead scope="col" className="text-right">messages</TableHead>
                    <TableHead scope="col" className="text-right">lists</TableHead>
                    <TableHead scope="col" className="text-right">errors</TableHead>
                    <TableHead scope="col" className="text-right">avg latency</TableHead>
                    <TableHead scope="col" className="text-right">session cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => (
                    <TableRow key={s.sessionId}>
                      <TableCell className="font-mono text-xs">
                        <SessionIdButton id={s.sessionId} onOpenSession={onOpenSession} />
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs" title={s.project}>
                        {s.project.split("/").pop()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.spawns}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.messages}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.lists}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${s.subagents.errors > 0 ? "text-error-foreground" : ""}`}
                      >
                        {s.subagents.errors}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtLatency(s.subagents.avgLatencyMs)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(s.cost, 3)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
