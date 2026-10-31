# Split — план бекенду (локально, Claude API, фронт окремо)

## 0. Що є зараз і що міняємо

**Зараз** бекенду як такого немає:
- `src/app/api/parse/route.ts` — єдиний серверний ендпоінт (Next.js route, Claude vision → структурований чек).
- Все інше (створення чека, клейми, realtime, presence) фронт робить **напряму в Supabase** з браузера (`src/lib/db.ts`).
- Розраховано на Vercel (ліміт 4.5 MB, `maxDuration`, HTTPS для камери).

**Ціль:**
- Окремий процес бекенду, який запускається однією командою на ноутбуці, без Vercel і без Supabase.
- Фронт (Next/Vite — не важливо) ходить у бекенд лише через HTTP + SSE.
- Вся логіка «хто скільки винен» і валідація — на сервері (фронт може рахувати оптимістично тим самим `split.ts`).
- Ключ `ANTHROPIC_API_KEY` живе тільки в `server/.env`.

**Що лишається без змін (це вже добре зроблено, переносимо як є):**
`types.ts` (контракт), `split.ts` (гроші в центах, largest remainder), `parse.ts` (zod-схема + розгортання qty), `prompt.ts`, тести vitest.

---

## 1. Стек

| Що | Вибір | Чому |
|---|---|---|
| Мова | **TypeScript (Node 24)** | Перевикористовуємо `types.ts`, `split.ts`, `parse.ts`, `prompt.ts` і тести 1:1. Python означав би переписати грошову математику й дублювати контракт. |
| HTTP | **Hono** + `@hono/node-server` | Маленький, має SSE-хелпер, `app.request()` для тестів без сервера. |
| БД | **SQLite через вбудований `node:sqlite`** | Нуль залежностей, один файл `server/data/split.db`, WAL-режим. Для одного процесу на хакатоні — ідеально. |
| Realtime | **SSE** (`EventSource`) + звичайні POST/PUT | Сервер → клієнт потік, автоперепідключення вбудоване в браузер, presence = активні SSE-з'єднання. WebSocket тут зайвий. |
| LLM | `@anthropic-ai/sdk` (вже є), `messages.parse` + `zodOutputFormat` | Вже працює в поточному роуті; переносимо. |
| Валідація | `zod` (вже є) | Всі вхідні тіла через схеми. |
| Запуск | `tsx watch` | Без білду. |

Нові залежності (за правилом №2 з `CLAUDE.md` — погодити з командою): `hono`, `@hono/node-server`, `tsx` (dev).

---

## 2. Структура

```
split/
  src/lib/            ← спільний код (types, split, parse, prompt) — фронт і бек імпортують звідси
  server/
    package.json      ← "dev": "tsx watch src/index.ts"
    tsconfig.json     ← paths: "@shared/*" → "../src/lib/*"
    .env              ← ANTHROPIC_API_KEY, PARSE_MODEL, PORT, FRONTEND_ORIGIN, MOCK_PARSE
    data/split.db     ← створюється автоматично (у .gitignore)
    src/
      index.ts        ← старт сервера, graceful shutdown
      app.ts          ← Hono app: CORS, ліміти, роутинг, обробка помилок
      env.ts          ← zod-валідація env, падаємо одразу, якщо ключа нема (крім MOCK_PARSE=1)
      db.ts           ← node:sqlite, міграція при старті, репозиторій (receipts, claims)
      hub.ts          ← in-memory pub/sub: receiptId → Set<SSE-клієнт>, presence
      parser.ts       ← клієнт Anthropic: parse(image) з таймаутом, кешем, семафором і мок-режимом
      schemas.ts      ← zod-схеми тіл запитів
                        (усі роути — в app.ts, це ~150 рядків, окремі файли не потрібні)
    test/
      api.test.ts     ← app.request(), без мережі (MOCK_PARSE)
    scripts/
      eval-parse.ts   ← прогін фото з fixtures/ по моделях: латентність + % чеків, що сходяться
```

`src/lib/*.ts` (крім `db.ts`, `identity.ts`, `image.ts` — вони клієнтські) — чисті модулі без `"use client"`, тому бек імпортує їх напряму.

---

## 3. Модель даних (SQLite)

```sql
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists receipts (
  id             text primary key,          -- nanoid 8 символів, без схожих літер
  payer_name     text not null,
  payer_phone    text not null default '',
  currency       text not null default 'PLN',
  items          text not null,             -- JSON Item[]
  service_cents  integer not null default 0,
  tip_cents      integer not null default 0,
  discount_cents integer not null default 0,
  total_cents    integer not null,
  created_at     text not null default (datetime('now'))
);

create table if not exists claims (
  receipt_id  text not null references receipts(id) on delete cascade,
  item_id     text not null,
  person_id   text not null,
  person_name text not null,
  color       text not null,
  active      integer not null default 1,   -- toggle, ніколи не DELETE (як і було)
  updated_at  text not null default (datetime('now')),
  primary key (receipt_id, item_id, person_id)
);

create table if not exists parse_cache (
  image_sha256 text primary key,            -- повторне фото / ретрай = без повторного виклику Claude
  model        text not null,
  result       text not null,               -- JSON { receipt, checksum_diff }
  created_at   text not null default (datetime('now'))
);
```

