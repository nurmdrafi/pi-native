import { CircleSlash, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
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
  const families = Object.entries(gate.byFamily)
    .map(([family, blocks]) => ({ family: FAMILY_LABELS[family] ?? family, blocks }))
    .sort((a, b) => b.blocks - a.blocks);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={ShieldAlert} label="total gate blocks" value={String(gate.total)} />
        <StatCard icon={OctagonAlert} label="error rules" value={String(gate.bySeverity.error)} />
        <StatCard icon={TriangleAlert} label="warn rules" value={String(gate.bySeverity.warn)} />
        <StatCard icon={CircleSlash} label="off rules" value={String(gate.bySeverity.off)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">blocks by family</CardTitle>
          </CardHeader>
          <CardContent>
            {families.length === 0 ? (
              <div className="text-xs text-muted-foreground">no blocked calls recorded</div>
            ) : (
              <ChartContainer config={familyConfig} className="h-72 w-full">
                <BarChart data={families} layout="vertical">
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
            <CardTitle className="text-sm">
              rules — {gate.rules.length}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                severity from permission-gate config
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-72 rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>rule</TableHead>
                    <TableHead className="text-right">severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gate.rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.id}</TableCell>
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
