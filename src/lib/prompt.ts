// Owner: Bohdan. Tune this against fixtures/ receipts, keep the output fields in sync with lib/parse.ts.

export const PARSE_PROMPT = `You read a photo of a restaurant or shop receipt and extract the purchased lines so friends can split the bill.

Rules:
- All money as integer cents (grosze). "32,00" -> 3200. "1 234,50" -> 123450.
- One entry in "lines" per purchased product line. "qty" is the quantity printed for that line (1 if none). "line_total_cents" is the total price of the whole line, not the unit price.
  Example: "Piwo 2 x 12,00 24,00A" -> qty 2, line_total_cents 2400.
- Weighted goods ("0,350 kg x 39,90") -> qty 0.35, line_total_cents is the line total.
- "name": exactly as printed. "display_name": a short, clean, human name in the SAME language as the receipt, fixing abbreviations and caps ("PIZZA MARG 32CM" -> "Pizza Margherita 32 cm"). Do not translate.
- Ignore tax and fiscal lines: PTU, VAT, "SUMA PTU", "Sprzedaż opodatkowana", "Kwota A/B", NIP, payment method, change ("Reszta"), card details, receipt numbers.
- "service_cents": service charge (e.g. "Serwis 10%"). "tip_cents": tip ("Napiwek"). "discount_cents": total discounts as a POSITIVE number ("Rabat", "Zniżka", "Promocja"). Use 0 if absent.
  If a discount ("Opust", "Rabat") is printed directly under a product, subtract it from that product's line_total_cents instead and do not count it again in discount_cents.
- Bottle or can deposit ("Kaucja", "Kaucja butelka PET", "Kaucja puszka"): add it to the line_total_cents of the drink it belongs to (the product printed right above it, or the matching bottle/can drink), never as its own line. If it can't be matched to any product, keep it as its own line.
- "total_cents": the final amount to pay ("SUMA", "RAZEM", "DO ZAPŁATY", "Total").
- "currency": ISO code, "PLN" if the receipt is Polish and nothing else is printed.
- If a value is unreadable, give your best reading; the app checks the sum and lets the user fix it.
- If the image is not a receipt, set "is_receipt" to false and return empty lines and zeros.`;

/** Second look, sent only when the first reading doesn't add up to the printed total. */
export function recheckPrompt(s: { lines_cents: number; service_cents: number; tip_cents: number; discount_cents: number; total_cents: number }) {
  const sum = s.lines_cents + s.service_cents + s.tip_cents - s.discount_cents;
  return `Your reading doesn't add up: lines ${s.lines_cents} + service ${s.service_cents} + tip ${s.tip_cents} - discount ${s.discount_cents} = ${sum}, but total_cents is ${s.total_cents} (off by ${sum - s.total_cents}).
Look at the photo again. Common causes: a missed or duplicated line, a misread digit, a unit price used instead of the line total, a discount counted both under its product and in discount_cents, a tax line read as a product.
Return the full corrected receipt. If the printed numbers really don't add up, return them as printed.`;
}
