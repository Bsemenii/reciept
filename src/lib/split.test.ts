import { describe, expect, it } from "vitest";
import { allocate, checksumDiff, computeSplit } from "./split";
import type { Claim, Receipt } from "./types";

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: "r1",
  payer_id: "payer",
  payer_name: "Bohdan",
  payer_phone: "500600700",
  currency: "PLN",
  items: [
    { id: "i1", name: "PIZZA MARG", display_name: "Pizza Margherita", price_cents: 3200 },
    { id: "i2", name: "PIWO", display_name: "Piwo", price_cents: 1200 },
    { id: "i3", name: "LEMONIADA", display_name: "Lemoniada", price_cents: 1000 },
  ],
  service_cents: 0,
  tip_cents: 0,
  discount_cents: 0,
  total_cents: 5400,
  ...over,
});

const claim = (item_id: string, person_id: string, active = true): Claim => ({
  receipt_id: "r1",
  item_id,
  person_id,
  person_name: person_id,
  color: "#000",
  active,
});

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe("allocate", () => {
  it("sums to the total exactly", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
  });
  it("handles negative totals (discount bigger than service)", () => {
    const parts = allocate(-1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-1000);
  });
  it("returns zeros when weights are all zero", () => {
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
  });
});

describe("computeSplit", () => {
  it("one person per item", () => {
    const r = computeSplit(receipt(), [claim("i1", "a"), claim("i2", "b"), claim("i3", "b")]);
    expect(r.perPerson).toEqual({ a: 3200, b: 2200 });
    expect(r.unclaimedCents).toBe(0);
  });

  it("shared item splits equally to the grosz", () => {
    const r = computeSplit(receipt({ items: [{ id: "i1", name: "x", display_name: "x", price_cents: 1000 }], total_cents: 1000 }), [
      claim("i1", "a"),
      claim("i1", "b"),
      claim("i1", "c"),
    ]);
    expect(sum(r.perPerson)).toBe(1000);
    expect(Object.values(r.perPerson).sort()).toEqual([333, 333, 334]);
  });

  it("inactive claims are ignored", () => {
    const r = computeSplit(receipt(), [claim("i1", "a"), claim("i1", "b", false)]);
    expect(r.perPerson).toEqual({ a: 3200 });
  });

  it("service is spread proportionally and everything adds up to the total", () => {
    const rc = receipt({ service_cents: 540, total_cents: 5940 });
    const r = computeSplit(rc, [claim("i1", "a"), claim("i2", "b"), claim("i3", "b")]);
    expect(r.perPerson.a).toBe(3200 + 320);
    expect(r.perPerson.b).toBe(2200 + 220);
    expect(sum(r.perPerson)).toBe(rc.total_cents);
  });

  it("discount reduces shares proportionally", () => {
    const rc = receipt({ discount_cents: 540, total_cents: 4860 });
    const r = computeSplit(rc, [claim("i1", "a"), claim("i2", "b"), claim("i3", "b")]);
    expect(sum(r.perPerson)).toBe(rc.total_cents);
  });

  it("reports unclaimed items", () => {
    const r = computeSplit(receipt(), [claim("i1", "a")]);
    expect(r.unclaimedItemIds).toEqual(["i2", "i3"]);
    expect(r.unclaimedCents).toBe(2200);
  });

  it("a share doesn't change when someone else claims (people pay as soon as they see it)", () => {
    const rc = receipt({ service_cents: 540, total_cents: 5940 });
    const alone = computeSplit(rc, [claim("i1", "a")]);
    const later = computeSplit(rc, [claim("i1", "a"), claim("i2", "b"), claim("i3", "b")]);
    expect(alone.perPerson.a).toBe(3200 + 320);
    expect(later.perPerson.a).toBe(alone.perPerson.a);
  });

  it("unclaimed carries its share of the extras, so shares + unclaimed = total at every moment", () => {
    const rc = receipt({ service_cents: 540, total_cents: 5940 });
    expect(computeSplit(rc, []).unclaimedCents).toBe(rc.total_cents);
    const r = computeSplit(rc, [claim("i1", "a")]);
    expect(r.unclaimedCents).toBe(2200 + 220);
    expect(sum(r.perPerson) + r.unclaimedCents).toBe(rc.total_cents);
  });

  it("the payer gets back everyone's share but their own; unclaimed stays with the payer", () => {
    const rc = receipt({ service_cents: 540, total_cents: 5940 });
    const r = computeSplit(rc, [claim("i1", "payer"), claim("i2", "a")]);
    expect(r.owedToPayer).toBe(1200 + 120); // only a's beer
    expect(r.perPerson.payer).toBe(3200 + 320); // the payer's own pizza isn't owed to anyone
    expect(r.unclaimedCents).toBe(1000 + 100); // nobody owes the lemonade
  });
});

describe("checksumDiff", () => {
  it("is 0 when the receipt adds up", () => {
    expect(checksumDiff(receipt())).toBe(0);
    expect(checksumDiff(receipt({ service_cents: 540, total_cents: 5940 }))).toBe(0);
  });
  it("shows the gap when an item was misread", () => {
    expect(checksumDiff(receipt({ total_cents: 5500 }))).toBe(-100);
  });
});
