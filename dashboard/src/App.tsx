import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bell,
  BellOff,
  LayoutDashboard,
  Moon,
  Radio,
  Rows3,
  ShieldAlert,
  Sun,
  Bot,
} from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LiveTab, type FeedItem } from "@/components/LiveTab";
import { OverviewTab } from "@/components/OverviewTab";
import { GateTab } from "@/components/GateTab";
import { SessionsTab } from "@/components/SessionsTab";
import { SubagentsTab } from "@/components/SubagentsTab";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { connect, fetchSnapshot } from "@/lib/api";

const TABS = [
  { id: "overview", label: "overview", icon: LayoutDashboard },
  { id: "sessions", label: "sessions", icon: Rows3 },
  { id: "subagents", label: "subagents", icon: Bot },
  { id: "gate", label: "permission gate", icon: ShieldAlert },
  { id: "live", label: "live", icon: Activity },
] as const;

type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  const id = location.hash.replace(/^#\/?/, "");
  return (TABS.some((t) => t.id === id) ? id : "overview") as TabId;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<import("./types").Snapshot | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [notify, setNotify] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goTo = useCallback((id: TabId) => {
    location.hash = `/${id}`;
    setTab(id);
  }, []);

  useEffect(() => {
    let closed = false;
    fetchSnapshot()
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
    );
    return () => {
      closed = true;
      conn.close();
    };
  }, []);

  const retry = () => {
    setError(null);
    fetchSnapshot()
      .then(setSnapshot)
      .catch((e: Error) => setError(e.message));
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
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
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
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="flex h-12 items-center gap-3 px-4 lg:px-6">
          <Radio className="size-4 text-primary" aria-hidden />
          <h1 className="text-[13px] font-semibold">pi sessions</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {snapshot.aggregates.totals.sessions} sessions · updated{" "}
            {snapshot.generatedAt.slice(11, 19)} UTC
          </span>
          <span
            className={`ml-auto inline-flex items-center gap-1.5 text-xs ${
              connected ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
            }`}
            role="status"
          >
            <span className={`size-1.5 rounded-full ${connected ? "bg-green-500" : "bg-muted-foreground/50"}`} />
            {connected ? "live" : "connecting"}
          </span>
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

      <div className="lg:grid lg:grid-cols-[224px_1fr]">
        <aside className="hidden border-r bg-sidebar lg:block">
          <nav aria-label="sections" className="sticky top-12 space-y-1 p-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => goTo(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors ${
                  tab === t.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <t.icon className="size-4 shrink-0" aria-hidden />
                {t.label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 p-4 lg:p-6">
          <ErrorBoundary key={tab} label={`${tab} tab`}>
            {tab === "overview" && <OverviewTab snapshot={snapshot} />}
            {tab === "sessions" && <SessionsTab snapshot={snapshot} />}
            {tab === "subagents" && <SubagentsTab snapshot={snapshot} />}
            {tab === "gate" && <GateTab snapshot={snapshot} />}
            {tab === "live" && (
              <LiveTab snapshot={snapshot} feed={feed} connected={connected} />
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
