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

/** items + service + tip - discount - total. 0 means the receipt adds up. */
export function checksumDiff(r: Receipt): number {
  const items = r.items.reduce((a, it) => a + it.price_cents, 0);
  return items + r.service_cents + r.tip_cents - r.discount_cents - r.total_cents;
}

export type SplitResult = {
  /** person_id -> cents owed, extras (service/tip/discount) included */
  perPerson: Record<string, number>;
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
 * - Unclaimed items are left out unless `splitUnclaimed` is set, then they are shared by everyone.
 */
export function computeSplit(
  receipt: Receipt,
  claims: Claim[],
  opts: { splitUnclaimed?: boolean } = {},
): SplitResult {
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

  if (opts.splitUnclaimed && people.length > 0 && unclaimedCents > 0) {
    allocate(unclaimedCents, people.map(() => 1)).forEach((cents, i) => {
      subtotal[people[i]] += cents;
    });
  }

  const sharedOut = opts.splitUnclaimed && people.length > 0;
  const leftover = sharedOut ? 0 : unclaimedCents;

  // The last weight is the unclaimed part: it holds its share of the extras until someone takes it
  const extras = receipt.service_cents + receipt.tip_cents - receipt.discount_cents;
  const extraParts = allocate(extras, [...people.map((p) => subtotal[p]), leftover]);

  const perPerson: Record<string, number> = {};
  people.forEach((p, i) => {
    perPerson[p] = subtotal[p] + extraParts[i];
  });

  return {
    perPerson,
    unclaimedItemIds: sharedOut ? [] : unclaimed,
    unclaimedCents: leftover + extraParts[people.length],
  };
}

/** 4730 -> "47,30 zł" */
export function formatMoney(cents: number, currency = "PLN"): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency }).format(cents / 100);
}
