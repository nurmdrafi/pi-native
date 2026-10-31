import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bell,
  BellOff,
  Calendar as CalendarIcon,
  LayoutDashboard,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  RefreshCw,
  Rows3,
  ShieldAlert,
  Sun,
  Bot,
  Download,
} from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LiveTab, type FeedItem } from "@/components/LiveTab";
import { OverviewTab } from "@/components/OverviewTab";
import { GateTab } from "@/components/GateTab";
import { SessionsTab } from "@/components/SessionsTab";
import { SubagentsTab } from "@/components/SubagentsTab";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SessionDetailPanel } from "@/components/SessionDetail";
import { connect, fetchDetail, fetchSnapshot, type DateRange } from "@/lib/api";
import { buildPayload, downloadFile, exportBaseName, payloadToCsv } from "@/lib/export";

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Local YYYY-MM-DD: the day the calendar picked, without timezone drift. */
const toDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const formatDay = (day: string) =>
  midnight(new Date(`${day}T00:00:00`)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** The date filter as the compact label the chrome shows. */
const filterLabel = (filter: DateFilter) =>
  filter.kind === "day"
    ? formatDay(filter.day)
    : filter.kind === "window"
      ? `last ${filter.span} days`
      : "show all";

/** Window for the active date filter: all history, a rolling window anchored
 * on today (re-anchored on every load), or one picked day. Both windows are
 * bounded on both ends so their numbers stop at midnight. */
function filterRange(filter: DateFilter): DateRange {
  if (filter.kind === "all") return { from: null, to: null };
  if (filter.kind === "window") {
    const today = midnight(new Date());
    const from = new Date(today);
    from.setDate(from.getDate() - (filter.span - 1));
    const to = new Date(today);
    to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() };
  }
  const start = midnight(new Date(`${filter.day}T00:00:00`));
  if (Number.isNaN(start.getTime())) return { from: null, to: null };
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}

