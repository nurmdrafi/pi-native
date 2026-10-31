import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Copy, Download } from "lucide-react";
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
import { SessionDetailPanel } from "@/components/SessionDetail";
import { fetchDetail } from "@/lib/api";
import { downloadFile, sessionDetailCsv } from "@/lib/export";
import { fmtAgo, fmtMoney, basename } from "@/lib/format";
import type { SessionDetail, SessionSummary, Snapshot } from "@/types";

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
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-3">
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
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "lastTs",
    dir: "desc",
  });

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // The header's global date range already scopes snapshot.sessions; only
    // text narrows further here, so no second range control lives on this tab.
    const filtered = snapshot.sessions.filter((s) => {
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
  }, [snapshot.sessions, filter, sort]);

  const activeFiles = useMemo(
    () => new Set(snapshot.active.map((a) => a.file)),
    [snapshot.active],
  );

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

  const selIdx = selected ? rows.findIndex((r) => r.sessionId === selected.sessionId) : -1;
  const prev = selIdx > 0 ? rows[selIdx - 1] : null;
  const next = selIdx >= 0 && selIdx < rows.length - 1 ? rows[selIdx + 1] : null;

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
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {rows.length} of {snapshot.sessions.length} sessions
        </span>
      </div>

      <div className="min-w-0">
        <ScrollArea className="h-[calc(100vh-260px)] min-h-72 rounded-md">
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
                          <span className="mr-1 inline-block size-1.5 rounded-full bg-ok align-middle" aria-label="active" />
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
              <div role="alert" className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                failed to load session detail: {error}
              </div>
            )}
            {selected ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="min-h-0 flex-1">
                  <SessionDetailPanel detail={selected} onClose={closeDetail} />
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
