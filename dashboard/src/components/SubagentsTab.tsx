import { Bot, CircleAlert, ListChecks, Send, Timer } from "lucide-react";
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
import { fmtLatency, fmtMoney } from "@/lib/format";
import type { Snapshot } from "@/types";

const projectConfig = {
  spawns: { label: "spawns", color: "var(--chart-1)" },
  messages: { label: "messages", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function SubagentsTab({ snapshot }: { snapshot: Snapshot }) {
  const agg = snapshot.aggregates.subagents;
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard icon={Bot} label="subagent spawns" value={String(agg.spawns)} />
        <StatCard icon={Send} label="messages routed" value={String(agg.messages)} />
        <StatCard icon={ListChecks} label="list calls" value={String(agg.lists)} />
        <StatCard icon={CircleAlert} label="spawn errors" value={String(agg.errors)} />
        <StatCard icon={Timer} label="avg latency" value={fmtLatency(agg.avgLatencyMs)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">subagent activity by project</CardTitle>
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
                <Bar dataKey="spawns" stackId="a" fill="var(--color-spawns)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="messages" stackId="a" fill="var(--color-messages)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">per-agent breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {(agg.byAgent ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground">no named agents spawned yet</div>
          ) : (
            <ScrollArea className="h-56 rounded-lg border">
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
                  {(agg.byAgent ?? []).map((a) => (
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
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">sessions using subagents — {rows.length}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">none</div>
          ) : (
            <ScrollArea className="max-h-80 rounded border">
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
                      <TableCell className="font-mono text-xs">{s.sessionId.slice(0, 14)}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs" title={s.project}>
                        {s.project.split("/").pop()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.spawns}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.messages}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.lists}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.subagents.errors}</TableCell>
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