/** Compact age, the DESIGN duration scale: 12s, 4m, 2h 14m, 3d 4h. */
function ageShort(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const TABS = [
  { id: "overview", label: "overview", icon: LayoutDashboard },
  { id: "sessions", label: "sessions", icon: Rows3 },
  { id: "subagents", label: "subagents", icon: Bot },
  { id: "gate", label: "permission gate", icon: ShieldAlert },
  { id: "live", label: "live", icon: Activity },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** The date filter the hash carries: all history (neither param present), a
 * rolling window (`window=7d` / `window=30d`), or one picked day
 * (`day=YYYY-MM-DD`). */
type DateFilter =
  | { kind: "all" }
  | { kind: "window"; span: 7 | 30 }
  | { kind: "day"; day: string };

/** Full routing state in the hash: the tab plus the date filter and an
 * optional drill-in target, so any view is bookmarkable and survives reload.
 * `#/gate?day=2026-10-30`, `#/live?window=7d`, `#/overview?session=<id>`. */
interface HashState {
  tab: TabId;
  date: DateFilter;
  session: string | null;
}

function readHash(): HashState {
  const [path, query] = location.hash.replace(/^[#/]+/, "").split("?");
  const id = path.split("/")[0];
  const params = new URLSearchParams(query ?? "");
  const day = params.get("day");
  const window = params.get("window");
  // A picked day wins over a rolling window; unknown values fall back to all
  // history, so old and hand-edited hashes stay harmless.
  const date: DateFilter =
    day && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? { kind: "day", day }
      : window === "7d" || window === "30d"
        ? { kind: "window", span: window === "7d" ? 7 : 30 }
        : { kind: "all" };
  return {
    tab: (TABS.some((t) => t.id === id) ? id : "overview") as TabId,
    date,
    session: params.get("session"),
  };
}

function writeHash(tab: TabId, date: DateFilter, session: string | null = null) {
  const params = new URLSearchParams();
  if (date.kind === "day") params.set("day", date.day);
  else if (date.kind === "window") params.set("window", `${date.span}d`);
  if (session) params.set("session", session);
  const qs = params.toString();
  const next = `/${tab}${qs ? `?${qs}` : ""}`;
  if (location.hash !== `#${next}`) location.hash = next;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<import("./types").Snapshot | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [{ tab: initTab, date: initDate }] = useState(readHash);
  const [tab, setTab] = useState<TabId>(initTab);
  // Date window for every number on every tab: all history by default, or a
  // rolling window, today, or one picked day.
  const [date, setDate] = useState<DateFilter>(initDate);
  const [dateOpen, setDateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const range = useMemo(() => filterRange(date), [date]);
  // Sidebar collapse survives reloads; the layout only collapses on wide screens.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("pi-dash-sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      try {
        localStorage.setItem("pi-dash-sidebar", open ? "closed" : "open");
      } catch {
        // Private mode: the preference just does not persist.
      }
      return !open;
    });
  const [refreshing, setRefreshing] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [notify, setNotify] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  // One tick per second keeps the header's ages honest without a re-render
  // anywhere else: only the span reading `now` depends on it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  // Drill-in from the subagents tab: fetch a session's detail on demand and
  // show it in the same dialog the sessions tab uses.
  const [detail, setDetail] = useState<import("./types").SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // The session the dialog is fetching or showing; drives retries and keeps
  // hash-driven opens from refetching an id that is already on screen.
  const openSessionIdRef = useRef<string | null>(null);

  async function openSession(sessionId: string) {
    openSessionIdRef.current = sessionId;
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await fetchDetail(sessionId));
    } catch (e) {
      setDetail(null);
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeSessionDetail() {
    openSessionIdRef.current = null;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    // A deep link put the session in the hash; closing the dialog clears it.
    const cur = readHash();
    if (cur.session) writeHash(cur.tab, cur.date, null);
  }

  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      setTab(next.tab);
      setDate(next.date);
      if (next.session && next.session !== openSessionIdRef.current) {
        void openSession(next.session);
      } else if (!next.session && openSessionIdRef.current) {
        closeSessionDetail();
      }
    };
    // The initial call catches a `session=` deep link on load; later calls
    // follow back/forward and in-app navigation alike.
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goTo = useCallback(
    (id: TabId) => {
      writeHash(id, date);
      setTab(id);
    },
    [date],
  );

  const pickDate = useCallback(
    (next: DateFilter) => {
      writeHash(tab, next);
      setDate(next);
    },
    [tab],
  );

  // One drill-in mechanism for every tab: the session lands in the hash, the
  // hashchange handler opens the shared detail dialog, and the URL stays
  // shareable. Toggling the day or tab drops the param and closes the dialog.
  const openSessionDeep = useCallback(
    (sessionId: string) => {
      writeHash(tab, date, sessionId);
    },
    [tab, date],
  );

  useEffect(() => {
    let closed = false;
    fetchSnapshot(range)
      .then((s) => {
        if (!closed) setSnapshot(s);
      })
      .catch((e: Error) => {
        if (!closed) setError(e.message);
      });
    const conn = connect(
      (s) => {
        setSnapshot(s);
        setError(null);
      },
      (payload) => {
        setFeed((prev) =>
          [{ at: new Date().toISOString().slice(11, 19), payload }, ...prev].slice(0, 200),
        );
      },
      setConnected,
      range,
    );
    return () => {
      closed = true;
      conn.close();
    };
  }, [range]);

  const retry = () => {
    setError(null);
    fetchSnapshot(range)
      .then(setSnapshot)
      .catch((e: Error) => setError(e.message));
  };

  const retryDetail = () => {
    const id = openSessionIdRef.current;
    if (id) void openSession(id);
  };

  /** Pull a fresh snapshot for the current window on demand — the stream keeps
   * the view live, this covers "I just ran something, show it now". */
  const refresh = () => {
    setRefreshing(true);
    fetchSnapshot(range)
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  // Over-budget notifications fire only while the user opted in.
  const seenAlerts = useRef<Set<string>>(new Set());
  useEffect(() => {
    const over = (snapshot?.aggregates.alerts ?? []).filter((a) => a.level === "over");
    if (over.length === 0 || notify !== "granted") return;
    for (const a of over) {
      if (seenAlerts.current.has(a.sessionId)) continue;
      seenAlerts.current.add(a.sessionId);
      new Notification("session over budget", {
        body: `${a.sessionId.slice(0, 12)} · ${a.project.split("/").pop()} · $${a.cost.toFixed(2)} / $${a.budget.toFixed(2)}`,
      });
    }
  }, [snapshot, notify]);

  async function toggleNotifications() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotify(result);
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("dash-theme", next ? "dark" : "light");
  }

  if (error && !snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div role="alert" className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">failed to load sessions</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
            retry
          </Button>
        </div>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="min-h-screen bg-background text-foreground" aria-busy="true" aria-label="loading dashboard">
        <div className="flex h-12 items-center gap-3 border-b px-4 lg:px-6">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-4 w-14" />
        </div>
        <div className="lg:grid lg:grid-cols-[224px_1fr]">
          <aside className="hidden space-y-1 border-r p-3 lg:block">
            {Array.from({ length: TABS.length }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </aside>
          <main className="space-y-4 p-4 lg:p-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[107px] w-full" />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[107px] w-full" />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/75 backdrop-blur-xl backdrop-saturate-150">
        <div className="flex h-12 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6">
          <TooltipProvider>
          <Radio className="hidden size-4 text-foreground sm:block" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            className="hidden size-7 lg:inline-flex"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? "collapse sidebar" : "expand sidebar"}
            aria-pressed={!sidebarOpen}
          >
            {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </Button>
          <h1 className="text-[13px] font-semibold">pi sessions</h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="hidden text-xs text-muted-foreground sm:inline"
                tabIndex={0}
              >
                {snapshot.aggregates.totals.sessions} sessions · indexed{" "}
                {ageShort(now - Date.parse(snapshot.generatedAt))} ago
                {snapshot.serverStartedAt
                  ? ` · server up ${ageShort(now - Date.parse(snapshot.serverStartedAt))}`
                  : ""}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              snapshot {snapshot.generatedAt}
              {snapshot.serverStartedAt ? ` · server started ${snapshot.serverStartedAt}` : ""}
            </TooltipContent>
          </Tooltip>
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs font-normal"
                aria-label="date range"
              >
                <CalendarIcon className="size-3.5" aria-hidden />
                {filterLabel(date)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="single"
                selected={
                  date.kind === "day" ? midnight(new Date(`${date.day}T00:00:00`)) : undefined
                }
                onSelect={(picked) => {
                  pickDate(picked ? { kind: "day", day: toDay(picked) } : { kind: "all" });
                  setDateOpen(false);
                }}
                autoFocus
              />
              <div className="grid grid-cols-2 gap-1 border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  aria-pressed={date.kind === "all"}
                  onClick={() => {
                    pickDate({ kind: "all" });
                    setDateOpen(false);
                  }}
                >
                  show all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  aria-pressed={date.kind === "day" && date.day === toDay(new Date())}
                  onClick={() => {
                    pickDate({ kind: "day", day: toDay(new Date()) });
                    setDateOpen(false);
                  }}
                >
                  today
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  aria-pressed={date.kind === "window" && date.span === 7}
                  onClick={() => {
                    pickDate({ kind: "window", span: 7 });
                    setDateOpen(false);
                  }}
                >
                  last 7 days
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  aria-pressed={date.kind === "window" && date.span === 30}
                  onClick={() => {
                    pickDate({ kind: "window", span: 30 });
                    setDateOpen(false);
                  }}
                >
                  last 30 days
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={exportOpen} onOpenChange={setExportOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs font-normal"
                aria-label="export the current window"
              >
                <Download className="size-3.5" aria-hidden />
                export
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 p-2" align="end">
              <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                window: {filterLabel(date)} ·{" "}
                {snapshot.aggregates.totals.sessions} sessions
              </p>
              <div className="grid gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 justify-start px-2 text-xs"
                  onClick={() => {
                    const payload = buildPayload(snapshot);
                    downloadFile(
                      `pi-sessions-${exportBaseName(snapshot)}.json`,
                      JSON.stringify(payload, null, 2),
                      "application/json",
                    );
                    setExportOpen(false);
                  }}
                >
                  download json
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 justify-start px-2 text-xs"
                  onClick={() => {
                    const payload = buildPayload(snapshot);
                    downloadFile(
                      `pi-sessions-${exportBaseName(snapshot)}.csv`,
                      payloadToCsv(payload),
                      "text/csv",
                    );
                    setExportOpen(false);
                  }}
                >
                  download csv
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`ml-auto inline-flex items-center gap-1.5 text-xs ${
                  connected ? "text-ok-foreground" : "text-muted-foreground"
                }`}
                role="status"
                tabIndex={0}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    connected ? "animate-pulse bg-ok" : "bg-muted-foreground/50"
                  }`}
                />
                <span className="hidden sm:inline">{connected ? "live" : "connecting"}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {connected ? "receiving live updates" : "connecting to the live stream"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={refresh}
                aria-label="refresh now"
                disabled={refreshing}
              >
                <RefreshCw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">refresh now</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={toggleNotifications}
            aria-label={
              notify === "granted"
                ? "notifications on"
                : notify === "denied"
                  ? "notifications blocked by browser"
                  : "enable over-budget notifications"
            }
            aria-pressed={notify === "granted"}
            disabled={notify === "unsupported" || notify === "denied"}
          >
            {notify === "granted" ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={toggleTheme}
            aria-label={dark ? "switch to light theme" : "switch to dark theme"}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          </TooltipProvider>
        </div>
        {/* Mobile nav strip */}
        <nav aria-label="sections" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:hidden">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => goTo(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <t.icon className="size-3.5" aria-hidden />
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div
        className={
          sidebarOpen
            ? "lg:grid lg:grid-cols-[224px_1fr]"
            : "lg:grid lg:grid-cols-[56px_1fr]"
        }
      >
        <aside className="hidden border-r bg-sidebar/80 backdrop-blur-xl backdrop-saturate-150 lg:block">
          <nav aria-label="sections" className="sticky top-12 space-y-1 p-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => goTo(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                title={t.label}
                aria-label={sidebarOpen ? undefined : t.label}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors ${
                  sidebarOpen ? "" : "justify-center px-0"
                } ${
                  tab === t.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <t.icon className="size-4 shrink-0" aria-hidden />
                {sidebarOpen ? <span className="truncate">{t.label}</span> : null}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 p-4 lg:p-6">
          <ErrorBoundary key={tab} label={`${tab} tab`}>
            {tab === "overview" && <OverviewTab snapshot={snapshot} onOpenSession={openSessionDeep} />}
            {tab === "sessions" && <SessionsTab snapshot={snapshot} />}
            {tab === "subagents" && (
              <SubagentsTab snapshot={snapshot} onOpenSession={openSessionDeep} />
            )}
            {tab === "gate" && <GateTab snapshot={snapshot} />}
            {tab === "live" && (
              <LiveTab
                snapshot={snapshot}
                feed={feed}
                connected={connected}
                onOpenSession={openSessionDeep}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>

      <Dialog
        open={detailLoading || !!detail || !!detailError}
        onOpenChange={(open) => {
          if (!open) closeSessionDetail();
        }}
      >
        <DialogContent className="h-[90vh] w-[min(68.75rem,94vw)]" aria-describedby={undefined}>
          <DialogTitle>session detail</DialogTitle>
          {detailLoading && (
            <div
              className="flex min-h-0 flex-1 flex-col gap-4"
              aria-busy="true"
              aria-label="loading session detail"
            >
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-44 w-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-44 w-full" />
              </div>
            </div>
          )}
          {detailError && (
            <div
              role="alert"
              className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="min-w-0 grow">failed to load session detail: {detailError}</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={retryDetail}>
                retry
              </Button>
            </div>
          )}
          {detail ? (
            <SessionDetailPanel
              key={detail.sessionId}
              detail={detail}
              onClose={closeSessionDetail}
              onOpenSession={openSessionDeep}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
