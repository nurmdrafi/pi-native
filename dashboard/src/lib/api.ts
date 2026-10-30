import type { LivePayload, SessionDetail, Snapshot } from "@/types";

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

export async function fetchDetail(sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`detail ${res.status}`);
  return res.json();
}

export interface LiveConnection {
  close: () => void;
}

/** One SSE stream carries both snapshot refreshes and live turn events. */
export function connect(
  onSnapshot: (s: Snapshot) => void,
  onLive: (p: LivePayload) => void,
  onState: (connected: boolean) => void,
): LiveConnection {
  const es = new EventSource("/api/stream");
  es.addEventListener("snapshot", (e) => {
    try {
      onSnapshot(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  es.addEventListener("live", (e) => {
    try {
      onLive(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return { close: () => es.close() };
}
