-- Run once in Supabase → SQL Editor.
-- Hackathon setup: no accounts, anyone with the link can read and claim. Receipts are meant to live 24h.

create table if not exists receipts (
  id text primary key,
  payer_name text not null,
  payer_phone text not null default '',
  currency text not null default 'PLN',
  items jsonb not null,               -- Item[] from src/lib/types.ts
  service_cents int not null default 0,
  tip_cents int not null default 0,
  discount_cents int not null default 0,
  total_cents int not null,
  created_at timestamptz not null default now()
);

create table if not exists claims (
  receipt_id text not null references receipts(id) on delete cascade,
  item_id text not null,
  person_id text not null,
  person_name text not null,
  color text not null,
  active boolean not null default true,  -- toggle with upsert, never DELETE: realtime filters don't apply to DELETE events
  updated_at timestamptz not null default now(),
  primary key (receipt_id, item_id, person_id)
);

alter table receipts enable row level security;
alter table claims enable row level security;

-- Without SELECT policies realtime silently sends nothing to the anon key.
create policy "read receipts" on receipts for select to anon, authenticated using (true);
create policy "create receipts" on receipts for insert to anon, authenticated with check (true);
create policy "edit receipts" on receipts for update to anon, authenticated using (true) with check (true);

create policy "read claims" on claims for select to anon, authenticated using (true);
create policy "create claims" on claims for insert to anon, authenticated with check (true);
create policy "toggle claims" on claims for update to anon, authenticated using (true) with check (true);

-- Realtime: stream claim changes to everyone on the receipt page.
alter publication supabase_realtime add table claims;
