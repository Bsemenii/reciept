import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openDb, type Repo } from "../src/db";
import { Hub } from "../src/hub";
import { createParser, sniffImage, type Draft } from "../src/parser";

let repo: Repo;
let hub: Hub;
let app: ReturnType<typeof createApp>;

const ola = { id: "p1", name: "Ola", color: "#10b981" };
const bohdan = { id: "p2", name: "Bohdan", color: "#ef4444" };

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function parseDemo(): Promise<Draft> {
  const res = await app.request("/api/parse", json("POST", { image: "AAAA" }));
  expect(res.status).toBe(200);
  return (await res.json()).receipt;
}

async function createReceipt(): Promise<string> {
  const draft = await parseDemo();
  const res = await app.request("/api/receipts", json("POST", { ...draft, payer_name: "Bohdan", payer_phone: "500600700" }));
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

const claim = (id: string, item_id: string, person: typeof ola, active = true) =>
  app.request(`/api/receipts/${id}/claims`, json("PUT", { item_id, person, active }));

/** Reads SSE events from a streaming response until `count` events (pings excluded) arrived. */
async function readEvents(res: Response, count: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper, shapes are asserted below
  const events: { event: string; data: any }[] = [];
  let buf = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event !== "ping" && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  return { events, close: () => reader.cancel() };
}

beforeEach(() => {
  repo = openDb(":memory:");
  hub = new Hub();
  const parser = createParser({ model: "test", mock: true, repo, mockDelayMs: 0 });
  app = createApp({ repo, hub, parser, origins: ["http://localhost:3000"] });
});

afterEach(() => repo.close());

describe("parse", () => {
  it("returns the demo receipt in mock mode and it adds up", async () => {
    const res = await app.request("/api/parse", json("POST", { image: "AAAA" }));
    const body = await res.json();
    expect(body.model).toBe("mock");
    expect(body.checksum_diff).toBe(0);
    expect(body.receipt.items.length).toBeGreaterThan(0);
  });

  it("rejects a missing image", async () => {
    expect(await (await app.request("/api/parse", json("POST", {}))).json()).toEqual({ error: "no_image" });
  });

  it("rejects non-images and HEIC before calling Claude", async () => {
    const parser = createParser({ apiKey: "test", model: "test", mock: false, repo });
    const real = createApp({ repo, hub, parser, origins: [] });
    const heic = Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "latin1").toString("base64");
    const notImage = Buffer.from("hello, not a photo").toString("base64");
    expect((await real.request("/api/parse", json("POST", { image: heic }))).status).toBe(415);
    expect(await (await real.request("/api/parse", json("POST", { image: notImage }))).json()).toEqual({ error: "not_an_image" });
  });

  // Stands in for the Anthropic API: counts calls and answers with `reply`
  function fakeClaude(reply: () => Response) {
    const calls = { n: 0 };
    const fetch = (async () => {
      calls.n++;
      return reply();
    }) as unknown as typeof globalThis.fetch;
    const parser = createParser({ apiKey: "test", model: "test", mock: false, repo, fetch });
    return { calls, real: createApp({ repo, hub, parser, origins: [] }) };
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");

  it("caches a photo, so a retry doesn't call Claude again", async () => {
    const receipt = {
      is_receipt: true, currency: "PLN", service_cents: 0, tip_cents: 0, discount_cents: 0, total_cents: 1200,
      lines: [{ name: "KAWA", display_name: "Kawa", qty: 1, line_total_cents: 1200 }],
    };
    const { calls, real } = fakeClaude(() =>
      Response.json({
        id: "msg_1", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const first = await (await real.request("/api/parse", json("POST", { image: jpeg }))).json();
    const again = await (await real.request("/api/parse", json("POST", { image: jpeg }))).json();
    expect(first).toMatchObject({ cached: false, checksum_diff: 0 });
    expect(again).toMatchObject({ cached: true, receipt: first.receipt });
    expect(calls.n).toBe(1);
  });

  it("reports an empty credit balance as no_credit, not a generic error", async () => {
    const { real } = fakeClaude(() =>
      Response.json(
        { type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } },
        { status: 400 },
      ),
    );
    const res = await real.request("/api/parse", json("POST", { image: jpeg }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "no_credit" });
  });
});

describe("sniffImage", () => {
  const b64 = (bytes: number[] | string) =>
    (typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes)).toString("base64");

  it("detects the real format whatever the file was called", () => {
    expect(sniffImage(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
    expect(sniffImage(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImage(b64("RIFF\x10\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(b64("GIF89a"))).toBe("image/gif");
    expect(sniffImage(b64("\0\0\0\x18ftypheic\0\0"))).toBe("heic");
    expect(sniffImage(b64("plain text"))).toBeNull();
  });
});

describe("receipts and claims", () => {
  it("creates, reads and survives a fresh read", async () => {
    const id = await createReceipt();
    expect(id).toMatch(/^[2-9a-z]{8}$/);
    const res = await app.request(`/api/receipts/${id}`);
    const body = await res.json();
    expect(body.receipt.payer_name).toBe("Bohdan");
    expect(body.claims).toEqual([]);
    expect(body.split.unclaimedCents).toBe(body.receipt.total_cents); // nothing claimed yet: the whole bill is open
  });

  it("splits a shared item and every cent of the total is accounted for", async () => {
    const id = await createReceipt();
    const receipt = (await (await app.request(`/api/receipts/${id}`)).json()).receipt;
    // Ola and Bohdan share the first item, then split the rest between them
    for (const [n, item] of receipt.items.entries()) {
      if (n === 0 || n % 2 === 0) await claim(id, item.id, ola);
      if (n === 0 || n % 2 === 1) await claim(id, item.id, bohdan);
    }
    const { split } = await (await app.request(`/api/receipts/${id}`)).json();
    expect(split.unclaimedCents).toBe(0);
    expect(split.perPerson[ola.id] + split.perPerson[bohdan.id]).toBe(receipt.total_cents);
  });

  it("toggling off puts the item back to unclaimed, and repeats are idempotent", async () => {
    const id = await createReceipt();
    await claim(id, "i0", ola);
    await claim(id, "i0", ola);
    let body = await (await claim(id, "i0", ola, false)).json();
    expect(body.split.unclaimedItemIds).toContain("i0");
    body = await (await app.request(`/api/receipts/${id}`)).json();
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].active).toBe(false);
  });

  it("validates input", async () => {
    const id = await createReceipt();
    expect((await claim(id, "nope", ola)).status).toBe(400);
    expect((await claim("missing1", "i0", ola)).status).toBe(404);
    expect((await app.request("/api/receipts/missing1")).status).toBe(404);
    const bad = await app.request("/api/receipts", json("POST", { payer_name: "", items: [], total_cents: 1.5 }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_body");
    const dupIds = await app.request(
      "/api/receipts",
      json("POST", {
        payer_name: "B",
        total_cents: 200,
        items: [
          { id: "a", name: "x", display_name: "x", price_cents: 100 },
          { id: "a", name: "y", display_name: "y", price_cents: 100 },
        ],
      }),
    );
    expect(dupIds.status).toBe(400);
  });
});

describe("live events", () => {
  it("sends a snapshot, then presence and claims from others", async () => {
    const id = await createReceipt();
    await claim(id, "i0", bohdan);

    const q = new URLSearchParams({ person_id: ola.id, name: ola.name, color: ola.color });
    const res = await app.request(`/api/receipts/${id}/events?${q}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform"); // else proxies gzip and buffer it

    const pending = readEvents(res, 3);
    await new Promise((r) => setTimeout(r, 20));
    await claim(id, "i1", bohdan);
    const { events, close } = await pending;
    await close();

    expect(events.map((e) => e.event)).toEqual(["snapshot", "presence", "claim"]);
    expect(events[0].data.claims).toHaveLength(1);
    expect(events[0].data.online).toEqual([ola]);
    expect(events[1].data.online).toEqual([ola]);
    expect(events[2].data.claim).toMatchObject({ item_id: "i1", person_id: bohdan.id, active: true });
  });

  it("drops the person from presence when the stream closes", async () => {
    const id = await createReceipt();
    const q = new URLSearchParams({ person_id: ola.id, name: ola.name, color: ola.color });
    const { close } = await readEvents(await app.request(`/api/receipts/${id}/events?${q}`), 1);
    expect(hub.online(id)).toEqual([ola]);
    await close();
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.online(id)).toEqual([]);
  });

  it("404s for an unknown receipt", async () => {
    expect((await app.request("/api/receipts/missing1/events")).status).toBe(404);
  });
});
