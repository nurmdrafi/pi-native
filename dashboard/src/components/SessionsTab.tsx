import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Coins, Copy, Download, ListTree, MessageSquare, Timer, TriangleAlert, Wrench } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/StatCard";
import { SessionDetailPanel } from "@/components/SessionDetail";
import { fetchDetail } from "@/lib/api";
import { downloadFile, sessionDetailCsv } from "@/lib/export";
import { fmtAgo, fmtCount, fmtDuration, fmtMoney, basename } from "@/lib/format";
import type { CostAlert, SessionDetail, SessionSummary, Snapshot } from "@/types";

type SortKey = "lastTs" | "cost" | "turns" | "toolCalls";

function SortHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey | null;
  dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const Icon = active === sortKey ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 text-inherit transition-colors hover:text-foreground ${
          active === sortKey ? "text-foreground" : ""
        }`}
        aria-label={`sort by ${label}`}
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </TableHead>
  );
}

function SessionDetailFooter({
  detail,
  onPrev,
  onNext,
}: {
  detail: SessionDetail;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(detail.sessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the id stays readable in the header
    }
  };
  const exportCsv = () => {
    const { name, text } = sessionDetailCsv(detail);
    downloadFile(name, text, "text/csv");
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-(--card-spacing) py-(--card-spacing) [--card-spacing:--spacing(4)]">
      <Button variant="outline" size="sm" onClick={onPrev} disabled={!onPrev}>
        <ChevronLeft className="size-4" aria-hidden /> prev
      </Button>
      <Button variant="outline" size="sm" onClick={onNext} disabled={!onNext}>
        next <ChevronRight className="size-4" aria-hidden />
      </Button>
      <span className="grow" />
      <Button variant="outline" size="sm" onClick={copyId}>
        <Copy className="size-4" aria-hidden /> {copied ? "copied" : "copy id"}
      </Button>
      <Button variant="outline" size="sm" onClick={exportCsv}>
        <Download className="size-4" aria-hidden /> CSV
      </Button>
    </div>
  );
}

export function SessionsTab({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "main" | "subagent">("all");
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remembers the row whose fetch failed so the alert can offer a retry.
  const lastSelectedRef = useRef<SessionSummary | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "lastTs",
    dir: "desc",
  });

  // Budget state rides on the cost cell: over → error, near → warn; the word
  // stays in the title and a screen-reader copy so color never carries it alone.
  const alertBySession = useMemo(() => {
    const m = new Map<string, CostAlert>();
    for (const a of snapshot.aggregates.alerts ?? []) m.set(a.sessionId, a);
    return m;
  }, [snapshot]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // The header's global date range already scopes snapshot.sessions; only
    // text narrows further here, so no second range control lives on this tab.
    const filtered = snapshot.sessions.filter((s) => {
      if (kind !== "all" && s.kind !== kind) return false;
      if (
        q &&
        !`${s.sessionId} ${s.project} ${s.models.join(" ")}`.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      if (sort.key === "lastTs") {
        return ((a.lastTs ?? "").localeCompare(b.lastTs ?? "") || 0) * dir;
      }
      return (a[sort.key] - b[sort.key]) * dir;
    });
  }, [snapshot.sessions, filter, kind, sort]);

  const activeFiles = useMemo(
    () => new Set(snapshot.active.map((a) => a.file)),
    [snapshot.active],
  );

  // Rollup of the FILTERED rows — the tiles answer "what am I looking at",
  // so they follow the filter and kind select, not the whole snapshot.
  const stats = useMemo(() => {
    const sub = rows.filter((r) => r.kind === "subagent").length;
    const live = rows.filter((r) => activeFiles.has((r.path ?? "").split("/").pop() ?? "")).length;
    const cost = rows.reduce((acc, r) => acc + (r.cost ?? 0), 0);
    const turns = rows.reduce((acc, r) => acc + (r.turns ?? 0), 0);
    const calls = rows.reduce((acc, r) => acc + (r.toolCalls ?? 0), 0);
    const over = rows.filter((r) => alertBySession.get(r.sessionId)?.level === "over").length;
    const near = rows.filter((r) => alertBySession.get(r.sessionId)?.level === "near").length;
    // Nearest-rank percentiles over the filtered rows' own durations — the
    // tile follows the filter, not the whole snapshot. Like data.mjs
    // percentileMs, a single sample yields null so the tile shows the same
    // em-dash + "fewer than two timed sessions" hint as OverviewTab.
    const durations = rows
      .map((r) => r.durationSec ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const rank = (p: number) =>
      durations.length >= 2
        ? durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)]
        : null;
    const durationP50 = rank(0.5);
    const durationP95 = rank(0.95);
    return {
      sub,
      live,
      cost,
      turns,
      calls,
      over,
      near,
      durationP50,
      durationP95,
      timed: durations.length,
    };
  }, [rows, activeFiles, alertBySession]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") {
        closeDetail();
        return;
      }
      if (!selected || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const i = rows.findIndex((r) => r.sessionId === selected.sessionId);
      const n = e.key === "ArrowRight" ? i + 1 : i - 1;
      if (n >= 0 && n < rows.length) void select(rows[n]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected]);

  function onSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }

  async function select(s: SessionSummary) {
    lastSelectedRef.current = s;
    setLoading(true);
    setError(null);
    try {
      setSelected(await fetchDetail(s.sessionId));
    } catch (e) {
      setSelected(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function closeDetail() {
    setSelected(null);
    setError(null);
    setLoading(false);
  }

  const retryDetail = () => {
    if (lastSelectedRef.current) void select(lastSelectedRef.current);
  };

  const selIdx = selected ? rows.findIndex((r) => r.sessionId === selected.sessionId) : -1;
  const prev = selIdx > 0 ? rows[selIdx - 1] : null;
  const next = selIdx >= 0 && selIdx < rows.length - 1 ? rows[selIdx + 1] : null;

  return (
    <div>
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard
          icon={ListTree}
          label="sessions"
          value={String(rows.length)}
          hint={`${rows.length - stats.sub} main · ${stats.sub} subagent${stats.live ? ` · ${stats.live} live` : ""}`}
        />
        <StatCard
          icon={Coins}
          label="cost"
          value={fmtMoney(stats.cost, 2)}
          hint={
            stats.over
              ? `${stats.over} over budget`
              : stats.near
                ? `${stats.near} near budget`
                : "\u00a0"
          }
          hintClassName={stats.over ? "text-error-foreground" : stats.near ? "text-warn-foreground" : undefined}
        />
        <StatCard
          icon={MessageSquare}
          label="turns"
          value={String(stats.turns)}
          hint={rows.length ? `${Math.round(stats.turns / rows.length)} / session` : "\u00a0"}
        />
        <StatCard
          icon={Wrench}
          label="tool calls"
          value={String(stats.calls)}
          hint={rows.length ? `${Math.round(stats.calls / rows.length)} / session` : "\u00a0"}
        />
        <StatCard
          icon={Timer}
          label="duration p50 / p95"
          value={
            stats.durationP50 != null && stats.durationP95 != null
              ? `${fmtDuration(stats.durationP50)} / ${fmtDuration(stats.durationP95)}`
              : "—"
          }
          hint={
            stats.durationP50 != null && stats.durationP95 != null
              ? `${stats.timed} timed sessions`
              : "fewer than two timed sessions"
          }
        />
        {snapshot.aggregates.errors && (
          <StatCard
            icon={TriangleAlert}
            label="tool errors"
            value={fmtCount(snapshot.aggregates.errors.toolErrors)}
            hint={`all sessions · ${
              Math.round(snapshot.aggregates.errors.toolErrorRate * 1000) / 10
            }% of calls`}
          />
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          placeholder="filter by session id, project, model…"
          aria-label="filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <select
          aria-label="filter by session kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "all" | "main" | "subagent")}
          className="h-8 rounded-lg border border-input bg-transparent px-2 py-1 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground"
        >
          <option value="all">all kinds</option>
          <option value="main">main</option>
          <option value="subagent">subagent</option>
        </select>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length} of {snapshot.sessions.length} sessions
        </span>
      </div>

      <div className="min-w-0">
        <ScrollArea className="h-[calc(100vh-360px)] min-h-72 rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>session</TableHead>
                  <TableHead>kind</TableHead>
                  <TableHead>project</TableHead>
                  <TableHead>model(s)</TableHead>
                  <SortHead label="turns" sortKey="turns" active={sort.key} dir={sort.dir} onSort={onSort} className="text-right" />
                  <SortHead label="cost" sortKey="cost" active={sort.key} dir={sort.dir} onSort={onSort} className="text-right" />
                  <SortHead label="tool calls" sortKey="toolCalls" active={sort.key} dir={sort.dir} onSort={onSort} className="text-right" />
                  <SortHead label="last" sortKey="lastTs" active={sort.key} dir={sort.dir} onSort={onSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => {
                  const file = (s.path ?? "").split("/").pop();
                  const live = file !== undefined && activeFiles.has(file);
                  const alert = alertBySession.get(s.sessionId);
                  return (
                    <TableRow
                      key={s.sessionId}
                      tabIndex={0}
                      role="button"
                      aria-label={`open session ${s.sessionId.slice(0, 14)}, project ${basename(s.project)}`}
                      className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
                      data-state={selected?.sessionId === s.sessionId ? "selected" : undefined}
                      onClick={() => select(s)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          select(s);
                        }
                      }}
                    >
                      <TableCell className="font-mono text-xs">
                        {live && (
                          <span className="mr-1 inline-block size-1.5 rounded-full bg-ok align-middle" aria-label="active" />
                        )}
                        {s.sessionId.slice(0, 14)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {s.kind === "subagent" ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-border bg-muted py-0 text-[11px] font-medium text-muted-foreground"
                            title={s.parentSession ? `subagent of ${s.parentSession}` : undefined}
                          >
                            <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
                            subagent
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/70">main</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate" title={s.project}>
                        {basename(s.project)}
                      </TableCell>
                      <TableCell className="text-xs">{s.models.join(", ")}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.turns}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${
                          alert?.level === "over"
                            ? "text-error-foreground"
                            : alert?.level === "near"
                              ? "text-warn-foreground"
                              : ""
                        }`}
                        title={alert ? `${alert.level} budget · ${Math.round(alert.pct)}% of ${fmtMoney(alert.budget)} used` : undefined}
                      >
                        {fmtMoney(s.cost, 3)}
                        {alert && <span className="sr-only"> ({alert.level} budget)</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.toolCalls}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtAgo(s.lastTs)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-xs text-muted-foreground">
                      no sessions match — {(filter || kind !== "all") && <button type="button" className="underline" onClick={() => { setFilter(""); setKind("all"); }}>clear the filters</button>}
                      {filter && " or widen the date range"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>

        <Dialog
          open={loading || !!selected || !!error}
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <DialogContent className="h-[90vh] w-[min(68.75rem,94vw)]" aria-describedby={undefined}>
            <DialogTitle>session detail</DialogTitle>
            {loading && (
              <div
                className="flex min-h-0 flex-1 flex-col gap-4"
                aria-busy="true"
                aria-label="loading session detail"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-14" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-7 w-20" />
                  ))}
                </div>
                <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-44 w-full" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-44 w-full" />
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <span className="min-w-0 grow">failed to load session detail: {error}</span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={retryDetail}>
                  retry
                </Button>
              </div>
            )}
            {selected ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="min-h-0 flex-1">
                  <SessionDetailPanel key={selected.sessionId} detail={selected} onClose={closeDetail} />
                </div>
                <SessionDetailFooter
                  detail={selected}
                  onPrev={prev ? () => select(prev) : undefined}
                  onNext={next ? () => select(next) : undefined}
                />
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
    </div>
  );
}
