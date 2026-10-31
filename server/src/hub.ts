import type { Person } from "../../src/lib/types";

// In-memory pub/sub for SSE clients, one room per receipt.
// Single process is enough for the demo; swap for Redis pub/sub if it ever runs on more than one.

type Send = (event: string, data: unknown) => void;
type Client = { person: Person | null; send: Send; close: () => void };

export class Hub {
  private rooms = new Map<string, Map<number, Client>>();
  private nextId = 1;

  /** Adds a client to the room and announces presence. Returns `leave`. */
  join(receiptId: string, person: Person | null, send: Send, close: () => void): () => void {
    const room = this.rooms.get(receiptId) ?? new Map<number, Client>();
    this.rooms.set(receiptId, room);
    const id = this.nextId++;
    room.set(id, { person, send, close });
    if (person) this.broadcastPresence(receiptId);

    return () => {
      if (!room.delete(id)) return;
      if (room.size === 0) this.rooms.delete(receiptId);
      if (person) this.broadcastPresence(receiptId);
    };
  }

  /** Unique people on the page right now (one person can have several tabs open). */
  online(receiptId: string): Person[] {
    const byId = new Map<string, Person>();
    for (const c of this.rooms.get(receiptId)?.values() ?? []) {
      if (c.person) byId.set(c.person.id, c.person);
    }
    return [...byId.values()];
  }

  broadcast(receiptId: string, event: string, data: unknown) {
    for (const c of this.rooms.get(receiptId)?.values() ?? []) c.send(event, data);
  }

  connections(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.size;
    return n;
  }

  closeAll() {
    for (const room of this.rooms.values()) for (const c of room.values()) c.close();
  }

  private broadcastPresence(receiptId: string) {
    this.broadcast(receiptId, "presence", { online: this.online(receiptId) });
  }
}
