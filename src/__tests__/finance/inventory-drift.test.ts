/**
 * FIFO drift diagnostics tests.
 *
 * The whole point of this module is telling two causes apart, so the tests are
 * built around that: the same total drift must read "baseline" when it sits on
 * pre-costing layers and "concentrated" when it sits on a handful of SKUs.
 * Getting that backwards sends someone hunting a missing depletion that does
 * not exist, which is exactly what the module is meant to prevent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildDriftReport, buildCoverageReport } from "@/modules/finance/lib/inventory-drift";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function sku(id: string, code: string) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES (?, ?, datetime('now'))",
  ).run(`p-${id}`, `Product ${id}`);
  sqlite.prepare(
    "INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, ?, ?, 'Black')",
  ).run(id, `p-${id}`, code);
}

function layer(skuId: string, qty: number, remaining: number, receivedAt: string) {
  const id = `l-${skuId}-${receivedAt}-${qty}-${remaining}`;
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, ?, ?, ?, 5, 0, 0, 5, ?)
  `).run(id, skuId, qty, remaining, receivedAt);
  return id;
}

function depletion(layerId: string, qty: number, at: string, orderItemId: string | null = null) {
  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions
      (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, NULL, 'amazon', ?, 5, 5, ?)
  `).run(crypto.randomUUID(), layerId, orderItemId, qty, at);
}

function warehouse(skuId: string, qty: number) {
  sqlite.prepare(
    "INSERT INTO inventory (id, sku_id, location, quantity) VALUES (?, ?, 'warehouse', ?)",
  ).run(crypto.randomUUID(), skuId, qty);
}

function fba(amazonSku: string, qty: number, date = "2026-08-04") {
  sqlite.prepare(`
    INSERT INTO amazon_fba_inventory (id, sku, snapshot_date, total_qty)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), amazonSku, date, qty);
}

describe("physical stock sourcing", () => {
  it("counts ShipHero and FBA as the same owned pool", () => {
    sku("s1", "JX1-BLK");
    layer("s1", 100, 100, "2026-01-01");
    warehouse("s1", 40);
    fba("JX1-BLK-FBA", 60);

    const r = buildDriftReport();
    expect(r.totals.warehouse).toBe(40);
    expect(r.totals.fba).toBe(60);
    expect(r.totals.drift).toBe(0);
  });

  it("matches FBA stock listed under the bare SKU as well as the -FBA suffix", () => {
    // Amazon reports whichever spelling the listing carries; both are ours.
    sku("s1", "JX1-BLK");
    layer("s1", 50, 50, "2026-01-01");
    fba("JX1-BLK", 50);
    expect(buildDriftReport().totals.fba).toBe(50);
  });

  it("uses only the latest FBA snapshot", () => {
    sku("s1", "JX1-BLK");
    layer("s1", 10, 10, "2026-01-01");
    fba("JX1-BLK-FBA", 999, "2026-07-01");
    fba("JX1-BLK-FBA", 10, "2026-08-04");
    expect(buildDriftReport().totals.fba).toBe(10);
  });
});

describe("verdict", () => {
  it("reads clean when FIFO matches physical", () => {
    sku("s1", "JX1-BLK");
    layer("s1", 500, 500, "2026-01-01");
    warehouse("s1", 500);
    expect(buildDriftReport().shape.verdict).toBe("clean");
  });

  it("calls it baseline when the drift sits on layers that predate costing", () => {
    // 1000 units layered in January, costing only began in July. The 900-unit
    // gap was never this system's to deplete.
    sku("s1", "JX1-BLK");
    const old = layer("s1", 1000, 1000, "2026-01-01");
    const recent = layer("s1", 100, 90, "2026-07-01");
    depletion(recent, 10, "2026-07-15");
    warehouse("s1", 190);

    const r = buildDriftReport();
    expect(r.totals.drift).toBe(900);
    expect(r.shape.verdict).toBe("baseline");
    expect(r.shape.preCostingUnitsRemaining).toBe(1000);
    expect(r.shape.costingStartedAt).toBe("2026-07-15");
    expect(r.shape.explanation).toContain("opening-balance");
    expect(old).toBeTruthy();
  });

  it("calls it concentrated when post-costing layers hold the drift", () => {
    // Everything was layered after costing started, so a gap here means real
    // sales went uncosted — the opposite remediation.
    sku("s1", "JX1-BLK");
    sku("s2", "JX2-BLK");
    const l1 = layer("s1", 1000, 1000, "2026-07-02");
    depletion(l1, 1, "2026-07-01");
    layer("s2", 100, 100, "2026-07-02");
    warehouse("s1", 100);
    warehouse("s2", 100);

    const r = buildDriftReport();
    expect(r.shape.verdict).toBe("concentrated");
    expect(r.shape.top5Share).toBe(100);
    expect(r.shape.explanation).toContain("5 SKUs");
  });
});

describe("per-SKU rows", () => {
  it("sorts worst drift first and respects the limit", () => {
    sku("s1", "A"); sku("s2", "B"); sku("s3", "C");
    layer("s1", 10, 10, "2026-07-01");
    layer("s2", 900, 900, "2026-07-01");
    layer("s3", 50, 50, "2026-07-01");

    const r = buildDriftReport({ limit: 2 });
    expect(r.skus).toHaveLength(2);
    expect(r.skus[0].sku).toBe("B");
    expect(r.skus[1].sku).toBe("C");
    // Totals stay whole-catalog even when the rows are capped.
    expect(r.totals.fifoRemaining).toBe(960);
  });

  it("reports layered and depleted units per SKU", () => {
    sku("s1", "A");
    const l = layer("s1", 100, 70, "2026-07-01");
    depletion(l, 30, "2026-07-05");
    const row = buildDriftReport().skus[0];
    expect(row.layered).toBe(100);
    expect(row.depleted).toBe(30);
    expect(row.firstDepletionAt).toBe("2026-07-05");
  });

  it("includes a SKU with stock but no cost layers at all", () => {
    // Physical stock with no layer is drift in the negative direction, and is
    // the shape that means a PO was never costed.
    sku("s1", "A");
    warehouse("s1", 40);
    const r = buildDriftReport();
    expect(r.skus[0].drift).toBe(-40);
  });
});

describe("coverage", () => {
  function shipped(id: string, skuId: string, qty: number, channel = "amazon", costed = false) {
    sqlite.prepare(`
      INSERT INTO orders (id, order_number, channel, status, total, placed_at, shipped_at, created_at)
      VALUES (?, ?, ?, 'shipped', 100, '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z', datetime('now'))
    `).run(id, `O-${id}`, channel);
    sqlite.prepare(`
      INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price)
      VALUES (?, ?, 'JX1-BLK', ?, 'x', ?, 10, ?)
    `).run(`oi-${id}`, id, skuId, qty, qty * 10);
    if (costed) {
      const l = layer(skuId, qty, 0, "2026-07-01");
      depletion(l, qty, "2026-07-10", `oi-${id}`);
    }
  }

  it("counts only shipped lines with no depletion", () => {
    sku("s1", "JX1-BLK");
    shipped("o1", "s1", 3);
    shipped("o2", "s1", 5, "amazon", true);

    const c = buildCoverageReport();
    expect(c.uncostedItems).toBe(1);
    expect(c.uncostedUnits).toBe(3);
  });

  it("splits by channel so a single bad importer is visible", () => {
    sku("s1", "JX1-BLK");
    shipped("o1", "s1", 3, "amazon");
    shipped("o2", "s1", 7, "shopify");

    const byChannel = buildCoverageReport().byChannel;
    expect(byChannel[0]).toMatchObject({ channel: "shopify", units: 7 });
    expect(byChannel[1]).toMatchObject({ channel: "amazon", units: 3 });
  });

  it("flags uncosted lines whose SKU has no layer to draw from", () => {
    // Running a depletion against these does nothing — they need a PO first,
    // so calling them out separately is the difference between a fix and a
    // no-op that looks like a fix.
    sku("s1", "JX1-BLK");
    shipped("o1", "s1", 3);
    expect(buildCoverageReport().unlayeredSkus).toEqual([{ sku: "JX1-BLK", units: 3 }]);
  });

  it("stops flagging a SKU once it has stock to draw from", () => {
    sku("s1", "JX1-BLK");
    layer("s1", 100, 100, "2026-07-01");
    shipped("o1", "s1", 3);
    const c = buildCoverageReport();
    expect(c.uncostedUnits).toBe(3);
    expect(c.unlayeredSkus).toEqual([]);
  });

  it("honours the since cutoff", () => {
    sku("s1", "JX1-BLK");
    shipped("o1", "s1", 3);
    expect(buildCoverageReport({ since: "2026-08-01" }).uncostedUnits).toBe(0);
  });
});
