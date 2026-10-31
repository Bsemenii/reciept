import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_DB = fileURLToPath(new URL("../data/split.db", import.meta.url));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(8787),
  ANTHROPIC_API_KEY: z.string().optional(),
  PARSE_MODEL: z.string().default("claude-opus-5-5"),
  // 1 = never call Claude, answer /api/parse with the demo receipt (offline stage backup)
  MOCK_PARSE: z.enum(["0", "1"]).default("0"),
  // Comma-separated, or "*" while testing from phones on the LAN
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  DB_PATH: z.string().default(DEFAULT_DB),
  // Receipts older than this are deleted hourly. 0 keeps everything.
  RETENTION_HOURS: z.coerce.number().default(24),
});

export type Config = {
  port: number;
  apiKey: string | undefined;
  model: string;
  mock: boolean;
  origins: string[];
  dbPath: string;
  retentionHours: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const mock = e.MOCK_PARSE === "1";
  if (!mock && !e.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing. Put it in server/.env, or set MOCK_PARSE=1 to run without Claude.");
  }
  return {
    port: e.PORT,
    apiKey: e.ANTHROPIC_API_KEY,
    model: e.PARSE_MODEL,
    mock,
    origins: e.FRONTEND_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean),
    dbPath: e.DB_PATH,
    retentionHours: e.RETENTION_HOURS,
  };
}
