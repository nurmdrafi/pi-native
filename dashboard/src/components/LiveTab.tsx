import { useEffect, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionDetailPanel } from "@/components/SessionDetail";
import { fetchDetail } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtMoney } from "@/lib/format";
import type { LivePayload, SessionDetail, Snapshot } from "@/types";

export interface FeedItem {
  at: string;
  payload: LivePayload;
}

const FEED_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** Stable color per session file so feed rows and active rows identify alike. */
function colorFor(file: string): string {
  let h = 0;
  for (let i = 0; i < file.length; i++) h = (h * 31 + file.charCodeAt(i)) >>> 0;
  return FEED_COLORS[h % FEED_COLORS.length];
}

export function LiveTab({
  snapshot,
  feed,
  connected,
}: {
  snapshot: Snapshot;
  feed: FeedItem[];
  connected: boolean;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [shown, setShown] = useState<FeedItem[]>([]);

  // While paused, keep the visible feed frozen; catch up on resume.
  useEffect(() => {
    if (!paused) setShown(feed);
  }, [feed, paused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openDetail(sessionId: string | null | undefined) {
    if (!sessionId) return;
    setError(null);
    try {
      setDetail(await fetchDetail(sessionId));
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
            active sessions
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-normal ${
                connected ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
              }`}
            >
              <span className={`size-1.5 rounded-full ${connected ? "bg-green-500" : "bg-muted-foreground/50"}`} />
              {connected ? "streaming" : "connecting"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              failed to open session detail: {error}
            </div>
          )}
          {snapshot.active.length === 0 ? (
            <div className="py-4 text-xs text-muted-foreground">
              no session files written in the last two minutes — activity appears here as
              agents take turns
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">file</TableHead>
                  <TableHead scope="col">project</TableHead>
                  <TableHead scope="col" className="text-right">turns (since dashboard start)</TableHead>
                  <TableHead scope="col" className="text-right">cost (since dashboard start)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.active.map((a) => (
                  <TableRow
                    key={a.file}
                    tabIndex={0}
                    role="button"
                    aria-label={`open session for ${a.file}`}
                    className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => openDetail(a.sessionId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(a.sessionId);
                      }
                    }}
                  >
                    <TableCell className="flex items-center gap-2 font-mono text-xs">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(a.file) }}
                      />
                      {a.file}
                    </TableCell>
                    <TableCell className="text-xs">{a.project}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.turns}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(a.cost, 4)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {detail && <SessionDetailPanel detail={detail} onClose={() => setDetail(null)} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
            live turn feed
            <span className="text-xs font-normal text-muted-foreground">
              {paused ? "paused — newest events wait off-screen" : "latest 200 turns"}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setPaused((p) => !p)}
                aria-pressed={paused}
              >
                {paused ? <Play className="mr-1 size-3" /> : <Pause className="mr-1 size-3" />}
                {paused ? "resume" : "pause"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setShown([]);
                  setPaused(false);
                }}
                aria-label="clear feed"
              >
                <Trash2 className="size-3" />
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64 rounded-lg border">
            {shown.length === 0 ? (
              <div
                className="space-y-2 p-3"
                aria-busy="true"
                aria-label={connected ? "waiting for turns" : "connecting to the live stream"}
              >
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 font-mono text-xs">
                    <Skeleton className="h-3.5 w-12" />
                    <Skeleton className="h-3.5 w-44" />
                    <Skeleton className="h-3.5 w-14" />
                    <Skeleton className="ml-auto h-3.5 w-10" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y">
                {shown.map((item, i) => (
                  <div
                    key={`${item.at}-${i}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-xs"
                  >
                    <span className="text-muted-foreground">{item.at}</span>
                    <span
                      className="flex min-w-0 max-w-[280px] shrink-0 items-center gap-1.5 font-medium"
                      style={{ color: colorFor(item.payload.file) }}
                      title={item.payload.file}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(item.payload.file) }}
                      />
                      <span className="truncate">{item.payload.file}</span>
                    </span>
                    {item.payload.events.map((e, j) => (
                      <span key={j} className="text-muted-foreground">
                        {e.model ?? "?"} · {fmtMoney(e.cost ?? 0, 4)} · {e.toolCalls}t
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
