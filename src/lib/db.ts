"use client";

import type { Claim, Person, Receipt } from "./types";

// Talks to the local backend (server/, see BACKEND_PLAN.md).
// "" = same origin: next.config.ts proxies /api/* to the backend, so phones need only one tunnel.
// Set NEXT_PUBLIC_API_URL=http://localhost:8787 to bypass the proxy (e.g. if it ever buffers SSE).
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // No error code = the proxy couldn't reach the backend
  if (!res.ok) throw new Error(data.error ?? "network");
  return data as T;
}

export async function createReceipt(r: Omit<Receipt, "id" | "created_at">): Promise<string> {
  const { id } = await api<{ id: string }>("/api/receipts", { method: "POST", body: JSON.stringify(r) });
  return id;
}

/** Receipt and its claims in one request. null = no such receipt (or it expired). */
export async function getReceipt(id: string): Promise<{ receipt: Receipt; claims: Claim[] } | null> {
  try {
    return await api<{ receipt: Receipt; claims: Claim[] }>(`/api/receipts/${id}`);
  } catch (e) {
    if (e instanceof Error && e.message === "not_found") return null;
    throw e;
  }
}

/** Claim or unclaim an item. Idempotent on the server, safe to retry. */
export async function setClaim(receiptId: string, itemId: string, person: Person, active: boolean) {
  await api(`/api/receipts/${receiptId}/claims`, {
    method: "PUT",
    body: JSON.stringify({ item_id: itemId, person, active }),
  });
}

/**
 * Live claims + who is on the page right now.
 * Returns an unsubscribe function; call it on unmount.
 */
export function subscribeReceipt(
  receiptId: string,
  me: Person,
  onClaim: (claim: Claim) => void,
  onPresence: (people: Person[]) => void,
): () => void {
  const q = new URLSearchParams({ person_id: me.id, name: me.name, color: me.color });
  let es: EventSource;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    es = new EventSource(`${API}/api/receipts/${receiptId}/events?${q}`);
    // Sent on every (re)connect. Claims are never deleted, only toggled, so replaying them is a full resync.
    es.addEventListener("snapshot", (e) => {
      const { claims, online } = JSON.parse(e.data) as { claims: Claim[]; online: Person[] };
      claims.forEach(onClaim);
      onPresence(online);
    });
    es.addEventListener("claim", (e) => onClaim((JSON.parse(e.data) as { claim: Claim }).claim));
    es.addEventListener("presence", (e) => onPresence((JSON.parse(e.data) as { online: Person[] }).online));
    // EventSource retries a dropped stream by itself, but gives up for good on a non-200 answer
    // (the proxy returns 500 while the backend restarts), so reopen it ourselves
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(connect, 2000);
    };
  }
  connect();

  return () => {
    clearTimeout(retry);
    es.close();
  };
}
