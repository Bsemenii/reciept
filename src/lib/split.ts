import type { Claim, Receipt } from "./types";

/**
 * Split `total` cents across `weights` so the parts sum to exactly `total`
 * (largest remainder method). Ties go to the earlier index, so results are deterministic.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map(() => 0);

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exact = weights.map((w) => (abs * w) / sum);
  const parts = exact.map(Math.floor);
  let left = abs - parts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts.map((p) => p * sign);
}

type Sums = Pick<Receipt, "items" | "service_cents" | "tip_cents" | "discount_cents" | "total_cents">;

/** items + service + tip - discount - total. 0 means the receipt adds up. */
export function checksumDiff(r: Sums): number {
  const items = r.items.reduce((a, it) => a + it.price_cents, 0);
  return items + r.service_cents + r.tip_cents - r.discount_cents - r.total_cents;
}

export type SplitResult = {
  /** person_id -> cents of the bill that person had, extras (service/tip/discount) included */
  perPerson: Record<string, number>;
  /** What the payer gets back: everyone's share except the payer's own */
  owedToPayer: number;
  unclaimedItemIds: string[];
  /** Still uncovered, with its share of the extras: perPerson + unclaimedCents = items + extras */
  unclaimedCents: number;
};

/**
 * Who owes what.
 * - An item claimed by N people is split equally between them.
 * - Service, tip and discount are spread proportionally to item value across the whole receipt,
 *   unclaimed items included, so a share never changes when someone else taps (people pay by BLIK
 *   as soon as they see their number).
 * - Nobody owes for unclaimed items: the payer already paid them, so until someone taps them they
 *   simply stay with the payer.
 */
export function computeSplit(receipt: Receipt, claims: Claim[]): SplitResult {
  const active = claims.filter((c) => c.active);
  const people = [...new Set(active.map((c) => c.person_id))].sort();
  const subtotal: Record<string, number> = Object.fromEntries(people.map((p) => [p, 0]));

  const unclaimed: string[] = [];
  let unclaimedCents = 0;

  for (const item of receipt.items) {
    const takers = [...new Set(active.filter((c) => c.item_id === item.id).map((c) => c.person_id))].sort();
    if (takers.length === 0) {
      unclaimed.push(item.id);
      unclaimedCents += item.price_cents;
      continue;
    }
    allocate(item.price_cents, takers.map(() => 1)).forEach((cents, i) => {
      subtotal[takers[i]] += cents;
    });
  }

  // The last weight is the unclaimed part: it holds its share of the extras until someone takes it
  const extras = receipt.service_cents + receipt.tip_cents - receipt.discount_cents;
  const extraParts = allocate(extras, [...people.map((p) => subtotal[p]), unclaimedCents]);

  const perPerson: Record<string, number> = {};
  let owedToPayer = 0;
  people.forEach((p, i) => {
    perPerson[p] = subtotal[p] + extraParts[i];
    if (p !== receipt.payer_id) owedToPayer += perPerson[p];
  });

  return {
    perPerson,
    owedToPayer,
    unclaimedItemIds: unclaimed,
    unclaimedCents: unclaimedCents + extraParts[people.length],
  };
}

/** 4730 -> "47,30 zł" */
export function formatMoney(cents: number, currency = "PLN"): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency }).format(cents / 100);
}