Чистка: раз на годину видаляємо чеки старші за 24 год (`setInterval` в `index.ts`). Для демо можна вимкнути.

---

## 4. API

Базовий URL: `http://localhost:8787`. Всі помилки однакові: `{ "error": "<code>", "message"?: string }`.

### `GET /api/health`
`{ ok: true, model, mock: boolean, db: "ok" }` — фронт показує банер, якщо бек мертвий або в мок-режимі.

### `POST /api/parse`
Тіло (як зараз, щоб фронт не міняти): `{ image: base64, media_type?: "image/jpeg" | "image/png" | "image/webp" }`.

Відповідь `200`: `{ receipt: Draft, checksum_diff: number, model, ms, cached: boolean }`
де `Draft = Omit<Receipt, "id" | "payer_name" | "payer_phone" | "created_at">`.

Помилки: `400 no_image` · `413 image_too_large` (>8 MB base64; фронт і так стискає до ~300 KB) · `422 not_a_receipt` · `422 unreadable` · `429 busy` · `502 model_error` · `504 timeout`.

Логіка:
1. sha256 зображення → є в `parse_cache` → віддаємо одразу (`cached: true`).
2. `MOCK_PARSE=1` або `?demo=1` → `fixtures/demo-receipt.json` із затримкою ~1.5 с (щоб показати анімацію лазера).
3. Інакше Claude: `messages.parse`, `effort: "low"`, `AbortSignal.timeout(45_000)`, `maxRetries: 2` у клієнті SDK.
4. `expandLines` + `Math.round` + `checksumDiff` — як у поточному роуті.
5. Ліміт: не більше 2 одночасних викликів Claude (семафор) і ~10 запитів/хв на IP — захист від подвійного тапу й випадкового спаму на демо.

### `POST /api/receipts`
Тіло: `Draft + { payer_name, payer_phone }`. Сервер валідує zod-ом:
- всі суми — цілі, `price_cents >= 0`, `items` 1…200, `id` унікальні, `payer_name` 1…40 символів;
- `checksum_diff` **не блокує** (юзер міг свідомо лишити розбіжність), але повертається у відповіді.

Відповідь `201`: `{ id }`.

### `GET /api/receipts/:id`
`{ receipt, claims: Claim[], split: SplitResult }` — один запит на відкриття сторінки замість двох (`getReceipt` + `getClaims`). `404 not_found`.

### `PUT /api/receipts/:id/claims`
Тіло: `{ item_id, person: { id, name, color }, active: boolean }`.
- Перевіряємо, що чек і `item_id` існують (`404` / `400 unknown_item`).
- `INSERT … ON CONFLICT DO UPDATE` (upsert), `updated_at = now`.
- Розсилаємо подію `claim` всім підписникам чека.
- Відповідь: `{ claim, split }` — фронт може звірити свій оптимістичний стан.

Ідемпотентно: повторний PUT з тим самим `active` нічого не ламає.

### `GET /api/receipts/:id/events?person_id=&name=&color=` (SSE)
Події:
| event | data | коли |
|---|---|---|
| `snapshot` | `{ receipt, claims, split, online: Person[] }` | одразу після підключення (і після кожного перепідключення — тому фронт не втрачає стан) |
| `claim` | `{ claim, split }` | хтось тапнув позицію |
| `presence` | `{ online: Person[] }` | хтось зайшов / вийшов |
| `ping` | `{}` | кожні 15 с, щоб проксі/тунель не рвали з'єднання |

Presence: `hub.ts` тримає `Map<receiptId, Map<connId, Person>>`; `online` = унікальні `person_id`. Відключення ловимо через `stream.onAbort`.
`person_id` не обов'язковий — без нього людина тільки дивиться (екран до вводу імені).

---

## 5. Як фронту перейти (мінімальні зміни)

Переписати лише `src/lib/db.ts` з тими самими сигнатурами — компоненти не чіпаємо:

```ts
const API = process.env.NEXT_PUBLIC_API_URL ?? ""; // "" = той самий origin через проксі

export async function createReceipt(r) { /* POST /api/receipts → id */ }
export async function getReceipt(id)  { /* GET /api/receipts/:id → receipt */ }
export async function getClaims(id)   { /* з того ж GET */ }
export async function setClaim(receiptId, itemId, person, active) { /* PUT …/claims */ }
export function subscribeReceipt(receiptId, me, onClaim, onPresence) {
  const es = new EventSource(`${API}/api/receipts/${receiptId}/events?person_id=…`);
  es.addEventListener("snapshot", …); es.addEventListener("claim", …); es.addEventListener("presence", …);
  return () => es.close(); // замість supabase.removeChannel(channel)
}
```

