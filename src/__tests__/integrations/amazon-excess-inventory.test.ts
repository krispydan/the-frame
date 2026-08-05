/**
 * Excess and removal — the "what not to send" half.
 *
 * The distinction that matters most: a SKU with no PAID sales but plenty of
 * giveaway movement looks alive in Amazon's numbers. It is the one most
 * likely to be restocked by mistake, so it gets its own reason code rather
 * than being lumped in with genuinely dead stock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildExcessReport } from "@/modules/integrations/lib/amazon/excess-inventory";

let sqlite: ReturnType<typeof getTestDb>;
const TODAY = "2026-08-04";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function seed(opts: {
  sku: string; available: number; unfulfillable?: number;
  paid?: number; free?: number; landed?: number | null;
}) {
  const internal = opts.sku.replace(/-FBA$/i, "");
  const id = `s-${internal}`;
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
  ).run();
  sqlite.prepare("INSERT OR IGNORE INTO catalog_skus (id, product_id, sku) VALUES (?, 'p-1', ?)").run(id, internal);

  if (opts.landed != null) {
    sqlite.prepare(`
      INSERT INTO inventory_cost_layers
        (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
      VALUES (?, ?, 500, 400, ?, 0, 0, ?, '2026-05-01')
    `).run(crypto.randomUUID(), id, opts.landed, opts.landed);
  }

  sqlite.prepare(`
    INSERT INTO amazon_restock_recommendations
      (id, snapshot_date, sku, internal_sku, asin, product_name, alert,
       recommended_qty, units_sold_30d, days_of_supply, available, inbound,
       working, receiving, unfulfillable, total_units, price)
    VALUES (?, ?, ?, ?, 'B0AAA', ?, '', 0, 0, 0, ?, 0, 0, 0, ?, 0, 28)
  `).run(crypto.randomUUID(), TODAY, opts.sku, internal, `Title ${internal}`,
    opts.available, opts.unfulfillable ?? 0);

  const push = (n: number, free: boolean) => {
    for (let i = 0; i < n; i++) {
      sqlite.prepare(`
        INSERT INTO amazon_order_rows
          (id, amazon_order_id, sku, quantity, item_price, item_tax,
           item_promotion_discount, ship_promotion_discount, shipping_price,
           shipping_tax, item_status, purchase_date)
        VALUES (?, ?, ?, 1, 28, 0, ?, 0, 0, 0, 'Shipped', '2026-07-20T12:00:00Z')
      `).run(crypto.randomUUID(), crypto.randomUUID(), opts.sku, free ? 28 : 0);
    }
  };
  push(opts.paid ?? 0, false);
  push(opts.free ?? 0, true);
}

const report = (coverDays?: number) => buildExcessReport({ coverDays, today: TODAY });
const line = (sku: string) => report().lines.find((l) => l.sku === sku);

describe("what gets flagged", () => {
  it("flags stock with no paid sales at all", () => {
    seed({ sku: "JX1-BLK-FBA", available: 200, paid: 0, landed: 6 });
    const l = line("JX1-BLK-FBA")!;
    expect(l.reasons).toContain("no_paid_sales");
    expect(l.excessUnits).toBe(200);
    expect(l.excessValueAtCost).toBe(1200);
  });

  it("names a SKU kept alive only by giveaways", () => {
    // The one most likely to be restocked by mistake: Amazon's units-sold
    // shows movement, and none of it took money.
    seed({ sku: "JX1-BLK-FBA", available: 200, paid: 0, free: 25, landed: 6 });
    const l = line("JX1-BLK-FBA")!;
    expect(l.reasons).toContain("giveaway_propped");
    expect(l.seededUnits30d).toBe(25);
    expect(l.paidUnits30d).toBe(0);
  });

  it("flags cover well beyond the threshold and keeps the threshold's worth", () => {
    // 3 paid units in 30 days = 0.1/day. 180 days of cover is 18 units.
    seed({ sku: "JX1-BLK-FBA", available: 100, paid: 3, landed: 6 });
    const l = line("JX1-BLK-FBA")!;
    expect(l.reasons).toContain("excess_cover");
    expect(l.daysOfCover).toBe(1000);
    expect(l.excessUnits).toBe(82);
  });

  it("flags unfulfillable units even on a healthy seller", () => {
    seed({ sku: "JX1-BLK-FBA", available: 60, paid: 30, unfulfillable: 4, landed: 6 });
    const l = line("JX1-BLK-FBA")!;
    expect(l.reasons).toEqual(["unfulfillable"]);
    expect(l.excessUnits).toBe(0);
  });

  it("leaves a healthy SKU off the report entirely", () => {
    // 30 paid in 30 days = 1/day, 60 units is 60 days of cover.
    seed({ sku: "JX1-BLK-FBA", available: 60, paid: 30, landed: 6 });
    expect(line("JX1-BLK-FBA")).toBeUndefined();
  });

  it("ignores a SKU with no stock at Amazon", () => {
    seed({ sku: "JX1-BLK-FBA", available: 0, paid: 0, landed: 6 });
    expect(line("JX1-BLK-FBA")).toBeUndefined();
  });

  it("honours a custom cover threshold", () => {
    seed({ sku: "JX1-BLK-FBA", available: 100, paid: 30, landed: 6 });
    expect(line("JX1-BLK-FBA")).toBeUndefined();       // 100 days, under 180
    expect(report(60)!.lines[0].excessUnits).toBe(40); // keep 60, release 40
  });
});

describe("ranking", () => {
  it("puts the largest capital at risk first", () => {
    seed({ sku: "JX1-BLK-FBA", available: 50, paid: 0, landed: 20 });   // $1000
    seed({ sku: "JX2-BLK-FBA", available: 300, paid: 0, landed: 6 });   // $1800
    expect(report().lines[0].sku).toBe("JX2-BLK-FBA");
  });

  it("still surfaces a large uncosted pile rather than sorting it last", () => {
    // Falling back to unit count keeps an unknown cost from hiding a problem.
    seed({ sku: "JX1-BLK-FBA", available: 10, paid: 0, landed: 6 });    // $60
    seed({ sku: "JX2-BLK-FBA", available: 900, paid: 0, landed: null }); // unknown
    expect(report().lines[0].sku).toBe("JX2-BLK-FBA");
  });
});

describe("reporting", () => {
  it("totals the capital tied up and the unsellable units", () => {
    seed({ sku: "JX1-BLK-FBA", available: 100, paid: 0, unfulfillable: 5, landed: 6 });
    const t = report().totals;
    expect(t.skusFlagged).toBe(1);
    expect(t.excessUnits).toBe(100);
    expect(t.excessValueAtCost).toBe(600);
    expect(t.unfulfillableUnits).toBe(5);
  });

  it("says cover is computed from paid velocity", () => {
    seed({ sku: "JX1-BLK-FBA", available: 100, paid: 0, landed: 6 });
    expect(report().notes.join(" ")).toContain("PAID velocity");
  });

  it("records why long-term storage fees are absent", () => {
    // So the next person does not repeat the field search.
    seed({ sku: "JX1-BLK-FBA", available: 100, paid: 0, landed: 6 });
    expect(report().notes.join(" ")).toContain("carries no SKU key");
  });

  it("says what to run when there is no snapshot", () => {
    expect(report().notes[0]).toContain("run the restock sync first");
  });
});
