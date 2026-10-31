import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { customAlphabet } from "nanoid";
import type { Claim, Receipt } from "../../src/lib/types";

// Same contract as supabase/schema.sql. Items are stored as JSON, money as integer cents.
const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists receipts (
  id             text primary key,
  payer_name     text not null,
  payer_phone    text not null default '',
  currency       text not null default 'PLN',
  items          text not null,
  service_cents  integer not null default 0,
  tip_cents      integer not null default 0,
  discount_cents integer not null default 0,
  total_cents    integer not null,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists claims (
  receipt_id  text not null references receipts(id) on delete cascade,
  item_id     text not null,
  person_id   text not null,
  person_name text not null,
  color       text not null,
  active      integer not null default 1,
  updated_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (receipt_id, item_id, person_id)
);

create table if not exists parse_cache (
  image_sha256 text not null,
  model        text not null,
  result       text not null,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (image_sha256, model)
);
`;

// No look-alike characters, short enough to read off a screen.
const newId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 8);

export type NewReceipt = Omit<Receipt, "id" | "created_at">;
export type Repo = ReturnType<typeof openDb>;

type Row = Record<string, unknown>;

function toReceipt(row: Row): Receipt {
  return {
    id: row.id as string,
    payer_name: row.payer_name as string,
    payer_phone: row.payer_phone as string,
    currency: row.currency as string,
    items: JSON.parse(row.items as string),
    service_cents: row.service_cents as number,
    tip_cents: row.tip_cents as number,
    discount_cents: row.discount_cents as number,
    total_cents: row.total_cents as number,
    created_at: row.created_at as string,
  };
}

function toClaim(row: Row): Claim {
  return {
    receipt_id: row.receipt_id as string,
    item_id: row.item_id as string,
    person_id: row.person_id as string,
    person_name: row.person_name as string,
    color: row.color as string,
    active: row.active === 1,
  };
}

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const insertReceipt = db.prepare(
    `insert into receipts (id, payer_name, payer_phone, currency, items, service_cents, tip_cents, discount_cents, total_cents)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectReceipt = db.prepare("select * from receipts where id = ?");
  const selectClaims = db.prepare("select * from claims where receipt_id = ? order by updated_at");
  // Toggle with upsert, never DELETE: the claim history is the source of truth for the live view.
  const upsertClaim = db.prepare(
    `insert into claims (receipt_id, item_id, person_id, person_name, color, active, updated_at)
     values (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     on conflict (receipt_id, item_id, person_id) do update set
       person_name = excluded.person_name, color = excluded.color,
       active = excluded.active, updated_at = excluded.updated_at`,
  );
  const selectCache = db.prepare("select result from parse_cache where image_sha256 = ? and model = ?");
  const insertCache = db.prepare(
    "insert or replace into parse_cache (image_sha256, model, result) values (?, ?, ?)",
  );
  const deleteOld = db.prepare("delete from receipts where created_at < ?");
  const deleteOldCache = db.prepare("delete from parse_cache where created_at < ?");

  return {
    createReceipt(r: NewReceipt): string {
      for (let attempt = 0; ; attempt++) {
        const id = newId();
        try {
          insertReceipt.run(
            id, r.payer_name, r.payer_phone, r.currency, JSON.stringify(r.items),
            r.service_cents, r.tip_cents, r.discount_cents, r.total_cents,
          );
          return id;
        } catch (e) {
          // ~1e12 ids, a collision is practically impossible, but retry instead of failing
          if (attempt < 3 && String(e).includes("UNIQUE")) continue;
          throw e;
        }
      }
    },

    getReceipt(id: string): Receipt | null {
      const row = selectReceipt.get(id) as Row | undefined;
      return row ? toReceipt(row) : null;
    },

    getClaims(receiptId: string): Claim[] {
      return (selectClaims.all(receiptId) as Row[]).map(toClaim);
    },

    setClaim(c: Claim): Claim {
      upsertClaim.run(c.receipt_id, c.item_id, c.person_id, c.person_name, c.color, c.active ? 1 : 0);
      return c;
    },

    getCachedParse<T>(sha256: string, model: string): T | null {
      const row = selectCache.get(sha256, model) as Row | undefined;
      return row ? (JSON.parse(row.result as string) as T) : null;
    },

    cacheParse(sha256: string, model: string, result: unknown) {
      insertCache.run(sha256, model, JSON.stringify(result));
    },

    deleteOlderThan(hours: number): number {
      const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
      deleteOldCache.run(cutoff);
      return Number(deleteOld.run(cutoff).changes);
    },

    ping(): boolean {
      return db.prepare("select 1 as ok").get() !== undefined;
    },

    close() {
      db.close();
    },
  };
}
