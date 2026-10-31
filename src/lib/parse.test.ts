import { describe, expect, it } from "vitest";
import { expandLines } from "./parse";

describe("expandLines", () => {
  it("splits integer quantities into claimable units that sum to the line", () => {
    const items = expandLines([{ name: "PIWO", display_name: "Piwo", qty: 3, line_total_cents: 3700 }]);
    expect(items.map((i) => i.price_cents)).toEqual([1234, 1233, 1233]);
    expect(items.map((i) => i.id)).toEqual(["i0.1", "i0.2", "i0.3"]);
  });

  it("keeps weighted and single lines as one row", () => {
    const items = expandLines([
      { name: "SER", display_name: "Ser", qty: 0.35, line_total_cents: 1397 },
      { name: "PIZZA", display_name: "Pizza", qty: 1, line_total_cents: 3200 },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].price_cents).toBe(1397);
  });
});
