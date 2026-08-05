/**
 * Amazon promotional (Vine) volume analysis.
 *
 * Vine units are not reported as $0 sales. Amazon reports full list price in
 * `item_price` with an equal offsetting `item_promotion_discount`, so a
 * catalogue running mostly on Vine still shows healthy gross sales. The whole
 * point of this breakdown is separating "we shipped a lot" from "we were
 * paid", so the banding is what these tests pin down.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { getAmazonPromoBreakdown } from "@/modules/integrations/lib/amazon/metrics";

let sqlite: ReturnType<typeof getTestDb>;
const ALL = { from: "2000-01-01", to: "2100-01-01" };

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function row(opts: {
  order?: string; sku?: string; price: number; discount: number; qty?: number;
  date?: string; status?: string;
}) {
  sqlite.prepare(`
    INSERT INTO amazon_order_rows
      (id, amazon_order_id, sku, quantity, item_price, item_tax,
       item_promotion_discount, ship_promotion_discount, shipping_price, shipping_tax,
       item_status, purchase_date)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?)
  `).run(
    crypto.randomUUID(), opts.order ?? crypto.randomUUID(),
    opts.sku ?? `JX-${crypto.randomUUID().slice(0, 8)}`, opts.qty ?? 1,
    opts.price, opts.discount, opts.status ?? "Shipped",
    opts.date ?? "2026-07-10T00:00:00Z",
  );
}

const band = (b: string) => getAmazonPromoBreakdown(ALL).rows.find((r) => r.band === b);

describe("banding", () => {
  it("bands a fully discounted line as free", () => {
    row({ price: 28, discount: 28 });
    expect(band("free")).toMatchObject({ units: 1, gross: 28, discount: 28, netPaid: 0 });
  });

  it("bands an undiscounted line as full price", () => {
    row({ price: 28, discount: 0 });
    expect(band("full_price")).toMatchObject({ units: 1, netPaid: 28 });
  });

  it("separates heavy from partial discounting", () => {
    row({ price: 100, discount: 60 });
    row({ price: 100, discount: 10 });
    expect(band("heavy")).toMatchObject({ units: 1, netPaid: 40 });
    expect(band("partial")).toMatchObject({ units: 1, netPaid: 90 });
  });

  it("treats a cent of rounding residue as free, not as a sale", () => {
    // Multi-unit lines leave cent-level residue. Banding a giveaway as a sale
    // because of one cent is exactly the error this whole view exists to stop.
    row({ price: 28.0, discount: 27.997 });
    expect(band("free")?.units).toBe(1);
  });

  it("bands a zero-price line as free even with no discount recorded", () => {
    row({ price: 0, discount: 0 });
    expect(band("free")?.units).toBe(1);
  });

  it("counts units, not lines", () => {
    row({ price: 84, discount: 84, qty: 3 });
    expect(band("free")?.units).toBe(3);
  });
});

describe("headline shares", () => {
  it("reports the free-unit share that gross sales hides", () => {
    for (let i = 0; i < 19; i++) row({ price: 28, discount: 28 });
    row({ price: 28, discount: 0 });

    const r = getAmazonPromoBreakdown(ALL);
    expect(r.totals.units).toBe(20);
    expect(r.totals.gross).toBe(560);   // looks like $560 of trading...
    expect(r.totals.netPaid).toBe(28);  // ...against $28 actually collected
    expect(r.freeUnitShare).toBe(95);
    expect(r.discountRate).toBe(95);
  });

  it("returns zeroed shares rather than dividing by nothing", () => {
    const r = getAmazonPromoBreakdown(ALL);
    expect(r.freeUnitShare).toBe(0);
    expect(r.discountRate).toBe(0);
    expect(r.totals.units).toBe(0);
  });

  it("counts an order once even when its lines band differently", () => {
    // The archive is keyed (order, sku), so the two lines are distinct SKUs.
    row({ order: "o1", sku: "JX1-BLK", price: 28, discount: 28 });
    row({ order: "o1", sku: "JX2-BLK", price: 28, discount: 0 });
    const r = getAmazonPromoBreakdown(ALL);
    expect(r.rows.every((x) => x.orders === 1)).toBe(true);
  });
});

describe("scoping", () => {
  it("excludes cancelled lines", () => {
    row({ price: 28, discount: 28, status: "Cancelled" });
    expect(getAmazonPromoBreakdown(ALL).totals.units).toBe(0);
  });

  it("honours the date range", () => {
    row({ price: 28, discount: 28, date: "2026-06-10T00:00:00Z" });
    row({ price: 28, discount: 0, date: "2026-07-10T00:00:00Z" });
    const r = getAmazonPromoBreakdown({ from: "2026-07-01", to: "2026-07-31" });
    expect(r.totals.units).toBe(1);
    expect(r.totals.netPaid).toBe(28);
  });

  it("trends free units by month so a shift in mix is visible", () => {
    row({ price: 28, discount: 28, date: "2026-06-10T00:00:00Z" });
    row({ price: 28, discount: 28, date: "2026-07-10T00:00:00Z" });
    row({ price: 28, discount: 0, date: "2026-07-11T00:00:00Z" });

    expect(getAmazonPromoBreakdown(ALL).byMonth).toEqual([
      { month: "2026-06", units: 1, freeUnits: 1, gross: 28, discount: 28, netPaid: 0 },
      { month: "2026-07", units: 2, freeUnits: 1, gross: 56, discount: 28, netPaid: 28 },
    ]);
  });
});
