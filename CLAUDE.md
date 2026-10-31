@AGENTS.md

# Split: photograph a receipt, friends tap what they had

Hackathon project, Bending Spoons "Occam" track: one feature that works perfectly. No accounts, no app install.

Flow: payer scans receipt → `/api/parse` (Claude vision) → payer checks items, enters name + BLIK phone → link `/r/<id>` → friends open it, tap their items live (SSE from the local backend in `server/`) → "You owe Bohdan 47,30 zł" + copy phone.

## Hard rules for every agent

1. **Do not add features.** If a change adds a screen, a field or a setting, stop and ask. A feature is welcome only if it removes a step.
2. **No new dependencies** without asking. Already installed: next, react, tailwind, motion, @number-flow/react, canvas-confetti, qrcode.react, @anthropic-ai/sdk, zod, nanoid, vitest, hono, @hono/node-server, tsx.
3. **No auth, no accounts, no global state library, no UI kit.** Plain Tailwind.
4. **Money is integer cents everywhere.** Never floats, never `toFixed` for math. Display only through `formatMoney()` in `src/lib/split.ts`.
5. **`ANTHROPIC_API_KEY` stays server-side** (only `server/.env`, used in `server/src/parser.ts`). Never `NEXT_PUBLIC_` it, never import `@anthropic-ai/sdk` in `src/`.
6. **Don't change `src/lib/types.ts` or the schema in `server/src/db.ts`** without the team agreeing. They are the contract.
7. **Mobile first, 390px wide**, test on a real phone through an HTTPS tunnel (`cloudflared tunnel --url http://localhost:3000`); clipboard and share need HTTPS.
8. **Claims are toggled with upsert (`active` flag), never DELETE.** The SSE snapshot replays claims on reconnect, which is only a full resync because nothing is deleted.
9. `navigator.clipboard.writeText` must be called synchronously inside the tap handler (no `await` before it), or iOS Safari ignores it.
10. Run `npm test` after touching `src/lib/split.ts` or `src/lib/parse.ts`. Keep tests green.

## File ownership (avoid merge conflicts)

| Owner | Files |
|---|---|
| Frontend | `src/app/page.tsx`, `src/app/r/[id]/receipt-view.tsx`, `src/components/`, `src/app/globals.css` |
| Backend | `server/`, `src/lib/db.ts`, `src/lib/split.ts`, `src/lib/parse.ts`, `next.config.ts` rewrites |
| Bohdan | `src/lib/prompt.ts`, `src/fixtures/`, copy texts |

## Map

- `src/lib/types.ts`: shared types
- `src/lib/split.ts`: who owes what (shared items, proportional service/tip/discount, exact rounding), `checksumDiff`
- `src/lib/parse.ts`: model output schema, qty expansion ("3 x Piwo" → 3 claimable rows)
- `src/lib/prompt.ts`: parsing prompt
- `src/lib/image.ts`: client photo compression (1568px JPEG; fixes HEIC, keeps uploads ~300 KB)
- `src/lib/db.ts`: client for the backend API (fetch + EventSource for live claims and presence)
- `server/`: local backend (Hono + SQLite + Claude), `npm run server`; API and design in `BACKEND_PLAN.md`
- `src/lib/identity.ts`: localStorage person / payer
- `src/fixtures/demo-receipt.json`: offline demo, open `/?demo=1`

## Signature animations (only these three)

1. Scan: laser line over the photo while waiting, then items appear one by one (stagger ~60ms).
2. Claim: item fills with the person's colour, avatar flies onto it (motion `layoutId`).
3. Sum: `@number-flow/react` rolls the "My share" number; confetti on the final screen.
