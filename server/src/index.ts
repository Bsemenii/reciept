import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { openDb } from "./db";
import { loadConfig } from "./env";
import { Hub } from "./hub";
import { createParser } from "./parser";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no server/.env: rely on the real environment
}

const config = loadConfig();
const repo = openDb(config.dbPath);
const hub = new Hub();
const parser = createParser({ apiKey: config.apiKey, model: config.model, mock: config.mock, repo });
const app = createApp({ repo, hub, parser, origins: config.origins });

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`split server on http://localhost:${info.port}  model=${parser.model}  db=${config.dbPath}`);
  console.log(`CORS origins: ${config.origins.join(", ")}`);
});

const cleanup =
  config.retentionHours > 0
    ? setInterval(() => {
        const n = repo.deleteOlderThan(config.retentionHours);
        if (n) console.log(`deleted ${n} receipts older than ${config.retentionHours}h`);
      }, 3600_000)
    : null;

function shutdown() {
  if (cleanup) clearInterval(cleanup);
  hub.closeAll();
  server.close(() => {
    repo.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref(); // don't hang on a stuck connection
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
