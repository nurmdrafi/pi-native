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

export function subscribeLive(onLive: (payload: LivePayload) => void): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("live", (e) => {
    try {
      onLive(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  return () => es.close();
}
