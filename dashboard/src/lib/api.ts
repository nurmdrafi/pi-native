import type { LivePayload, SessionDetail, Snapshot } from "@/types";

export interface DateRange {
  from: string | null;
  to: string | null;
}

const rangeQuery = (range?: DateRange): string => {
  if (!range || (!range.from && !range.to)) return "";
  const q = new URLSearchParams();
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  return `?${q.toString()}`;
};

export async function fetchSnapshot(range?: DateRange): Promise<Snapshot> {
  const res = await fetch(`/api/sessions${rangeQuery(range)}`);
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

/** One SSE stream carries both snapshot refreshes and live turn events. The
 * date window rides the stream URL, so a range change re-subscribes once. */
export function connect(
  onSnapshot: (s: Snapshot) => void,
  onLive: (p: LivePayload) => void,
  onState: (connected: boolean) => void,
  range?: DateRange,
): LiveConnection {
  const es = new EventSource(`/api/stream${rangeQuery(range)}`);
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
