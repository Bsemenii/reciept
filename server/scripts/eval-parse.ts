// Runs every photo in src/fixtures/photos/ through Claude and prints speed and how many receipts
// add up to the grosz without edits. Picks PARSE_MODEL and gives a number for the pitch.
//   npm run eval                                      (PARSE_MODEL from server/.env)
//   npm run eval -- claude-opus-5-5 claude-haiku-5-5  (compare models)
//   EVAL_ONLY=lidl npm run eval                       (only photos whose name contains "lidl")
// Photos: JPEG/PNG/WebP under 5 MB (export from Photos as JPEG; HEIC is skipped).

import { readdirSync, readFileSync } from "node:fs";
import { openDb } from "../src/db";
import { loadConfig } from "../src/env";
import { createParser, ParseError, sniffImage } from "../src/parser";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no server/.env: rely on the real environment
}

const DIR = new URL("../../src/fixtures/photos/", import.meta.url);
const MAX_BYTES = 5 * 1024 * 1024; // Claude's per-image limit

const config = loadConfig({ ...process.env, MOCK_PARSE: "0" });
const models = process.argv.slice(2).length ? process.argv.slice(2) : [config.model];

let files: string[] = [];
try {
  files = readdirSync(DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && f.includes(process.env.EVAL_ONLY ?? ""))
    .sort();
} catch {
  // reported below
}
if (!files.length) {
  console.error(`No photos in ${DIR.pathname}. Add a few real receipts (JPEG/PNG) and run again.`);
  process.exit(1);
}

async function evalModel(model: string) {
  // Fresh in-memory DB per model, so the parse cache never hides a real call
  const parser = createParser({ apiKey: config.apiKey, model, mock: false, repo: openDb(":memory:") });
  const rows: { file: string; ms: number; items: number; diff: number | string }[] = [];

  for (const file of files) {
    const bytes = readFileSync(new URL(file, DIR));
    if (bytes.length > MAX_BYTES) {
      rows.push({ file, ms: 0, items: 0, diff: "too large" });
      continue;
    }
    const image = bytes.toString("base64");
    const type = sniffImage(image);
    if (!type || type === "heic") {
      rows.push({ file, ms: 0, items: 0, diff: "not jpeg/png" });
      continue;
    }
    const t0 = Date.now();
    let detail = "";
    try {
      const { receipt: r, ms, checksum_diff } = await parser.parse(image, type);
      rows.push({ file, ms, items: r.items.length, diff: checksum_diff });
      // Enough to compare with the paper receipt by eye
      const cents = (c: number) => (c / 100).toFixed(2);
      detail = r.items.map((i) => `    ${i.display_name}  ${cents(i.price_cents)}`).join("\n");
      detail += `\n    service ${cents(r.service_cents)}  tip ${cents(r.tip_cents)}  discount ${cents(r.discount_cents)}  total ${cents(r.total_cents)} ${r.currency}`;
    } catch (e) {
      rows.push({ file, ms: Date.now() - t0, items: 0, diff: e instanceof ParseError ? e.code : String(e) });
    }
    const last = rows[rows.length - 1];
    console.log(`${model}  ${file}  ${last.ms} ms  items=${last.items}  diff=${last.diff}${detail && "\n" + detail}`);
  }

  const parsed = rows.filter((r) => typeof r.diff === "number");
  const exact = parsed.filter((r) => r.diff === 0).length;
  const avg = parsed.length ? Math.round(parsed.reduce((a, r) => a + r.ms, 0) / parsed.length) : 0;
  console.log(`\n${model}: ${exact}/${rows.length} add up exactly, avg ${avg} ms\n`);
}

(async () => {
  for (const model of models) await evalModel(model);
})();
