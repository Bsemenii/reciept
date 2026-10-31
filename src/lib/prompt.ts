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
  If a discount is printed directly under a product, subtract it from that product's line_total_cents instead and do not count it again in discount_cents.
- "total_cents": the final amount to pay ("SUMA", "RAZEM", "DO ZAPŁATY", "Total").
- "currency": ISO code, "PLN" if the receipt is Polish and nothing else is printed.
- If a value is unreadable, give your best reading; the app checks the sum and lets the user fix it.
- If the image is not a receipt, set "is_receipt" to false and return empty lines and zeros.`;
