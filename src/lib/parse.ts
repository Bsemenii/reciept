import { z } from "zod";
import type { Item } from "./types";

// What the model returns. Kept flat and simple so structured outputs stay reliable.
export const ParsedReceiptSchema = z.object({
  is_receipt: z.boolean(),
  currency: z.string(),
  lines: z.array(
    z.object({
      name: z.string(),
      display_name: z.string(),
      qty: z.number(),
      line_total_cents: z.number(),
    }),
  ),
  service_cents: z.number(),
  tip_cents: z.number(),
  discount_cents: z.number(),
  total_cents: z.number(),
});

export type ParsedReceipt = z.infer<typeof ParsedReceiptSchema>;

const MAX_UNITS = 12;

/**
 * Turn "3 x Piwo 36,00" into three claimable rows of 12,00 so three people can each take one.
 * Fractional or large quantities (0.35 kg, 50 g) stay as one row.
 */
export function expandLines(lines: ParsedReceipt["lines"]): Item[] {
  const items: Item[] = [];
  lines.forEach((line, i) => {
    const cents = Math.round(line.line_total_cents);
    const qty = line.qty;
    const base = { name: line.name, display_name: line.display_name || line.name };
    if (Number.isInteger(qty) && qty > 1 && qty <= MAX_UNITS) {
      const unit = Math.floor(cents / qty);
      let rest = cents - unit * qty;
      for (let u = 1; u <= qty; u++) {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        items.push({ ...base, id: `i${i}.${u}`, price_cents: unit + extra });
      }
    } else {
      items.push({ ...base, id: `i${i}`, price_cents: cents });
    }
  });
  return items;
}
