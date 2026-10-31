# Split

Photograph a receipt, send a link, friends tap what they had. No app, no accounts.

## Setup (15 min, one person)

1. **Backend**: `cp server/.env.example server/.env`, add the Anthropic key, `npm run server`.
2. **Frontend**: `npm install && npm run dev`, open http://localhost:3000/?demo=1 (no model call, demo receipt). `/api/*` is proxied to the backend; `.env.local` is optional (see `.env.example`).
3. **Phones**: `cloudflared tunnel --url http://localhost:3000` and open the `https://…trycloudflare.com` link (clipboard and share need HTTPS).

## Commands

- `npm run server`: local backend on http://localhost:8787 (`cp server/.env.example server/.env` first; `MOCK_PARSE=1` runs without a key). API: `BACKEND_PLAN.md`
- `npm run dev`: local server
- `npm test`: split math and qty expansion tests
- `npm run lint`, `npm run build`

Rules for AI agents and file ownership: see `CLAUDE.md`.
