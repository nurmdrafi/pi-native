import { Fragment, useMemo, useState } from "react";
import { Activity, Check, CircleSlash, Copy, OctagonAlert, PiggyBank, ShieldAlert, TriangleAlert } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
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
  gate: "gate & destructive",
  toolchain: "toolchain",
  loop: "loop guard",
  advisory: "advisory",
};

const severityTone = (severity: string) =>
  severity === "error"
    ? { dot: "bg-error", pill: "border-error/35 bg-error/10 text-error-foreground" }
    : severity === "warn"
      ? { dot: "bg-warn", pill: "border-warn/45 bg-warn/18 text-warn-foreground" }
      : { dot: "bg-muted-foreground/50", pill: "border-border bg-muted text-muted-foreground" };

/** One bar per day in the window: height is the day's traffic, red when the
 * day had blocks, yellow when it was warn-only. No axes — the row's numbers
 * carry the exact counts; this carries the shape over time. */
function Sparkline({ days, trend }: { days: string[]; trend: number[][] }) {
  const width = 72;
  const height = 14;
  const totals = trend.map(([b, w]) => b + w);
  const peak = Math.max(1, ...totals);
  const step = totals.length > 0 ? width / totals.length : width;
  const barWidth = Math.max(1, step - (step > 3 ? 1 : 0));
  const peakDay = days[totals.indexOf(peak)] ?? "";
  const sum = totals.reduce((n, t) => n + t, 0);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${sum} events over ${days.length} days, peak on ${peakDay}`}
      className="overflow-visible"
    >
      {totals.map((total, i) => {
        if (total === 0) return null;
        const barHeight = Math.max(1, (total / peak) * height);
        return (
          <rect
            key={days[i]}
            x={i * step}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={0.5}
            fill={trend[i][0] > 0 ? "var(--error)" : "var(--warn)"}
            stroke={trend[i][0] > 0 ? "var(--error-foreground)" : "var(--warn-foreground)"}
            strokeWidth={0.75}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

/** Severity reads as a dot plus its word: color alone never carries the state,
 * and the tinted pill keeps the row's numbers the loudest thing on it. */
function SeverityBadge({ severity }: { severity: string }) {
  const tone = severityTone(severity);
  return (
    <Badge
      variant="outline"
      className={`gap-1.5 border py-0 text-[11px] font-medium ${tone.pill}`}
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {severity}
    </Badge>
  );
}

const familyConfig = {
  blocks: { label: "blocks", color: "var(--error)" },
  warn: { label: "warn", color: "var(--warn)" },
} satisfies ChartConfig;

/** Read-only fix list: the rules whose blocks cost the most, with the config
 * key to change. Copying is the only write affordance — the config itself is
 * never edited from here. */
function FixList({ rules, filterActive, onClearFilter }: { rules: { id: string; code: string; label: string; tags?: string[]; severity: string; blocks: number; avoidedSpend?: number }[]; filterActive: boolean; onClearFilter: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // Clipboard unavailable: the key stays selectable text next to the button.
    }
  };
  const rows = [...rules]
    .filter((r) => (r.avoidedSpend ?? 0) > 0)
    .sort((a, b) => (b.avoidedSpend ?? 0) - (a.avoidedSpend ?? 0))
    .slice(0, 5);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-[13px] font-medium">
          fix list — change this next
          <span className="ml-2 max-w-[72ch] text-xs font-normal text-muted-foreground">
            ranked by estimated avoided spend: blocks × the blocked tool's average
            call cost — a proxy, not a measurement
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex h-16 items-center text-xs text-muted-foreground">
            {rules.length === 0 ? (
              <span>
                no rules match —{" "}
                {filterActive && (
                  <button type="button" className="underline" onClick={onClearFilter}>
                    clear the filter
                  </button>
                )}
              </span>
            ) : (
              "no blocked calls in this window — nothing to change"
            )}
          </div>
        ) : (
          <Table>
            <TableHeader className="[&_th]:h-8 [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead scope="col" className="w-8 text-right">#</TableHead>
                <TableHead scope="col">rule</TableHead>
                <TableHead scope="col">config key</TableHead>
                <TableHead scope="col" className="text-right">severity</TableHead>
                <TableHead scope="col" className="text-right">blocks</TableHead>
                <TableHead scope="col" className="text-right">est. avoided</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="max-w-[44ch] whitespace-normal text-xs leading-4">
                    <span className="font-mono text-[11px] text-muted-foreground">{r.code}</span>{" "}
                    {r.tags?.length ? r.tags[0] : r.label}
                    <span className="block text-xs text-muted-foreground">{r.label}</span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <code className="font-mono text-[11px]">{r.id}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => copyKey(r.id)}
                        aria-label={`copy ${r.id} config key`}
                        title={`copy ${r.id} config key`}
                      >
                        {copied === r.id ? (
                          <Check className="size-3" aria-hidden />
                        ) : (
                          <Copy className="size-3" aria-hidden />
                        )}
                      </Button>
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <SeverityBadge severity={r.severity} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">{r.blocks}</TableCell>
                  <TableCell className="text-right tabular-nums text-[12px]">
                    {fmtMoney(r.avoidedSpend ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const toolConfig = {
  blocks: { label: "blocks", color: "var(--error)" },
  warn: { label: "warn", color: "var(--warn)" },
} satisfies ChartConfig;

const ruleEventConfig = {
  blocks: { label: "blocks", color: "var(--error)" },
  warn: { label: "warn", color: "var(--warn)" },
} satisfies ChartConfig;

export function GateTab({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState("");
  const gate = snapshot.aggregates.gate;
  const filterNeedle = filter.trim().toLowerCase();
  // Client-only narrowing of the rules table and the fix list below; the stat
  // row and the charts stay whole-snapshot. Rows are dropped, never reordered.
  const visibleRules = useMemo(() => {
    const rules = gate?.rules ?? [];
    if (!filterNeedle) return rules;
    return rules.filter((r) =>
      [r.id, r.code, r.label, r.group ?? "", r.family ?? "", ...(r.tags ?? []), r.topTool ?? ""].some(
        (field) => field.toLowerCase().includes(filterNeedle)
      )
    );
  }, [gate, filterNeedle]);

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

  // Rules grouped the way the gate's own table groups them, so "which group
  // holds which rule" is visible without opening the config.
  const GROUP_ORDER = ["anchor", "tokens", "search", "gate", "toolchain", "loop", "advisory"];
  const GROUP_LABELS = FAMILY_LABELS;
  const ruleGroups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key] ?? key,
    rules: gate.rules.filter((r) => (r.group ?? "advisory") === key),
  })).filter((g) => g.rules.length > 0);
  // The same grouping over the filtered rows, so the table narrows while the
  // family rollups above keep counting every rule.
  const visibleGroups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key] ?? key,
    rules: visibleRules.filter((r) => (r.group ?? "advisory") === key),
  })).filter((g) => g.rules.length > 0);
  // Families roll up from the same rows the rules table shows, so the chart,
  // the table and the detail never disagree — and each carries both outcomes.
  const familyRows = ruleGroups
    .map((g) => ({
      key: g.key,
      label: g.label,
      blocks: g.rules.reduce((n, r) => n + r.blocks, 0),
      warns: g.rules.reduce((n, r) => n + r.warns, 0),
      severity: gate.familySeverity?.[g.key] ?? null,
    }))
    .sort((a, b) => b.blocks + b.warns - (a.blocks + a.warns));
  const families = familyRows.map((f) => ({
    family: f.label,
    blocks: f.blocks,
    warn: f.warns,
  }));
  // Per-tool split comes from the scanner; an older snapshot carries only the
  // blocks total, so fall back to it rather than drawing an empty chart.
  const toolRows = (gate.byTool?.length
    ? gate.byTool.map((t) => ({ tool: t.tool, blocks: t.blocks, warn: t.warns }))
    : Object.entries(gate.blocksByTool ?? {}).map(([tool, blocks]) => ({
        tool,
        blocks,
        warn: 0,
      }))
  ).sort((a, b) => b.blocks + b.warn - (a.blocks + a.warn));
  const totalEvents = gate.rules.reduce((n, r) => n + r.blocks + r.warns, 0);
  const firing = gate.rules.filter((r) => r.blocks + r.warns > 0);
  const busiest = firing[0];
  const ruleEvents = firing
    .slice(0, 12)
    .map((r) => ({ name: r.code, blocks: r.blocks, warn: r.warns }));
  const shareOf = (r: { blocks: number; warns: number }) =>
    totalEvents > 0 ? Math.round(((r.blocks + r.warns) / totalEvents) * 1000) / 10 : 0;
  // The trend column needs at least two days to say anything; with a one-day
  // window every bar would be the row's own counts again.
  const trendDays = gate.days ?? [];
  const showTrend = trendDays.length > 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={ShieldAlert} label="total gate blocks" value={String(gate.total)} />
        <StatCard icon={Activity} label="blocks + warns" value={String(totalEvents)} />
        <StatCard icon={OctagonAlert} label="error rules" value={String(gate.bySeverity.error)} />
        <StatCard icon={TriangleAlert} label="warn rules" value={String(gate.bySeverity.warn)} />
        <StatCard icon={CircleSlash} label="off rules" value={String(gate.bySeverity.off)} />
        <StatCard
          icon={TriangleAlert}
          label="busiest rule"
          value={busiest ? `${busiest.code} (${busiest.blocks + busiest.warns})` : "—"}
        />
        <StatCard icon={PiggyBank} label="avoided spend (est.)" value={fmtMoney(gate.avoidedSpend ?? 0, 2)} />
      </div>
      <p className="max-w-[58ch] text-xs leading-5 text-muted-foreground">
        avoided spend ≈ blocked calls × that tool's average call cost — an estimate
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
              <ChartContainer config={familyConfig} className="h-64 w-full">
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
                  <Bar dataKey="blocks" stackId="a" fill="var(--color-blocks)" />
                  <Bar dataKey="warn" stackId="a" fill="var(--color-warn)" stroke="var(--warn-foreground)" strokeWidth={1} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              blocked calls by tool
              <span className="ml-2 max-w-[58ch] text-xs font-normal text-muted-foreground">
                which tool walked into the guard
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {toolRows.length === 0 ? (
              <div className="flex h-64 items-center text-xs text-muted-foreground">
                no blocked calls in this window
              </div>
            ) : (
              <ChartContainer config={toolConfig} className="h-64 w-full">
                <BarChart data={toolRows} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="tool"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    interval={0}
                  />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="blocks" stackId="a" fill="var(--color-blocks)" />
                  <Bar dataKey="warn" stackId="a" fill="var(--color-warn)" stroke="var(--warn-foreground)" strokeWidth={1} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          placeholder="filter by rule, tag, family, tool…"
          aria-label="filter rules"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {visibleRules.length} of {gate.rules.length} rules
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FixList
          rules={visibleRules}
          filterActive={filterNeedle.length > 0}
          onClearFilter={() => setFilter("")}
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              rule traffic
              <span className="ml-2 max-w-[58ch] text-xs font-normal text-muted-foreground">
                one column per rule, busiest first — height is how often it spoke
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ruleEvents.length === 0 ? (
              <div className="flex h-64 items-center text-xs text-muted-foreground">
                no gate traffic in this window
              </div>
            ) : (
              <ChartContainer config={ruleEventConfig} className="h-64 w-full">
                <BarChart data={ruleEvents} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    interval={0}
                  />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="blocks" stackId="a" fill="var(--color-blocks)" />
                  <Bar dataKey="warn" stackId="a" fill="var(--color-warn)" stroke="var(--warn-foreground)" strokeWidth={1} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              families — blocks × severity
              <span className="ml-2 max-w-[58ch] text-xs font-normal text-muted-foreground">
                every family's blocks and warns, joined to the worst severity of its rules
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded-md">
              <Table>
                <TableHeader className="[&_th]:h-8 [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow>
                    <TableHead scope="col">family</TableHead>
                    <TableHead scope="col">severity</TableHead>
                    <TableHead scope="col" className="text-right">blocks</TableHead>
                    <TableHead scope="col" className="text-right">warn</TableHead>
                    <TableHead scope="col" className="text-right">blocks</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {familyRows.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="text-xs">{f.label}</TableCell>
                      <TableCell>
                        {f.severity ? (
                          <SeverityBadge severity={f.severity} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.blocks}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.warns}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-[13px] font-medium">
              rules — {gate.rules.length}
              <span className="ml-2 max-w-[58ch] text-xs font-normal text-muted-foreground">
                severity from config; blocks and warns from transcripts, busiest first
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[34rem] rounded-md">
              {visibleRules.length === 0 ? (
                <div className="flex h-24 items-center text-xs text-muted-foreground">
                  <span>
                    no rules match —{" "}
                    {filterNeedle && (
                      <button type="button" className="underline" onClick={() => setFilter("")}>
                        clear the filter
                      </button>
                    )}
                  </span>
                </div>
              ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card/90 backdrop-blur [&_th]:h-8 [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground">
                  <TableRow>
                    <TableHead scope="col">rule</TableHead>
                    <TableHead scope="col">id</TableHead>
                    <TableHead scope="col">group</TableHead>
                    <TableHead scope="col" className="text-right">blocks</TableHead>
                    <TableHead scope="col" className="text-right">warn</TableHead>
                    <TableHead scope="col" className="text-right">total</TableHead>
                    {showTrend ? <TableHead scope="col">trend</TableHead> : null}
                    <TableHead scope="col" className="text-right">share</TableHead>
                    <TableHead scope="col">top tool</TableHead>
                    <TableHead scope="col" className="text-right">severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleGroups.map((g) => (
                    <Fragment key={g.key}>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={showTrend ? 10 : 9} className="text-[11px] font-medium text-muted-foreground">
                          {g.label} · {g.rules.length} rules
                        </TableCell>
                      </TableRow>
                      {g.rules.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="max-w-[38ch] whitespace-normal text-xs leading-4" title={r.id}>
                            {/* Lead with the live tag — the exact string the
                                gate prints in the terminal — so a blocked
                                call maps to its row by eye. */}
                            {r.tags?.length ? (
                              <span className="block">{r.tags[0]}</span>
                            ) : (
                              <span className="block">{r.label}</span>
                            )}
                            <span className="block text-xs text-muted-foreground">
                              {r.label}
                              {r.tags && r.tags.length > 1
                                ? ` · also: ${r.tags.slice(1).join(" · ")}`
                                : ""}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">{r.code}</TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {GROUP_LABELS[r.group ?? "advisory"] ?? r.group ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[12px]">
                            {r.blocks > 0 ? r.blocks : <span className="text-muted-foreground/60">0</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[12px]">
                            {r.warns > 0 ? r.warns : <span className="text-muted-foreground/60">0</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-[12px]">{r.blocks + r.warns}</TableCell>
                          {showTrend ? (
                            <TableCell>
                              {r.trend?.length ? (
                                <Sparkline days={trendDays} trend={r.trend} />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          ) : null}
                          <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground">
                            {shareOf(r)}%
                          </TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                            {r.topTool ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <SeverityBadge severity={r.severity} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
              )}
            </ScrollArea>
            {(gate.unmappedTags ?? []).length > 0 && (
              <p className="mt-2 max-w-[58ch] text-xs leading-5 text-muted-foreground text-pretty">
                unmapped guard tags: {(gate.unmappedTags ?? [])
                  .slice(0, 6)
                  .map((u) => `${u.tag} (${u.blocks + u.warns})`)
                  .join(", ")}
                — no config rule claims them; add a row to the tag table
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
