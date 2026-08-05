/**
 * Amazon month-over-month account report + narrative.
 *
 * The numbers matter, but the narrative is what makes this readable and is
 * the easiest thing to get quietly wrong. A sentence that states a trend from
 * one month of data, or omits a metric it could not compute, is worse than no
 * sentence — it reads as a measurement either way.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildAmazonMonthlyReport } from "@/modules/integrations/lib/amazon/monthly-report";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function orderRow(opts: {
  date: string; price: number; discount?: number; qty?: number;
  order?: string; sku?: string; status?: string;
}) {
  sqlite.prepare(`
    INSERT INTO amazon_order_rows
      (id, amazon_order_id, sku, quantity, item_price, item_tax,
       item_promotion_discount, ship_promotion_discount, shipping_price,
       shipping_tax, item_status, purchase_date)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?)
  `).run(
    crypto.randomUUID(), opts.order ?? crypto.randomUUID(),
    opts.sku ?? `JX-${crypto.randomUUID().slice(0, 8)}`,
    opts.qty ?? 1, opts.price, opts.discount ?? 0,
    opts.status ?? "Shipped", `${opts.date}T12:00:00Z`,
  );
}

function depletion(opts: { date: string; qty: number; unitCost: number; seeded: boolean }) {
  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO orders (id, order_number, channel, status, total, placed_at, shipped_at, created_at)
    VALUES (?, ?, 'amazon', 'shipped', 0, ?, ?, datetime('now'))
  `).run(id, `AMZ-${id}`, `${opts.date}T00:00:00Z`, `${opts.date}T00:00:00Z`);
  sqlite.prepare(`
    INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price, discount)
    VALUES (?, ?, 'JX1', 'sku-1', 'x', ?, 28, ?, ?)
  `).run(`oi-${id}`, id, opts.qty, 28 * opts.qty, opts.seeded ? 28 * opts.qty : 0);
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, 'sku-1', 100, 50, ?, 0, 0, ?, '2026-05-01')
  `).run(`l-${id}`, opts.unitCost, opts.unitCost);
  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions
      (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, ?, 'amazon', ?, ?, ?, ?)
  `).run(crypto.randomUUID(), `l-${id}`, `oi-${id}`, id, opts.qty, opts.unitCost, opts.unitCost, `${opts.date}T12:00:00Z`);
}

const report = (months = 3) => buildAmazonMonthlyReport({ months });
const text = (r = report()) => r.narrative.join(" ");

describe("figures", () => {
  it("separates giveaway from paid sales", () => {
    orderRow({ date: "2026-07-05", price: 28, discount: 28 });
    orderRow({ date: "2026-07-06", price: 28 });

    const m = report().months[0];
    expect(m.grossSales).toBe(56);
    expect(m.giveaway).toBe(28);
    expect(m.netSales).toBe(28);
    expect(m.freeUnits).toBe(1);
    expect(m.units).toBe(2);
  });

  it("computes AOV over paid orders only", () => {
    // Dividing by all orders would let giveaways drag AOV down and read as a
    // pricing problem.
    orderRow({ date: "2026-07-05", price: 28, discount: 28, order: "free-1" });
    orderRow({ date: "2026-07-06", price: 40, order: "paid-1" });

    expect(report().months[0].aov).toBe(40);
  });

  it("returns zero AOV rather than dividing by no paid orders", () => {
    orderRow({ date: "2026-07-05", price: 28, discount: 28 });
    expect(report().months[0].aov).toBe(0);
  });

  it("excludes cancelled lines", () => {
    orderRow({ date: "2026-07-05", price: 28, status: "Cancelled" });
    orderRow({ date: "2026-07-06", price: 28 });
    expect(report().months[0].units).toBe(1);
  });

  it("splits landed cost between COGS and seeding", () => {
    depletion({ date: "2026-07-10", qty: 2, unitCost: 5, seeded: false });
    depletion({ date: "2026-07-11", qty: 3, unitCost: 5, seeded: true });
    orderRow({ date: "2026-07-05", price: 200 });

    const m = report().months[0];
    expect(m.cogs).toBe(10);
    expect(m.seedingCost).toBe(15);
    // Seeding is marketing, so it must NOT reduce contribution margin.
    expect(m.contribution).toBe(190);
  });

  it("orders months oldest first", () => {
    orderRow({ date: "2026-06-05", price: 10 });
    orderRow({ date: "2026-07-05", price: 20 });
    expect(report().months.map((m) => m.month)).toEqual(["2026-06", "2026-07"]);
  });
});

describe("change column", () => {
  it("reports absolute and percentage change first to last", () => {
    orderRow({ date: "2026-06-05", price: 100 });
    orderRow({ date: "2026-07-05", price: 150 });

    const c = report().change!;
    expect(c.netSales).toEqual({ absolute: 50, pct: 50 });
  });

  it("returns null percentage when the base is zero rather than infinity", () => {
    // A change from nothing is not 100% or infinite — it is undefined, and
    // rendering it as a number would look like a measurement.
    orderRow({ date: "2026-06-05", price: 100, discount: 100 });
    orderRow({ date: "2026-07-05", price: 150 });

    const c = report().change!;
    expect(c.netSales.pct).toBeNull();
    expect(c.netSales.absolute).toBe(150);
  });

  it("omits the change column with only one month of data", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    expect(report().change).toBeNull();
  });
});

describe("narrative", () => {
  it("leads with what was actually earned, not gross", () => {
    for (let i = 0; i < 9; i++) orderRow({ date: "2026-07-05", price: 28, discount: 28 });
    orderRow({ date: "2026-07-06", price: 28 });

    const t = text();
    expect(t).toContain("9 of 10 units (90%) took no money");
    expect(t).toContain("actually paid $28");
  });

  it("states no trend from a single month", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    expect(text()).not.toContain("→");
  });

  it("names both months when it does state a trend", () => {
    orderRow({ date: "2026-06-05", price: 100 });
    orderRow({ date: "2026-07-05", price: 150 });
    const t = text();
    expect(t).toContain("Jun 2026");
    expect(t).toContain("Jul 2026");
    expect(t).toContain("grew");
  });

  it("calls out a shift in giveaway mix as a mix change, not demand", () => {
    for (let i = 0; i < 9; i++) orderRow({ date: "2026-06-05", price: 28, discount: 28 });
    orderRow({ date: "2026-06-06", price: 28 });
    for (let i = 0; i < 10; i++) orderRow({ date: "2026-07-05", price: 28 });

    expect(text()).toContain("change in mix rather than in demand");
  });

  it("always says the figure excludes advertising", () => {
    // Silence here would read as "net profit". Saying it is the point.
    orderRow({ date: "2026-07-05", price: 100 });
    const t = text();
    expect(t).toContain("NOT net profit");
    expect(t).toContain("Amazon Ads connector");
  });

  it("says so plainly when there is no activity at all", () => {
    expect(report().narrative).toEqual(["No Amazon activity in the reporting window."]);
  });

  it("notes that seeded stock sits in marketing", () => {
    orderRow({ date: "2026-07-05", price: 200 });
    depletion({ date: "2026-07-10", qty: 3, unitCost: 5, seeded: true });
    expect(text()).toContain("not cost of sales");
  });
});

describe("provenance", () => {
  it("states the settlement retention limit when settlements exist", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    sqlite.prepare(`
      INSERT INTO amazon_settlement_rows (id, settlement_id, posted_date, amount)
      VALUES (?, 's1', '2026-06-01T00:00:00Z', 10)
    `).run(crypto.randomUUID());

    const p = report().provenance.join(" ");
    expect(p).toContain("90 days only");
    expect(p).toContain("2026-06-01");
  });

  it("says COGS is real landed cost, not an estimate", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    expect(report().provenance.join(" ")).toContain("traceable to a purchase order");
  });

  it("names months with no session data so blank is not read as zero", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    expect(report().provenance.join(" ")).toContain("Jul 2026");
  });

  it("stops naming a month once it has session data", () => {
    orderRow({ date: "2026-07-05", price: 100 });
    sqlite.prepare(`
      INSERT INTO amazon_sales_traffic_daily (id, date, sessions, units_ordered)
      VALUES (?, '2026-07-05', 500, 10)
    `).run(crypto.randomUUID());

    const r = report();
    expect(r.months[0].sessions).toBe(500);
    expect(r.months[0].conversionPct).toBe(2);
    expect(r.provenance.join(" ")).not.toContain("No session data");
  });
});

describe("digest", () => {
  it("suppresses itself when there is no activity", async () => {
    // A digest that fires weekly with nothing in it trains people to ignore
    // the channel, and this one needs to be read on the weeks it matters.
    const { sendAmazonMonthlyDigest } = await import("@/modules/integrations/lib/amazon/monthly-report");
    const r = await sendAmazonMonthlyDigest({ months: 3 });
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("suppressed");
  });

  it("suppresses when months exist but every one has zero units", async () => {
    orderRow({ date: "2026-07-05", price: 28, status: "Cancelled" });
    const { sendAmazonMonthlyDigest } = await import("@/modules/integrations/lib/amazon/monthly-report");
    expect((await sendAmazonMonthlyDigest({ months: 3 })).sent).toBe(false);
  });
});
