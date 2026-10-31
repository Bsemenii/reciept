import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { expandLines, ParsedReceiptSchema } from "../../src/lib/parse";
import { PARSE_PROMPT } from "../../src/lib/prompt";
import { checksumDiff } from "../../src/lib/split";
import type { Receipt } from "../../src/lib/types";
import type { Repo } from "./db";

export type Draft = Omit<Receipt, "id" | "payer_id" | "payer_name" | "payer_phone" | "created_at">;
export type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type ParseResult = { receipt: Draft; checksum_diff: number };
export type ParseOutcome = ParseResult & { model: string; ms: number; cached: boolean };

export class ParseError extends Error {
  constructor(
    public code: "not_a_receipt" | "unreadable" | "busy" | "no_credit" | "model_error" | "timeout",
    public status: 422 | 429 | 502 | 504,
  ) {
    super(code);
  }
}

const DEMO: Draft = JSON.parse(
  readFileSync(new URL("../../src/fixtures/demo-receipt.json", import.meta.url), "utf8"),
);

// Part of the cache key, so editing prompt.ts or the output schema re-reads photos that were already cached
const PROMPT_VERSION = createHash("sha256")
  .update(PARSE_PROMPT)
  .update(JSON.stringify(ParsedReceiptSchema.toJSONSchema()))
  .digest("hex")
  .slice(0, 12);

// At most this many Claude calls in flight; extra requests wait their turn instead of piling up.
const MAX_CONCURRENT = 2;

function semaphore(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * Real format from the first bytes, so a mislabeled upload (".jpg" that is a PNG, raw fallback
 * from the client) still reaches Claude with the right media type. "heic" is recognized only to
 * give a clear error: Claude doesn't read it.
 */
export function sniffImage(base64: string): MediaType | "heic" | null {
  const head = Buffer.from(base64.slice(0, 24), "base64");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (head.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1)$/.test(head.toString("latin1", 8, 12))) return "heic";
  return null;
}

function withChecksum(receipt: Draft): ParseResult {
  return { receipt, checksum_diff: checksumDiff(receipt) };
}

export function createParser(opts: {
  apiKey?: string;
  model: string;
  mock: boolean;
  repo: Repo;
  mockDelayMs?: number;
  fetch?: typeof fetch; // tests stub the Anthropic API with this
}) {
  const { model, mock, repo, mockDelayMs = 1500 } = opts;
  const client = mock ? null : new Anthropic({ apiKey: opts.apiKey, timeout: 45_000, maxRetries: 1, fetch: opts.fetch });
  const cacheKey = `${model}:${PROMPT_VERSION}`;
  const limit = semaphore(MAX_CONCURRENT);

  async function callClaude(image: string, mediaType: MediaType): Promise<ParseResult> {
    try {
      const response = await client!.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: "low", format: zodOutputFormat(ParsedReceiptSchema) },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: PARSE_PROMPT },
            ],
          },
        ],
      });

      const parsed = response.parsed_output;
      if (response.stop_reason === "refusal" || !parsed) throw new ParseError("unreadable", 422);
      if (!parsed.is_receipt) throw new ParseError("not_a_receipt", 422);

      return withChecksum({
        currency: parsed.currency || "PLN",
        items: expandLines(parsed.lines),
        service_cents: Math.round(parsed.service_cents),
        tip_cents: Math.round(parsed.tip_cents),
        discount_cents: Math.round(parsed.discount_cents),
        total_cents: Math.round(parsed.total_cents),
      });
    } catch (error) {
      if (error instanceof ParseError) throw error;
      if (error instanceof Anthropic.RateLimitError) throw new ParseError("busy", 429);
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ParseError("timeout", 504);
      if (error instanceof Anthropic.APIError && error.type === "billing_error") {
        // Out of credits looks like a random failure to the user; make it obvious to whoever runs the server
        console.error("parse failed: Anthropic credit balance is empty. Top up in the Console or set MOCK_PARSE=1.");
        throw new ParseError("no_credit", 502);
      }
      if (error instanceof Anthropic.APIError) {
        console.error("parse failed", error.status, error.message);
        throw new ParseError("model_error", 502);
      }
      throw error;
    }
  }

  return {
    model: mock ? "mock" : model,

    async parse(image: string, mediaType: MediaType, forceMock = false): Promise<ParseOutcome> {
      const t0 = Date.now();
      if (mock || forceMock) {
        // The delay lets the scan animation play, same as a real call would
        await new Promise((r) => setTimeout(r, mockDelayMs));
        return { ...withChecksum(structuredClone(DEMO)), model: "mock", ms: Date.now() - t0, cached: false };
      }

      // Same photo twice (double tap, retry after a network blip) costs one model call
      const sha = createHash("sha256").update(image).digest("hex");
      const hit = repo.getCachedParse<ParseResult>(sha, cacheKey);
      if (hit) return { ...hit, model, ms: Date.now() - t0, cached: true };

      const result = await limit(() => callClaude(image, mediaType));
      repo.cacheParse(sha, cacheKey, result);
      return { ...result, model, ms: Date.now() - t0, cached: false };
    },
  };
}

export type Parser = ReturnType<typeof createParser>;
