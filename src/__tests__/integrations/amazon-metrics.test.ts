/**
 * Amazon dashboard metrics tests.
 *
 * The framing being tested is that gross sales alone are misleading for this
 * channel — promotions ran at 71% of gross during launch — so the assertions
 * focus on promotions being kept separate, contribution being computed after
 * fees and COGS, and the cost-coverage flag being honest when margin is
 * flattering.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  getAmazonHeadline,
  getAmazonDaily,
  getAmazonSkus,
  getAmazonInventory,
  getAmazonUnmappedSkus,
} from "@/modules/integrations/lib/amazon/metrics";

let sqlite: ReturnType<typeof getTestDb>;
const RANGE = { from: "2026-07-01", to: "2026-07-31" };

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function order(id: string, over: Record<string, unknown> = {}) {
  const o = {
    subtotal: 100, discount: 0, shipping: 0, tax: 0, total: 100,
    status: "shipped", placed_at: "2026-07-10T00:00:00Z", ...over,
  };
  sqlite.prepare(`
    INSERT INTO orders (id, order_number, channel, status, subtotal, discount, shipping, tax, total, currency, placed_at, created_at)
    VALUES (?, ?, 'amazon', ?, ?, ?, ?, ?, ?, 'USD', ?, datetime('now'))
  `).run(id, `AMZ-${id}`, o.status, o.subtotal, o.discount, o.shipping, o.tax, o.total, o.placed_at);
  return o;
}

function item(orderId: string, sku: string, qty: number, total: number, skuId: string | null = null) {
  sqlite.prepare(`
    INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), orderId, sku, skuId, sku, qty, total / qty, total);
}

function settlementWithFees(fees: Array<[string, number]>) {
  const sid = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, adjustments, net_amount, currency, external_id, status, created_at)
    VALUES (?, 'amazon', '2026-07-01', '2026-07-15', 0, 0, 0, 0, 'USD', ?, 'received', datetime('now'))
  `).run(sid, `amazon_settlement_${sid}`);
  for (const [desc, amount] of fees) {
    sqlite.prepare(`
      INSERT INTO settlement_line_items (id, settlement_id, order_id, type, description, amount, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))
    `).run(crypto.randomUUID(), sid, desc === "Refunds" ? "refund" : "fee", desc, amount);
  }
}

function costLayerAndDepletion(skuId: string, orderItemId: string, qty: number, unitCost: number) {
  const layerId = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, ?, 100, 90, ?, 0, 0, ?, '2026-06-01')
  `).run(layerId, skuId, unitCost, unitCost);
  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, NULL, 'amazon', ?, ?, ?, '2026-07-10')
  `).run(crypto.randomUUID(), layerId, orderItemId, qty, unitCost, unitCost);
}

describe("getAmazonHeadline", () => {
  it("keeps promotions separate from gross rather than netting them away", () => {
    // The real launch ratio: $1652 gross against $1176 of promotions.
    order("o1", { subtotal: 1652, discount: 1176, total: 476 });
    item("o1", "JX1-BLK-FBA", 59, 1652);

    const h = getAmazonHeadline(RANGE);
    expect(h.grossSales).toBe(1652);
    expect(h.promotions).toBe(1176);
    expect(h.netSales).toBe(476);
    expect(h.promotionsPctOfGross).toBeCloseTo(71.2, 1);
  });

  it("computes contribution after fees, refunds and COGS", () => {
    order("o1", { subtotal: 1000, discount: 200, total: 800 });
    item("o1", "JX1-BLK-FBA", 10, 1000);
    settlementWithFees([["Referral commission", -50], ["FBA fulfilment fees", -100]]);

    const h = getAmazonHeadline(RANGE);
    expect(h.netSales).toBe(800);
    expect(h.referralFees).toBe(50);
    expect(h.fbaFees).toBe(100);
    expect(h.totalFees).toBe(150);
    expect(h.contributionMargin).toBe(650); // 800 − 150 − 0 refunds − 0 COGS
  });

  it("subtracts COGS attributed to Amazon", () => {
    order("o1", { subtotal: 1000, discount: 0, total: 1000 });
    item("o1", "JX1-BLK-FBA", 10, 1000, "sku-1");
    const oi = sqlite.prepare("SELECT id FROM order_items").get() as { id: string };
    costLayerAndDepletion("sku-1", oi.id, 10, 6);

    const h = getAmazonHeadline(RANGE);
    expect(h.cogs).toBe(60);
    expect(h.contributionMargin).toBe(940);
    expect(h.hasFullCostData).toBe(true);
  });

  it("flags incomplete cost coverage so margin is not read as final", () => {
    order("o1", { subtotal: 1000, total: 1000 });
    item("o1", "JX1-BLK-FBA", 10, 1000, "sku-1"); // no depletion written

    const h = getAmazonHeadline(RANGE);
    expect(h.cogs).toBe(0);
    // Ten units sold, none costed — margin is flattering and says so.
    expect(h.hasFullCostData).toBe(false);
  });

  it("excludes cancelled orders", () => {
    order("o1", { subtotal: 100, total: 100 });
    item("o1", "JX1-BLK-FBA", 1, 100);
    order("o2", { subtotal: 999, total: 999, status: "cancelled" });
    item("o2", "JX1-BLK-FBA", 9, 999);

    expect(getAmazonHeadline(RANGE).grossSales).toBe(100);
  });

  it("excludes orders outside the range", () => {
    order("o1", { subtotal: 100, total: 100, placed_at: "2026-06-15T00:00:00Z" });
    item("o1", "JX1-BLK-FBA", 1, 100);
    expect(getAmazonHeadline(RANGE).grossSales).toBe(0);
  });

  it("returns nulls rather than dividing by zero on an empty period", () => {
    const h = getAmazonHeadline(RANGE);
    expect(h).toMatchObject({ grossSales: 0, promotions: 0, orders: 0, units: 0 });
    expect(h.promotionsPctOfGross).toBeNull();
    expect(h.feeLoadPct).toBeNull();
    expect(h.hasFullCostData).toBe(true); // nothing sold, nothing uncosted
  });

  it("reports fee load as a share of gross", () => {
    order("o1", { subtotal: 1000, total: 1000 });
    item("o1", "JX1-BLK-FBA", 10, 1000);
    settlementWithFees([["Referral commission", -150]]);
    expect(getAmazonHeadline(RANGE).feeLoadPct).toBe(15);
  });
});

describe("getAmazonDaily", () => {
  it("includes days that have traffic but no sales", () => {
    // A day with sessions and zero orders is a real signal (traffic that did
    // not convert); dropping it would hide that entirely.
    sqlite.prepare(`
      INSERT INTO amazon_sales_traffic_daily (id, date, gross_sales, units_ordered, units_shipped, sessions, page_views, buy_box_pct, conversion_rate)
      VALUES (?, '2026-07-05', 0, 0, 0, 210, 340, 98.5, 0)
    `).run(crypto.randomUUID());

    const daily = getAmazonDaily(RANGE);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ date: "2026-07-05", sessions: 210, netSales: 0 });
  });

  it("includes days that have sales but no traffic data yet", () => {
    order("o1", { subtotal: 100, total: 100, placed_at: "2026-07-10T00:00:00Z" });
    const daily = getAmazonDaily(RANGE);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ date: "2026-07-10", grossSales: 100, sessions: null });
  });

  it("merges sales and traffic on the same day", () => {
    order("o1", { subtotal: 100, discount: 30, total: 70, placed_at: "2026-07-05T00:00:00Z" });
    sqlite.prepare(`
      INSERT INTO amazon_sales_traffic_daily (id, date, gross_sales, units_ordered, units_shipped, sessions, page_views, buy_box_pct, conversion_rate)
      VALUES (?, '2026-07-05', 100, 4, 3, 210, 340, 98.5, 1.9)
    `).run(crypto.randomUUID());

    const [d] = getAmazonDaily(RANGE);
    expect(d).toMatchObject({ grossSales: 100, promotions: 30, netSales: 70, sessions: 210, unitsShipped: 3 });
  });
});

describe("getAmazonSkus", () => {
  it("ranks SKUs by units and reports contribution", () => {
    order("o1");
    item("o1", "JX1-BLK-FBA", 5, 500);
    item("o1", "JX2-TOR-FBA", 2, 200);

    const rows = getAmazonSkus(RANGE);
    expect(rows[0].sku).toBe("JX1-BLK-FBA");
    expect(rows[0].units).toBe(5);
    expect(rows[0].contribution).toBe(500); // no COGS costed yet
  });

  it("attaches the latest FBA stock position", () => {
    order("o1");
    item("o1", "JX1-BLK-FBA", 5, 500);
    sqlite.prepare(`
      INSERT INTO amazon_fba_inventory (id, snapshot_date, sku, internal_sku, fulfillable_qty, inbound_working_qty, inbound_shipped_qty, inbound_receiving_qty, reserved_qty, unsellable_qty, total_qty)
      VALUES (?, '2026-08-04', 'JX1-BLK-FBA', 'JX1-BLK', 42, 0, 24, 0, 3, 1, 70)
    `).run(crypto.randomUUID());

    const [row] = getAmazonSkus(RANGE);
    expect(row.fbaFulfillable).toBe(42);
    expect(row.fbaInbound).toBe(24);
  });
});

describe("getAmazonInventory", () => {
  it("adds ShipHero on-hand to FBA stock for true owned units", () => {
    // The gap this closes: ShipHero's count drops when units ship to Amazon,
    // so on its own it understates what the business owns.
    sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1','x')").run();
    sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES ('sku-1','p1','JX1-BLK')").run();
    sqlite.prepare("INSERT INTO inventory (id, sku_id, location, quantity) VALUES (?, 'sku-1', 'warehouse', 12)").run(crypto.randomUUID());
    sqlite.prepare(`
      INSERT INTO amazon_fba_inventory (id, snapshot_date, sku, internal_sku, fulfillable_qty, inbound_working_qty, inbound_shipped_qty, inbound_receiving_qty, reserved_qty, unsellable_qty, total_qty)
      VALUES (?, '2026-08-04', 'JX1-BLK-FBA', 'JX1-BLK', 42, 0, 24, 0, 3, 1, 70)
    `).run(crypto.randomUUID());

    const [row] = getAmazonInventory();
    expect(row.fbaTotal).toBe(70);
    expect(row.warehouseOnHand).toBe(12);
    expect(row.totalOwned).toBe(82);
  });

  it("uses only the most recent snapshot per SKU", () => {
    for (const [d, q] of [["2026-08-01", 10], ["2026-08-04", 42]] as const) {
      sqlite.prepare(`
        INSERT INTO amazon_fba_inventory (id, snapshot_date, sku, internal_sku, fulfillable_qty, inbound_working_qty, inbound_shipped_qty, inbound_receiving_qty, reserved_qty, unsellable_qty, total_qty)
        VALUES (?, ?, 'JX1-BLK-FBA', 'JX1-BLK', ?, 0, 0, 0, 0, 0, ?)
      `).run(crypto.randomUUID(), d, q, q);
    }
    const rows = getAmazonInventory();
    expect(rows).toHaveLength(1);
    expect(rows[0].fbaFulfillable).toBe(42);
  });
});

describe("getAmazonUnmappedSkus", () => {
  it("lists SKUs that cannot be costed, with volume so they can be prioritised", () => {
    order("o1");
    item("o1", "JX1-BLK-FBA", 5, 500, null);
    item("o1", "JX2-TOR-FBA", 2, 200, "sku-2");

    const unmapped = getAmazonUnmappedSkus();
    expect(unmapped).toEqual([{ sku: "JX1-BLK-FBA", units: 5 }]);
  });
});
