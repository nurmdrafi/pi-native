import { useMemo, useState } from "react";
import { CalendarRange } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionDetailPanel } from "@/components/SessionDetail";
import { fetchDetail } from "@/lib/api";
import type { SessionDetail, SessionSummary, Snapshot } from "@/types";

function ago(ts: string | null): string {
  if (!ts) return "-";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function SessionsTab({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState("");
  const [range, setRange] = useState("30d");
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const activeFiles = useMemo(() => new Set(snapshot.active.map((a) => a.file)), [snapshot.active]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const days = RANGES[range];
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    return snapshot.sessions.filter((s: SessionSummary) => {
      if (q !== "" && !s.sessionId.toLowerCase().includes(q) && !s.project.toLowerCase().includes(q) && !s.models.join(",").toLowerCase().includes(q)) {
        return false;
      }
      if (cutoff > 0) {
        const last = s.lastTs ? Date.parse(s.lastTs) : 0;
        if (last < cutoff) return false;
      }
      return true;
    });
  }, [snapshot.sessions, filter, range]);

  async function select(s: SessionSummary) {
    setLoading(true);
    try {
      setSelected(await fetchDetail(s.sessionId));
    } catch {
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          placeholder="filter by session id, project, model…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarRange className="size-3.5" aria-hidden />
          <Tabs value={range} onValueChange={setRange}>
            <TabsList>
              <TabsTrigger value="7d">7 days</TabsTrigger>
              <TabsTrigger value="30d">30 days</TabsTrigger>
              <TabsTrigger value="90d">90 days</TabsTrigger>
              <TabsTrigger value="all">all</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} of {snapshot.sessions.length} sessions
        </span>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(400px,1fr)]">
        <div className="rounded border">
          <ScrollArea className="h-[calc(100vh-240px)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>session</TableHead>
                  <TableHead>project</TableHead>
                  <TableHead>model(s)</TableHead>
                  <TableHead className="text-right">turns</TableHead>
                  <TableHead className="text-right">cost</TableHead>
                  <TableHead className="text-right">tool calls</TableHead>
                  <TableHead>last</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => {
                  const file = (s.path ?? "").split("/").pop();
                  const live = file !== undefined && activeFiles.has(file);
                  return (
                    <TableRow
                      key={s.sessionId}
                      className="cursor-pointer"
                      data-state={selected?.sessionId === s.sessionId ? "selected" : undefined}
                      onClick={() => select(s)}
                    >
                      <TableCell className="font-mono text-xs">
                        {live && <span className="mr-1 text-green-500">●</span>}
                        {s.sessionId.slice(0, 14)}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate" title={s.project}>
                        {s.project.split("/").pop()}
                      </TableCell>
                      <TableCell className="text-xs">{s.models.join(",")}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.turns}</TableCell>
                      <TableCell className="text-right tabular-nums">${s.cost.toFixed(3)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.toolCalls}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{ago(s.lastTs)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>

        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-240px)]">
          {loading && <div className="mb-2 text-xs text-muted-foreground">loading detail…</div>}
          {selected ? (
            <SessionDetailPanel detail={selected} onClose={() => setSelected(null)} />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded border border-dashed text-xs text-muted-foreground">
              select a session to inspect it
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
