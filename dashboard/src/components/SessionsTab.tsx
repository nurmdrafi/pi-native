import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionDetailPanel } from "@/components/SessionDetail";
import { fetchDetail } from "@/lib/api";
import { fmtAgo, fmtMoney, basename } from "@/lib/format";
import type { SessionDetail, SessionSummary, Snapshot } from "@/types";

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

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

export function SessionsTab({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState("");
  const [range, setRange] = useState("30d");
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "lastTs",
    dir: "desc",
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const cutoffDays = RANGES[range];
    const cutoff = cutoffDays ? Date.now() - cutoffDays * 86400_000 : 0;
    const filtered = snapshot.sessions.filter((s) => {
      if (
        q &&
        !`${s.sessionId} ${s.project} ${s.models.join(" ")}`.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (cutoff > 0) {
        const last = s.lastTs ? Date.parse(s.lastTs) : 0;
        if (last < cutoff) return false;
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
  }, [snapshot.sessions, filter, range, sort]);

  const activeFiles = useMemo(
    () => new Set(snapshot.active.map((a) => a.file)),
    [snapshot.active],
  );

  function onSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }

  async function select(s: SessionSummary) {
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

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          placeholder="filter by session id, project, model…"
          aria-label="filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <Tabs value={range} onValueChange={setRange}>
          <TabsList aria-label="date range">
            <TabsTrigger value="7d">7 days</TabsTrigger>
            <TabsTrigger value="30d">30 days</TabsTrigger>
            <TabsTrigger value="90d">90 days</TabsTrigger>
            <TabsTrigger value="all">all</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length} of {snapshot.sessions.length} sessions
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,44%)]">
        <div className="min-w-0">
          <ScrollArea className="h-[calc(100vh-260px)] min-h-72 rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>session</TableHead>
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
                          <span className="mr-1 inline-block size-1.5 rounded-full bg-green-500 align-middle" aria-label="active" />
                        )}
                        {s.sessionId.slice(0, 14)}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate" title={s.project}>
                        {basename(s.project)}
                      </TableCell>
                      <TableCell className="text-xs">{s.models.join(", ")}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.turns}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(s.cost, 3)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.toolCalls}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtAgo(s.lastTs)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">
                      no sessions match — {filter && <button type="button" className="underline" onClick={() => setFilter("")}>clear the filter</button>}
                      {filter && " or widen the date range"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>

        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-220px)]">
          {loading && (
            <div
              className="flex h-full min-h-72 flex-col gap-4 rounded-lg border p-4"
              aria-busy="true"
              aria-label="loading session detail"
            >
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16" />
              </div>
              <div className="flex gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-20" />
                ))}
              </div>
              <Skeleton className="h-36 w-full" />
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            </div>
          )}
          {error && (
            <div role="alert" className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              failed to load session detail: {error}
            </div>
          )}
          {selected ? (
            <SessionDetailPanel detail={selected} onClose={() => setSelected(null)} />
          ) : (
            !loading && (
              <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                select a session to inspect it
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
