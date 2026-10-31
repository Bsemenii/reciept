import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { computeSplit } from "../../src/lib/split";
import type { Claim, Person } from "../../src/lib/types";
import type { Repo } from "./db";
import type { Hub } from "./hub";
import { ParseError, sniffImage, type Parser } from "./parser";
import { ClaimBodySchema, CreateReceiptSchema, ParseBodySchema, PersonSchema, SessionRowSchema, SessionUpdateSchema } from "./schemas";

const MAX_IMAGE_BASE64 = 8_000_000; // the client compresses to ~300 KB, this only stops accidents
const PARSE_PER_MINUTE = 20; // per IP; cached repeats don't reach Claude anyway
const PING_MS = 15_000; // keeps tunnels and proxies from closing idle SSE streams

type Deps = { repo: Repo; hub: Hub; parser: Parser; origins: string[] };

const fail = (c: Context, status: 400 | 404 | 413 | 415 | 422 | 429 | 500 | 502 | 504, error: string, message?: string) =>
  c.json(message ? { error, message } : { error }, status);

async function readJson<S extends z.ZodType>(c: Context, schema: S) {
  const raw = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HTTPException(400, { res: Response.json({ error: "invalid_body", message }, { status: 400 }) });
  }
  return result.data as z.infer<S>;
}

function clientIp(c: Context): string {
  // Behind the frontend proxy / tunnel every request comes from localhost, so trust the forwarded header first
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    return "local"; // app.request() in tests has no socket
  }
}

function rateLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export function createApp({ repo, hub, parser, origins }: Deps) {
  const app = new Hono();
  const allowParse = rateLimiter(PARSE_PER_MINUTE);

  const state = (id: string) => {
    const receipt = repo.getReceipt(id);
    if (!receipt) return null;
    const claims = repo.getClaims(id);
    return { receipt, claims, split: computeSplit(receipt, claims) };
  };

  app.use(logger());
  app.use(
    "/api/*",
    cors({
      origin: origins.includes("*") ? "*" : origins,
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );
  const tooLarge = (c: Context) => fail(c, 413, "image_too_large");
  app.use("/api/parse", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: tooLarge }));
  app.use("/api/receipts/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, 413, "body_too_large") }));
  app.use("/api/receipts", bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, 413, "body_too_large") }));
  app.use("/api/sessions", bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, 413, "body_too_large") }));
  app.use("/api/sessions/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, 413, "body_too_large") }));

  // streamSSE sets plain "no-cache". no-transform stops the Next dev proxy (and tunnels) from
  // gzipping the stream, which buffers events until the connection closes.
  const unbuffered = async (c: Context, next: () => Promise<void>) => {
    await next();
    c.res.headers.set("Cache-Control", "no-cache, no-transform");
    c.res.headers.set("X-Accel-Buffering", "no");
  };
  app.use("/api/receipts/:id/events", unbuffered);
  app.use("/api/sessions/:id/events", unbuffered);

  app.get("/api/health", (c) =>
    c.json({ ok: true, model: parser.model, mock: parser.model === "mock", db: repo.ping() ? "ok" : "down", sse_clients: hub.connections() }),
  );

  // Photo -> draft receipt. Body: { image: base64 without "data:" prefix }. ?demo=1 skips Claude.
  app.post("/api/parse", async (c) => {
    const { image } = await readJson(c, ParseBodySchema);
    if (!image) return fail(c, 400, "no_image");
    if (image.length > MAX_IMAGE_BASE64) return tooLarge(c);
    const demo = c.req.query("demo") !== undefined || parser.model === "mock";
    const mediaType = sniffImage(image);
    if (!demo && mediaType === "heic") return fail(c, 415, "heic_unsupported");
    if (!demo && !mediaType) return fail(c, 400, "not_an_image");
    if (!allowParse(clientIp(c))) return fail(c, 429, "busy");

    try {
      const out = await parser.parse(image, mediaType === "heic" || !mediaType ? "image/jpeg" : mediaType, demo);
      console.log(`parse model=${out.model} ms=${out.ms} cached=${out.cached} items=${out.receipt.items.length} diff=${out.checksum_diff}`);
      return c.json(out);
    } catch (e) {
      if (e instanceof ParseError) return fail(c, e.status, e.code);
      throw e;
    }
  });

  app.post("/api/receipts", async (c) => {
    const body = await readJson(c, CreateReceiptSchema);
    const id = repo.createReceipt(body);
    return c.json({ id }, 201);
  });

  app.get("/api/receipts/:id", (c) => {
    const s = state(c.req.param("id"));
    return s ? c.json(s) : fail(c, 404, "not_found");
  });

  // Claim or unclaim one item. Idempotent: sending the same `active` twice changes nothing.
  app.put("/api/receipts/:id/claims", async (c) => {
    const id = c.req.param("id");
    const { item_id, person, active } = await readJson(c, ClaimBodySchema);
    const receipt = repo.getReceipt(id);
    if (!receipt) return fail(c, 404, "not_found");
    if (!receipt.items.some((i) => i.id === item_id)) return fail(c, 400, "unknown_item");

    const claim: Claim = {
      receipt_id: id,
      item_id,
      person_id: person.id,
      person_name: person.name,
      color: person.color,
      active,
    };
    repo.setClaim(claim);
    const split = computeSplit(receipt, repo.getClaims(id));
    hub.broadcast(id, "claim", { claim, split });
    return c.json({ claim, split });
  });

  // Live view. Without person_* query params the client watches but doesn't count as online.
  app.get("/api/receipts/:id/events", (c) => {
    const id = c.req.param("id");
    if (!repo.getReceipt(id)) return fail(c, 404, "not_found");
    const q = c.req.query();
    const parsed = PersonSchema.safeParse({ id: q.person_id, name: q.name, color: q.color });
    const person: Person | null = parsed.success ? parsed.data : null;

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => {
        if (!stream.aborted) stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };
      // Snapshot and join happen in the same tick, so no claim can slip in between them.
      // The snapshot is re-sent on every reconnect, so clients never drift.
      const others = hub.online(id).filter((p) => p.id !== person?.id);
      const snapshot = { ...state(id), online: person ? [...others, person] : others };
      stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot), retry: 2000 }).catch(() => {});
      const leave = hub.join(id, person, send, () => stream.abort());

      const ping = setInterval(() => send("ping", {}), PING_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      leave();
    });
  });

  // SplitCheck frontend: session snapshots with compare-and-set, the same four operations as its
  // Supabase port (select / insert / updateIfVersion / watch), so its transport logic stays as is.
  const room = (id: string) => `session:${id}`;

  app.get("/api/sessions/:id", (c) => {
    const row = repo.getSession(c.req.param("id"));
    return row ? c.json(row) : fail(c, 404, "not_found");
  });

  app.post("/api/sessions", async (c) => {
    const row = await readJson(c, SessionRowSchema);
    if (!repo.insertSession(row)) return c.json({ error: "exists" }, 409);
    hub.broadcast(room(row.id), "row", row);
    return c.json({ ok: true }, 201);
  });

  // 409 version_conflict = someone wrote first: the client re-reads and applies its change again
  app.put("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const { version, expected_version, data } = await readJson(c, SessionUpdateSchema);
    if (data.id !== id) return fail(c, 400, "invalid_body", "data.id must match the url");
    if (!repo.getSession(id)) return fail(c, 404, "not_found");
    const row = { id, version, data };
    if (!repo.updateSession(row, expected_version)) return c.json({ error: "version_conflict" }, 409);
    hub.broadcast(room(id), "row", row);
    return c.json({ ok: true });
  });

  // "ready" on every (re)connect: the client re-reads once, so nothing written while it was away is lost
  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => {
        if (!stream.aborted) stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      };
      const leave = hub.join(room(id), null, send, () => stream.abort());
      stream.writeSSE({ event: "ready", data: "{}", retry: 2000 }).catch(() => {});
      const ping = setInterval(() => send("ping", {}), PING_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      leave();
    });
  });

  app.notFound((c) => fail(c, 404, "not_found"));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return fail(c, 500, "internal");
  });

  return app;
}
