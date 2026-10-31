import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { burnRate } from "@/lib/burn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { basename, fmtLatency, fmtMoney } from "@/lib/format";
import type { ChildStatus, SnapshotWithFeeds, StallTone } from "@/types-feeds";
import type { LivePayload, Snapshot } from "@/types";

/* live-helpers:begin — pure, dependency-free functions. Extracted verbatim
 * by dashboard/tests/dashboard-wiring.test.mjs and executed there under
 * node's built-in type stripping, so keep this block free of runtime
 * imports, JSX and side effects. */
import type { ChildStatus as ChildStatusT, StallTone as StallToneT } from "../types-feeds";

/** The span a child is currently in: a waiting child ages from its last
 * question, every other phase from its activity start. Null when no
 * timestamp is usable — an unknown age, not a zero one. */
export function childActivity(
  child: Pick<ChildStatusT, "phase" | "activeSinceMs" | "waitingSinceMs">,
  now: number,
): { kind: "active" | "waiting"; ms: number } | null {
  if (child.phase === "waiting") {
    return Number.isFinite(child.waitingSinceMs)
      ? { kind: "waiting", ms: now - (child.waitingSinceMs as number) }
      : null;
  }
  return Number.isFinite(child.activeSinceMs)
    ? { kind: "active", ms: now - (child.activeSinceMs as number) }
    : null;
}

/** Stall state → tone. stalled is the only warning color; a healthy child
 * stays neutral chrome and an unclassifiable one muted. */
export function stallTone(state: string): StallToneT {
  return state === "stalled" ? "warn" : state === "healthy" ? "neutral" : "muted";
}
/* live-helpers:end */

export interface FeedItem {
  at: string;
  payload: LivePayload;
}

const ROLLING_WINDOW_MS = 15 * 60_000;

/** State badges follow the gate's severity pills: dot plus word, amber only
 * for the stalled warning, neutral for healthy, muted for unknown. */
const STALL_TONES: Record<StallTone, { dot: string; pill: string }> = {
  warn: { dot: "bg-warn", pill: "border-warn/45 bg-warn/18 text-warn-foreground" },
  neutral: { dot: "bg-muted-foreground/60", pill: "border-border bg-muted text-muted-foreground" },
  muted: { dot: "bg-muted-foreground/40", pill: "border-border bg-muted/60 text-muted-foreground/80" },
};

/** One live child agent row — read-only display of its spawner's latest
 * activity snapshot; no actions. */
