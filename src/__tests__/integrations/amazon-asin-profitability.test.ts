/**
 * Per-ASIN profitability.
 *
 * The reference report this mirrors admits its COGS is a flat $5 per unit
 * everywhere. Ours is real, which is only an advantage if the arithmetic is
 * right — so the tests concentrate on where a per-line P&L usually goes
 * wrong: apportioning account-level fees, excluding giveaway cost, and
 * refusing to render a margin where there were no paid sales to take one of.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildAsinProfitability } from "@/modules/integrations/lib/amazon/asin-profitability";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function sale(opts: {
  sku: string; date: string; price: number; discount?: number; qty?: number; asin?: string;
}) {
  sqlite.prepare(`
    INSERT INTO amazon_order_rows
      (id, amazon_order_id, sku, asin, quantity, item_price, item_tax,
       item_promotion_discount, ship_promotion_discount, shipping_price,
       shipping_tax, item_status, purchase_date)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 'Shipped', ?)
  `).run(
    crypto.randomUUID(), crypto.randomUUID(), opts.sku, opts.asin ?? "B0AAA",
    opts.qty ?? 1, opts.price, opts.discount ?? 0, `${opts.date}T12:00:00Z`,
  );
}

function cost(opts: { sku: string; date: string; qty: number; unitCost: number; seeded?: boolean }) {
  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO orders (id, order_number, channel, status, total, placed_at, shipped_at, created_at)
    VALUES (?, ?, 'amazon', 'shipped', 0, ?, ?, datetime('now'))
  `).run(id, `AMZ-${id}`, `${opts.date}T00:00:00Z`, `${opts.date}T00:00:00Z`);
  sqlite.prepare(`
    INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price, discount)
    VALUES (?, ?, ?, 'sk-1', 'x', ?, 28, ?, ?)
  `).run(`oi-${id}`, id, opts.sku, opts.qty, 28 * opts.qty, opts.seeded ? 28 * opts.qty : 0);
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, 'sk-1', 500, 400, ?, 0, 0, ?, '2026-05-01')
  `).run(`l-${id}`, opts.unitCost, opts.unitCost);
  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions
      (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, ?, 'amazon', ?, ?, ?, ?)
  `).run(crypto.randomUUID(), `l-${id}`, `oi-${id}`, id, opts.qty, opts.unitCost, opts.unitCost, `${opts.date}T12:00:00Z`);
}

function fees(month: string, amount: number) {
  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO settlements (id, channel, period_start, period_end, external_id, status)
    VALUES (?, 'amazon', ?, ?, ?, 'received')
  `).run(id, `${month}-01`, `${month}-28`, `amazon_settlement_${id}`);
  sqlite.prepare(`
    INSERT INTO settlement_line_items (id, settlement_id, type, description, amount)
    VALUES (?, ?, 'fee', 'Referral commission', ?)
  `).run(crypto.randomUUID(), id, -amount);
}

function traffic(opts: { asin: string; date: string; sessions: number; unitsOrdered: number; parent?: string }) {
  sqlite.prepare(`
    INSERT INTO amazon_asin_traffic_daily (id, date, child_asin, parent_asin, sessions, units_ordered)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), opts.date, opts.asin, opts.parent ?? null, opts.sessions, opts.unitsOrdered);
}

const report = (months = 3) => buildAsinProfitability({ months });
const row = (sku: string) => report().rows.find((r) => r.sku === sku)!;

describe("per-SKU figures", () => {
  it("splits paid from giveaway on the row", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 28, discount: 28 });
    sale({ sku: "JX1-BLK", date: "2026-07-06", price: 28 });

    const cell = row("JX1-BLK").months.find((m) => m.month === "2026-07")!;
    expect(cell.grossSales).toBe(56);
    expect(cell.netSales).toBe(28);
    expect(cell.units).toBe(2);
    expect(cell.freeUnits).toBe(1);
  });

  it("excludes the cost of giveaway units from COGS", () => {
    // That cost is marketing. Charging it here would make an ASIN running a
    // Vine campaign look structurally unprofitable.
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100 });
    cost({ sku: "JX1-BLK", date: "2026-07-05", qty: 2, unitCost: 5, seeded: false });
    cost({ sku: "JX1-BLK", date: "2026-07-06", qty: 10, unitCost: 5, seeded: true });

    expect(row("JX1-BLK").months.find((m) => m.month === "2026-07")!.cogs).toBe(10);
  });

  it("carries a month with no activity as zero rather than omitting it", () => {
    sale({ sku: "JX1-BLK", date: "2026-06-05", price: 100 });
    sale({ sku: "JX1-BLK", date: "2026-08-05", price: 100 });

    const r = report();
    expect(r.months).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(r.rows[0].months.map((m) => m.netSales)).toEqual([100, 0, 100]);
  });
});

describe("fee apportionment", () => {
  it("splits account-level fees by share of paid sales", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 750 });
    sale({ sku: "JX2-BLK", date: "2026-07-05", price: 250 });
    fees("2026-07", 100);

    expect(row("JX1-BLK").months[0].fees).toBe(75);
    expect(row("JX2-BLK").months[0].fees).toBe(25);
  });

  it("charges no fee to a month that took no money", () => {
    // Apportioning by share of zero would divide by zero.
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 28, discount: 28 });
    fees("2026-07", 100);
    expect(row("JX1-BLK").months[0].fees).toBe(0);
  });

  it("says in the notes that fees are apportioned, not per-line", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100 });
    const r = report();
    expect(r.feesAreApportioned).toBe(true);
    expect(r.notes.join(" ")).toContain("invented precision");
  });
});

describe("margin", () => {
  it("computes contribution from real landed cost", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100, qty: 4 });
    cost({ sku: "JX1-BLK", date: "2026-07-05", qty: 4, unitCost: 6.25 });
    fees("2026-07", 20);

    const cell = row("JX1-BLK").months[0];
    expect(cell.cogs).toBe(25);
    expect(cell.contribution).toBe(55); // 100 − 20 fees − 25 cogs
    expect(cell.marginPct).toBe(55);
  });

  it("returns a null margin, not zero, when nothing was paid", () => {
    // 0% would sort and colour as a break-even month; there was no month.
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 28, discount: 28 });
    expect(row("JX1-BLK").months[0].marginPct).toBeNull();
  });

  it("flags a loss-making row", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 10, qty: 1 });
    cost({ sku: "JX1-BLK", date: "2026-07-05", qty: 1, unitCost: 40 });

    const r = row("JX1-BLK");
    expect(r.totalContribution).toBeLessThan(0);
    expect(r.lossMaking).toBe(true);
  });

  it("flags a row that is mostly giveaway", () => {
    // The row that looks like a strong seller and is almost entirely Vine.
    for (let i = 0; i < 9; i++) sale({ sku: "JX1-BLK", date: "2026-07-05", price: 28, discount: 28 });
    sale({ sku: "JX1-BLK", date: "2026-07-06", price: 28 });
    expect(row("JX1-BLK").mostlySeeded).toBe(true);
  });
});

describe("traffic", () => {
  it("joins sessions and conversion by ASIN", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100, asin: "B0AAA" });
    traffic({ asin: "B0AAA", date: "2026-07-05", sessions: 400, unitsOrdered: 20, parent: "B0PARENT" });

    const cell = row("JX1-BLK").months[0];
    expect(cell.sessions).toBe(400);
    expect(cell.conversionPct).toBe(5);
    expect(row("JX1-BLK").parentAsin).toBe("B0PARENT");
  });

  it("leaves conversion null rather than zero with no sessions recorded", () => {
    // Blank means "not measured"; 0% means "nobody bought". Different problems.
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100 });
    expect(row("JX1-BLK").months[0].conversionPct).toBeNull();
  });

  it("says so in the notes when no traffic is held at all", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100 });
    expect(report().notes.join(" ")).toContain("blank rather than zero");
  });
});

describe("presentation", () => {
  it("sorts by the latest month's paid sales", () => {
    sale({ sku: "JX1-BLK", date: "2026-06-05", price: 900 });
    sale({ sku: "JX2-BLK", date: "2026-07-05", price: 500 });
    expect(report().rows[0].sku).toBe("JX2-BLK");
  });

  it("resolves the title through the FBA spelling too", () => {
    sale({ sku: "JX1-BLK-FBA", date: "2026-07-05", price: 100 });
    sqlite.prepare(`
      INSERT INTO amazon_listings (sku, internal_sku, title) VALUES ('JX1-BLK', 'JX1-BLK', 'Aviator · Black')
    `).run();
    expect(row("JX1-BLK-FBA").title).toBe("Aviator · Black");
  });

  it("nudges toward the listings sync when titles are missing", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100 });
    expect(report().notes.join(" ")).toContain("run the listings sync");
  });

  it("says there is nothing rather than returning an empty table", () => {
    expect(report().notes).toEqual(["No Amazon orders in the window."]);
  });
});

describe("parent ASIN resolution", () => {
  it("resolves the parent from any month, not only the latest", () => {
    // Resolving from the latest month alone left the parent null for every
    // ASIN with no traffic that month — 51 of 63 rows in production — which
    // silently breaks any roll-up to parent level. Amazon reports Vine
    // enrolment by PARENT ASIN, so that roll-up is how the two reconcile.
    sale({ sku: "JX1-BLK", date: "2026-06-05", price: 100, asin: "B0CHILD" });
    sale({ sku: "JX1-BLK", date: "2026-08-05", price: 100, asin: "B0CHILD" });
    traffic({ asin: "B0CHILD", date: "2026-06-05", sessions: 10, unitsOrdered: 1, parent: "B0PARENT" });
    // Nothing in August — the latest month.

    expect(row("JX1-BLK").parentAsin).toBe("B0PARENT");
  });

  it("leaves the parent null when traffic never named one", () => {
    sale({ sku: "JX1-BLK", date: "2026-07-05", price: 100, asin: "B0CHILD" });
    expect(row("JX1-BLK").parentAsin).toBeNull();
  });
});
