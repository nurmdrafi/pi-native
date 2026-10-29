import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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

  async function openDetail(sessionId: string | null | undefined) {
    if (!sessionId) return;
    try {
      setDetail(await fetchDetail(sessionId));
    } catch {
      setDetail(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            active sessions
            <span className={connected ? "text-green-500" : "text-muted-foreground"}>
              {connected ? "● streaming" : "○ connecting…"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.active.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              no session files written in the last two minutes
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>file</TableHead>
                  <TableHead>project</TableHead>
                  <TableHead className="text-right">turns (since dashboard start)</TableHead>
                  <TableHead className="text-right">cost (since dashboard start)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.active.map((a) => (
                  <TableRow
                    key={a.file}
                    className={a.sessionId ? "cursor-pointer" : undefined}
                    onClick={() => openDetail(a.sessionId)}
                  >
                    <TableCell className="max-w-[360px] truncate font-mono text-xs">
                      <span
                        className="mr-1.5 inline-block size-2 rounded-full align-middle"
                        style={{ backgroundColor: colorFor(a.file) }}
                      />
                      {a.file}
                    </TableCell>
                    <TableCell className="text-xs">{a.project}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.turns}</TableCell>
                    <TableCell className="text-right tabular-nums">${a.cost.toFixed(4)}</TableCell>
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
          <CardTitle className="text-sm">live turn feed</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64 rounded border">
            {feed.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">
                waiting for turns… (write to any session — including this dashboard&apos;s own session)
              </div>
            ) : (
              <div className="divide-y">
                {feed.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-1.5 font-mono text-xs">
                    <span className="shrink-0 text-muted-foreground">{item.at}</span>
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
                        {e.model ?? "?"} · ${(e.cost ?? 0).toFixed(4)} · {e.toolCalls}t
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
