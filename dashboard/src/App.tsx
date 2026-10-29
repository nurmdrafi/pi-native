import { useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LiveTab, type FeedItem } from "@/components/LiveTab";
import { OverviewTab } from "@/components/OverviewTab";
import { GateTab } from "@/components/GateTab";
import { SessionsTab } from "@/components/SessionsTab";
import { SubagentsTab } from "@/components/SubagentsTab";
import { fetchSnapshot, subscribeLive } from "@/lib/api";
import type { Snapshot } from "@/types";

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let closed = false;
    fetchSnapshot()
      .then((s) => {
        if (!closed) setSnapshot(s);
      })
      .catch((e: Error) => {
        if (!closed) setError(e.message);
      });
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      try {
        setSnapshot(JSON.parse((e as MessageEvent).data));
        setConnected(true);
      } catch {
        // Ignore malformed frames.
      }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const unsubscribe = subscribeLive((payload) => {
      setFeed((prev) =>
        [{ at: new Date().toISOString().slice(11, 19), payload }, ...prev].slice(0, 100),
      );
    });
    return () => {
      closed = true;
      es.close();
      unsubscribe();
    };
  }, []);

  const seenAlerts = useRef<Set<string>>(new Set());
  useEffect(() => {
    const over = (snapshot?.aggregates.alerts ?? []).filter((a) => a.level === "over");
    if (over.length === 0 || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const a of over) {
      if (seenAlerts.current.has(a.sessionId)) continue;
      seenAlerts.current.add(a.sessionId);
      new Notification("session over budget", {
        body: `${a.sessionId.slice(0, 12)} · ${a.project.split("/").pop()} · $${a.cost.toFixed(2)} / $${a.budget.toFixed(2)}`,
      });
    }
  }, [snapshot]);

  useEffect(() => {
    const ask = () => {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
      }
      window.removeEventListener("pointerdown", ask);
    };
    window.addEventListener("pointerdown", ask);
    return () => window.removeEventListener("pointerdown", ask);
  }, []);

  if (error) {
    return <div className="p-8 text-sm text-red-400">failed to load: {error}</div>;
  }
  if (!snapshot) {
    return <div className="p-8 text-sm text-muted-foreground">loading…</div>;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-baseline gap-4 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <h1 className="text-sm font-semibold">pi sessions</h1>
        <span className="text-xs text-muted-foreground">
          {snapshot.aggregates.totals.sessions} sessions · updated{" "}
          {snapshot.generatedAt.slice(11, 19)} UTC
        </span>
        <span className={`ml-auto text-xs ${connected ? "text-green-500" : "text-muted-foreground"}`}>
          {connected ? "● live" : "○ connecting…"}
        </span>
      </header>
      <main className="p-6">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">overview</TabsTrigger>
            <TabsTrigger value="sessions">sessions</TabsTrigger>
            <TabsTrigger value="subagents">subagents</TabsTrigger>
            <TabsTrigger value="gate">permission gate</TabsTrigger>
            <TabsTrigger value="live">live</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-4">
            <OverviewTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="sessions" className="mt-4">
            <SessionsTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="subagents" className="mt-4">
            <SubagentsTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="gate" className="mt-4">
            <GateTab snapshot={snapshot} />
          </TabsContent>
          <TabsContent value="live" className="mt-4">
            <LiveTab snapshot={snapshot} feed={feed} connected={connected} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
