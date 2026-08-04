/**
 * Amazon month-end checklist tests.
 *
 * Each check exists to catch a specific way the month could close wrong, so
 * the tests assert both directions: that a clean period reads clean, and
 * that the problem is actually detected with an actionable message.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildAmazonMonthEnd } from "@/modules/integrations/lib/amazon/month-end";

let sqlite: ReturnType<typeof getTestDb>;
const MONTH = "2026-07";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

const check = (id: string) => {
  const r = buildAmazonMonthEnd(MONTH);
  return r.checks.find((c) => c.id === id)!;
};

function settlement(over: { posted?: boolean; end?: string } = {}) {
  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, adjustments, net_amount, currency, external_id, status, xero_transaction_id, created_at)
    VALUES (?, 'amazon', '2026-07-01', ?, 100, 10, 0, 90, 'USD', ?, 'received', ?, datetime('now'))
  `).run(id, over.end ?? "2026-07-15", `amazon_settlement_${id}`, over.posted ? "xero-1" : null);
  return id;
}

function shippedOrder(id: string, qty: number, skuId: string | null = "sku-1") {
  sqlite.prepare(`
    INSERT INTO orders (id, order_number, channel, status, total, placed_at, shipped_at, created_at)
    VALUES (?, ?, 'amazon', 'shipped', 100, '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z', datetime('now'))
  `).run(id, `AMZ-${id}`);
  sqlite.prepare(`
    INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price)
    VALUES (?, ?, 'JX1-BLK-FBA', ?, 'x', ?, 10, ?)
  `).run(`oi-${id}`, id, skuId, qty, qty * 10);
}

function depletion(orderItemId: string, qty: number) {
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, 'sku-1', 100, 90, 5, 0, 0, 5, '2026-06-01')
  `).run(`l-${orderItemId}`);
  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, NULL, 'amazon', ?, 5, 5, '2026-07-10')
  `).run(crypto.randomUUID(), `l-${orderItemId}`, orderItemId, qty);
}

describe("month bounds", () => {
  it("covers the whole month including the last day", () => {
    const r = buildAmazonMonthEnd("2026-02");
    expect(r.periodStart).toBe("2026-02-01");
    expect(r.periodEnd).toBe("2026-02-28"); // 2026 is not a leap year
  });

  it("handles a 31-day month", () => {
    expect(buildAmazonMonthEnd("2026-07").periodEnd).toBe("2026-07-31");
  });
});

describe("settlements posted", () => {
  it("blocks when a closed settlement has not reached Xero", () => {
    settlement({ posted: false });
    const c = check("settlements_posted");
    expect(c.status).toBe("blocked");
    expect(c.action).toContain("before closing the month");
  });

  it("passes once posted", () => {
    settlement({ posted: true });
    expect(check("settlements_posted").status).toBe("ok");
  });
});

describe("COGS coverage", () => {
  it("blocks when shipped units are not costed, since margin is overstated", () => {
    shippedOrder("o1", 10);
    const c = check("cogs_coverage");
    expect(c.status).toBe("blocked");
    expect(c.summary).toContain("10 of 10");
  });

  it("passes when every shipped unit has a depletion", () => {
    shippedOrder("o1", 10);
    depletion("oi-o1", 10);
    expect(check("cogs_coverage").status).toBe("ok");
  });
});

describe("unmapped SKUs", () => {
  it("blocks when a SKU cannot be costed", () => {
    shippedOrder("o1", 5, null);
    const c = check("unmapped_skus");
    expect(c.status).toBe("blocked");
    expect(c.detail?.[0]).toMatchObject({ sku: "JX1-BLK-FBA", units: 5 });
  });

  it("passes when every SKU resolves", () => {
    shippedOrder("o1", 5, "sku-1");
    expect(check("unmapped_skus").status).toBe("ok");
  });
});

describe("unclassified fees", () => {
  it("flags a line that landed in suspense", () => {
    const sid = settlement({ posted: true });
    sqlite.prepare(`
      INSERT INTO settlement_line_items (id, settlement_id, order_id, type, description, amount, created_at)
      VALUES (?, ?, NULL, 'fee', 'Unclassified — needs review', -12, datetime('now'))
    `).run(crypto.randomUUID(), sid);

    const c = check("unclassified_fees");
    expect(c.status).toBe("attention");
    expect(c.action).toContain("settlement-classify");
  });
});

describe("inventory reconciliation (FIFO vs ShipHero + FBA)", () => {
  function fifo(units: number) {
    sqlite.prepare(`
      INSERT INTO inventory_cost_layers (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
      VALUES (?, 'sku-1', ?, ?, 5, 0, 0, 5, '2026-06-01')
    `).run(crypto.randomUUID(), units, units);
  }
  function warehouse(units: number) {
    sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1','x')").run();
    sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES ('sku-1','p1','JX1-BLK')").run();
    sqlite.prepare("INSERT INTO inventory (id, sku_id, location, quantity) VALUES (?, 'sku-1', 'warehouse', ?)")
      .run(crypto.randomUUID(), units);
  }
  function fbaStock(units: number) {
    sqlite.prepare(`
      INSERT INTO amazon_fba_inventory (id, snapshot_date, sku, internal_sku, fulfillable_qty, inbound_working_qty, inbound_shipped_qty, inbound_receiving_qty, reserved_qty, unsellable_qty, total_qty)
      VALUES (?, '2026-07-31', 'JX1-BLK-FBA', 'JX1-BLK', ?, 0, 0, 0, 0, 0, ?)
    `).run(crypto.randomUUID(), units, units);
  }

  it("passes when FIFO matches ShipHero plus FBA", () => {
    // The point of the check: FIFO tracks units we OWN, wherever they sit.
    // Counting only ShipHero would look like a huge shortfall.
    fifo(500); warehouse(300); fbaStock(200);
    const c = check("inventory_reconciliation");
    expect(c.status).toBe("ok");
    expect(c.summary).toContain("300 ShipHero + 200 FBA");
  });

  it("flags FIFO holding more than exists — a missed depletion", () => {
    fifo(1000); warehouse(300); fbaStock(200);
    const c = check("inventory_reconciliation");
    expect(c.status).toBe("attention");
    expect(c.action).toContain("understates COGS");
  });

  it("flags FIFO holding less than exists — a possible double depletion", () => {
    // This is the shape a transfer-costed-as-a-sale would take.
    fifo(100); warehouse(300); fbaStock(200);
    const c = check("inventory_reconciliation");
    expect(c.status).toBe("attention");
    expect(c.action).toContain("depleted twice");
  });

  it("tolerates small drift rather than crying wolf every month", () => {
    fifo(505); warehouse(300); fbaStock(200);
    expect(check("inventory_reconciliation").status).toBe("ok");
  });
});

describe("overall status", () => {
  it("is the worst of the individual checks", () => {
    settlement({ posted: false }); // blocked
    expect(buildAmazonMonthEnd(MONTH).overall).toBe("blocked");
  });

  it("reports attention rather than blocked when nothing is fatal", () => {
    settlement({ posted: true });
    const r = buildAmazonMonthEnd(MONTH);
    expect(["ok", "attention"]).toContain(r.overall);
  });
});