function ChildRow({ child, now }: { child: ChildStatus; now: number }) {
  const activity = childActivity(child, now);
  const tone = STALL_TONES[stallTone(child.stallState)];
  return (
    <TableRow
      title={`last event ${child.latestEvent ?? "?"} · updated ${new Date(child.updatedAtMs).toISOString()}`}
    >
      <TableCell className="font-mono text-xs" title={child.childId}>
        {child.name ?? `${child.childId.slice(0, 8)}…`}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{child.phase}</TableCell>
      <TableCell className="font-mono text-xs">{child.activeTool ?? child.activeScope ?? "—"}</TableCell>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {activity
          ? `${activity.kind === "waiting" ? "waiting" : "active"} ${fmtLatency(activity.ms)}`
          : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">{child.turnIndex ?? "—"}</TableCell>
      <TableCell>
        <span
          className={`inline-flex h-5 items-center gap-1.5 rounded-4xl border px-2 text-[11px] font-medium ${tone.pill}`}
        >
          <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
          {child.stallState}
        </span>
      </TableCell>
    </TableRow>
  );
}

export function LiveTab({
  snapshot,
  feed,
  connected,
  onOpenSession,
}: {
  snapshot: Snapshot;
  feed: FeedItem[];
  connected: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [shown, setShown] = useState<FeedItem[]>([]);
  const children = (snapshot as SnapshotWithFeeds).children ?? [];
  const now = Date.now();

  // While paused, keep the visible feed frozen; catch up on resume.
  useEffect(() => {
    if (!paused) setShown(feed);
  }, [feed, paused]);

  // Rates come from what is on screen: frozen while paused, empty after a
  // clear. Events without their own timestamp fall back to feed arrival time.
  const feedEvents: { ts: string | null; cost: number }[] = shown.flatMap((item) =>
    item.payload.events.map((e) => ({ ts: e.ts ?? item.at, cost: e.cost })),
  );
  const rolling = burnRate(feedEvents, ROLLING_WINDOW_MS);
  const feedToDate = burnRate(feedEvents, null);

  // Feed payloads carry only the file basename; resolve it to a session id via
  // the active set first (live files are absent from the extracts), then any
  // known session file, so feed chips can drill into the session detail.
  const sessionIdByFile = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of snapshot.sessions) {
      const f = basename(s.path);
      if (f && !m.has(f)) m.set(f, s.sessionId);
    }
    for (const a of snapshot.active) {
      if (a.sessionId) m.set(a.file, a.sessionId);
    }
    return m;
  }, [snapshot.sessions, snapshot.active]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
            active sessions
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-normal ${
                connected ? "text-ok-foreground" : "text-muted-foreground"
              }`}
            >
              <span className={`size-1.5 rounded-full ${connected ? "bg-ok" : "bg-muted-foreground/50"}`} />
              {connected ? "streaming" : "connecting"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                    onClick={() => {
                      if (a.sessionId) onOpenSession(a.sessionId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (a.sessionId) onOpenSession(a.sessionId);
                      }
                    }}
                  >
                    <TableCell className="flex items-center gap-2 font-mono text-xs">
                      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
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

      {children.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
              subagent children
              <span className="text-xs font-normal text-muted-foreground">
                {children.length} live · spawner snapshots, read-only
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">child</TableHead>
                  <TableHead scope="col">phase</TableHead>
                  <TableHead scope="col">activity</TableHead>
                  <TableHead scope="col">duration</TableHead>
                  <TableHead scope="col" className="text-right">turn</TableHead>
                  <TableHead scope="col">state</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {children.map((c) => (
                  <ChildRow key={`${c.sessionId}/${c.childId}`} child={c} now={now} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

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
          <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              rolling{" "}
              <span
                className={`font-semibold tabular-nums ${
                  connected && rolling ? "text-ok-foreground" : "text-foreground"
                }`}
              >
                {rolling ? `${fmtMoney(rolling.hourly)}/h` : "warming up"}
              </span>
            </span>
            <span className="text-muted-foreground">
              feed-to-date{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {feedToDate ? `${fmtMoney(feedToDate.hourly)}/h` : "warming up"}
              </span>
            </span>
            <span className="text-muted-foreground">
              from the visible feed — rolling spans its newest 15m
            </span>
          </div>
          <ScrollArea className="h-64 rounded-md">
            {shown.length === 0 ? (
              <div
                className="space-y-2 p-3"
                aria-busy="true"
                aria-label={connected ? "waiting for turns" : "connecting to the live stream"}
              >
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-xs">
                    <Skeleton className="h-3.5 w-12" />
                    <Skeleton className="h-3.5 w-44" />
                    <Skeleton className="h-3.5 w-14" />
                    <Skeleton className="ml-auto h-3.5 w-10" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y">
                {shown.map((item, i) => {
                  const chipSessionId = sessionIdByFile.get(item.payload.file);
                  return (
                    <div
                      key={`${item.at}-${i}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-xs"
                    >
                      <span className="text-muted-foreground">{item.at}</span>
                      {chipSessionId ? (
                        <button
                          type="button"
                          onClick={() => onOpenSession(chipSessionId)}
                          className="flex min-w-0 max-w-[280px] shrink-0 items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          title={`open session for ${item.payload.file}`}
                          aria-label={`open session for ${item.payload.file}`}
                        >
                          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                          <span className="truncate">{item.payload.file}</span>
                        </button>
                      ) : (
                        <span
                          className="flex min-w-0 max-w-[280px] shrink-0 items-center gap-1.5 font-medium text-foreground"
                          title={item.payload.file}
                        >
                          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
                          <span className="truncate">{item.payload.file}</span>
                        </span>
                      )}
                      {item.payload.events.map((e, j) => (
                        <span key={j} className="text-muted-foreground">
                          {e.kind} · {e.model ?? "?"} · {fmtMoney(e.cost ?? 0, 4)} ·{" "}
                          {e.durationMs != null ? fmtLatency(e.durationMs) : "-"} · {e.toolCalls}t
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
