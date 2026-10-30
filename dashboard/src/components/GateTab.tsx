import { CircleSlash, OctagonAlert, PiggyBank, ShieldAlert, TriangleAlert } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
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
import { fmtMoney } from "@/lib/format";
import type { Snapshot } from "@/types";

const FAMILY_LABELS: Record<string, string> = {
  anchor: "anchor guard",
  tokens: "token economy",
  search: "search",
  gate: "destructive confirm",
  toolchain: "toolchain",
  loop: "loop guard",
};

const severityBadgeClass = (severity: string) =>
  severity === "error"
    ? "border-destructive/40 bg-destructive/15 text-destructive"
    : severity === "warn"
      ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400"
      : "border-border bg-muted text-muted-foreground";

const familyConfig = { blocks: { label: "blocks", color: "var(--chart-5)" } } satisfies ChartConfig;

export function GateTab({ snapshot }: { snapshot: Snapshot }) {
  const gate = snapshot.aggregates.gate;

  // Older snapshots may lack the gate summary entirely; degrade to an empty
  // state instead of crashing the tab.
  if (!gate || !gate.rules) {
    return (
      <Card>
        <CardContent className="flex h-40 items-center justify-center text-xs text-muted-foreground">
          no permission-gate data in this snapshot — it may come from an older server build
        </CardContent>
      </Card>
    );
  }

  const families = Object.entries(gate.byFamily)
    .map(([family, blocks]) => ({ family: FAMILY_LABELS[family] ?? family, blocks }))
    .sort((a, b) => b.blocks - a.blocks);
  const familyRows = Object.entries(gate.byFamily)
    .map(([key, blocks]) => ({
      key,
      label: FAMILY_LABELS[key] ?? key,
      blocks,
      severity: gate.familySeverity?.[key] ?? null,
    }))
    .sort((a, b) => b.blocks - a.blocks);
  const toolRows = Object.entries(gate.blocksByTool ?? {})
    .map(([tool, blocked]) => ({ tool, blocked }))
    .sort((a, b) => b.blocked - a.blocked);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard icon={ShieldAlert} label="total gate blocks" value={String(gate.total)} />
        <StatCard icon={OctagonAlert} label="error rules" value={String(gate.bySeverity.error)} />
        <StatCard icon={TriangleAlert} label="warn rules" value={String(gate.bySeverity.warn)} />
        <StatCard icon={CircleSlash} label="off rules" value={String(gate.bySeverity.off)} />
        <StatCard
          icon={PiggyBank}
          label="avoided spend (est.)"
          value={fmtMoney(gate.avoidedSpend ?? 0, 2)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        avoided spend ≈ blocked calls × avg observed cost per call of the same tool (global average
        when that tool never cost anything) — a proxy, not a measurement
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              blocks by family
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                what the guard stopped, grouped by rule family
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {families.length === 0 ? (
              <div className="flex h-72 items-center text-xs text-muted-foreground">
                no blocked calls recorded — every tool call passed the gate
              </div>
            ) : (
              <ChartContainer config={familyConfig} className="h-72 w-full">
                <BarChart data={families} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="family"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={124}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="blocks" fill="var(--color-blocks)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              families — blocks × severity
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                block counts joined to the worst severity of their rules
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-72 rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">family</TableHead>
                    <TableHead scope="col">severity</TableHead>
                    <TableHead scope="col" className="text-right">blocks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {familyRows.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="text-xs">{f.label}</TableCell>
                      <TableCell>
                        {f.severity ? (
                          <Badge
                            variant="outline"
                            className={`font-mono text-[11px] ${severityBadgeClass(f.severity)}`}
                          >
                            {f.severity}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.blocks}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              blocked calls by tool
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                where the guard stepped in
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {toolRows.length === 0 ? (
              <div className="flex h-40 items-center text-xs text-muted-foreground">
                no blocked calls recorded
              </div>
            ) : (
              <ScrollArea className="h-64 rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">tool</TableHead>
                      <TableHead scope="col" className="text-right">blocked calls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toolRows.map((t) => (
                      <TableRow key={t.tool}>
                        <TableCell className="font-mono text-xs">{t.tool}</TableCell>
                        <TableCell className="text-right tabular-nums">{t.blocked}</TableCell>
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
            <CardTitle className="text-[13px] font-medium">
              rules — {gate.rules.length}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                severity from the permission-gate config
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">rule</TableHead>
                    <TableHead scope="col">family</TableHead>
                    <TableHead scope="col" className="text-right">severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gate.rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.id}</TableCell>
                      <TableCell className="text-xs">
                        {r.family ? (FAMILY_LABELS[r.family] ?? r.family) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={`font-mono text-[11px] ${severityBadgeClass(r.severity)}`}
                        >
                          {r.severity}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