`/api/parse` уже викликається через `fetch("/api/parse")` — працюватиме через проксі без змін. Залежність `@supabase/supabase-js` і `src/app/api/parse/route.ts` після переходу видаляємо.

**Проксі на фронті** (рекомендовано): Next `rewrites` `/api/:path*` → `http://localhost:8787/api/:path*` (або `server.proxy` у Vite). Тоді один origin, немає CORS, і для телефонів потрібен **один** тунель. SSE через Next rewrites працює, але якщо буферизує — фронт може ходити в SSE напряму на `NEXT_PUBLIC_API_URL`, CORS на бекенді це дозволяє.

---

## 6. Демо з телефонів локально (важливо!)

- `navigator.clipboard` і `navigator.share` працюють **тільки на HTTPS** (або `localhost`). Телефон, що відкриває `http://192.168.x.x:3000`, кнопку «Copy BLIK number» не виконає.
- Рішення: `cloudflared tunnel --url http://localhost:3000` (безкоштовно, без акаунта) → `https://….trycloudflare.com`. Через проксі фронту бекенд їде в той самий тунель.
- Інпут камери (`<input capture>`) працює і на HTTP, але тунель однаково потрібен для clipboard.
- План Б для сцени: `?demo=1` / `MOCK_PARSE=1` — без Claude і без інтернету для парсингу.

---

## 7. Надійність і безпека (коротко, без оверінжинірингу)

- **Ключ:** тільки `server/.env`, у `.gitignore`. ⚠️ У `Hackathon/untitled folder/*.textClipping` лежить API-ключ Anthropic відкритим текстом — не комітити цю папку, після хакатону ключ ротейтнути.
- **env.ts:** валідує змінні при старті; без ключа й без `MOCK_PARSE` — зрозуміла помилка, а не падіння на першому запиті.
- **CORS:** `FRONTEND_ORIGIN` (кома-розділений список), за замовчуванням `http://localhost:3000`.
- **Ліміти тіла:** 10 MB на `/api/parse`, 256 KB на решту.
- **Логи:** один рядок на запит (метод, шлях, статус, мс); для parse — модель, мс, cached, checksum_diff. Це ж і дані для слайда «як це працює».
- **Graceful shutdown:** на SIGINT закриваємо SSE-стріми і БД.
- **Помилки:** глобальний `app.onError` → `500 internal` + `console.error`; стектрейс клієнту не віддаємо.

---

## 8. Тести

- Наявні `split.test.ts`, `parse.test.ts` — без змін.
- `server/test/api.test.ts` (vitest, `app.request()`, `MOCK_PARSE=1`, БД `:memory:`):
  1. parse у мок-режимі → чек із `checksum_diff = 0`;
  2. create → get → 2 людини клеймлять одну позицію → `split` ділить навпіл, сума = total;
  3. toggle off → позиція знову в `unclaimedItemIds`;
  4. невалідні тіла → 400, неіснуючий чек → 404;
  5. SSE: підключення дає `snapshot`, PUT claim дає подію `claim` іншому підписнику.
- `scripts/eval-parse.ts`: усі фото з `src/fixtures/photos/` × `claude-opus-5-5` / `claude-haiku-5-5` → таблиця «модель · середні мс · % чеків, що сходяться до копійки». Допомагає вибрати `PARSE_MODEL` і дає цифру для пітчу.

---

## 9. Порядок робіт

| # | Крок | Готово, коли |
|---|---|---|
| 1 | `server/` скелет: Hono, env, CORS, `/api/health` | `curl localhost:8787/api/health` → ok |
| 2 | `/api/parse`: перенести роут, додати мок, кеш, таймаут, семафор | фото → чек; `MOCK_PARSE=1` працює без ключа |
| 3 | SQLite + `POST/GET /api/receipts` | чек створюється, переживає рестарт сервера |
| 4 | `PUT …/claims` + `hub.ts` + SSE `events` | дві вкладки бачать тапи одна одної наживо |
| 5 | Тести API + `npm test` зелений | |
| 6 | Новий `src/lib/db.ts` на фронті + проксі; прибрати Supabase | весь флоу end-to-end локально |
| 7 | Тунель, прогін на 2–3 реальних телефонах | clipboard, share, камера працюють |
| 8 | `eval-parse.ts` на реальних чеках, тюнінг `prompt.ts` | ≥80% чеків сходяться без правок |

Кроки 1–4 — бекенд, і поки вони йдуть, фронт працює на `?demo=1`. Крок 6 — точка синхронізації з фронтом.

---

## 10. Свідомо НЕ робимо

Авторизацію, редагування чека після створення, кілька валют в одному чеку, Redis/черги, Docker, деплой. Один процес Node + один файл SQLite — достатньо для демо, а `hub.ts` за потреби можна замінити на Redis pub/sub без зміни API.
