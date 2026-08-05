/**
 * FBA transfer generation.
 *
 * Two invariants carry more weight than everything else here, because getting
 * either wrong corrupts the books rather than just the shipment:
 *
 *   - the ShipHero order is priced at $0, since moving stock between our own
 *     locations is not a sale and must never recognise COGS;
 *   - a quantity larger than warehouse stock is refused HERE, where it costs
 *     nothing, rather than at the pick, where it costs a shipment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  buildFbaTransfer,
  buildFbaTransferFromProposal,
  recordFbaTransfer,
} from "@/modules/integrations/lib/amazon/fba-transfer";
import { buildReplenishmentProposal } from "@/modules/integrations/lib/amazon/replenishment";

let sqlite: ReturnType<typeof getTestDb>;
const TODAY = "2026-08-04";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function seed(opts: {
  sku: string; warehouseQty: number; paidUnits?: number; landed?: number | null;
}) {
  const id = `s-${opts.sku}`;
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
  ).run();
  const internal = opts.sku.replace(/-FBA$/i, "");
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p-1', ?)").run(id, internal);
  sqlite.prepare(
    "INSERT INTO inventory (id, sku_id, location, quantity) VALUES (?, ?, 'warehouse', ?)",
  ).run(crypto.randomUUID(), id, opts.warehouseQty);

  if (opts.landed != null) {
    sqlite.prepare(`
      INSERT INTO inventory_cost_layers
        (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
      VALUES (?, ?, 500, 500, ?, 0, 0, ?, '2026-05-01')
    `).run(crypto.randomUUID(), id, opts.landed, opts.landed);
  }

  sqlite.prepare(`
    INSERT INTO amazon_restock_recommendations
      (id, snapshot_date, sku, internal_sku, asin, product_name, alert,
       recommended_qty, units_sold_30d, days_of_supply, available, inbound,
       working, receiving, total_units, price)
    VALUES (?, ?, ?, ?, 'B0AAA', ?, '', 100, 30, 30, 0, 0, 0, 0, 0, 28)
  `).run(crypto.randomUUID(), TODAY, opts.sku, internal, `Title ${internal}`);

  for (let i = 0; i < (opts.paidUnits ?? 30); i++) {
    sqlite.prepare(`
      INSERT INTO amazon_order_rows
        (id, amazon_order_id, sku, quantity, item_price, item_tax,
         item_promotion_discount, ship_promotion_discount, shipping_price,
         shipping_tax, item_status, purchase_date)
      VALUES (?, ?, ?, 1, 28, 0, 0, 0, 0, 0, 'Shipped', '2026-07-20T12:00:00Z')
    `).run(crypto.randomUUID(), crypto.randomUUID(), opts.sku);
  }
}

const proposal = () => buildReplenishmentProposal({ today: TODAY });
const build = (lines: Array<{ sku: string; quantity: number }>) =>
  buildFbaTransfer({ lines, reference: "FBA-TEST", date: TODAY, proposal: proposal() });

const csvRows = (csv: string) => csv.trim().split("\n").map((r) => r.split(","));

describe("the $0 transfer invariant", () => {
  it("prices every ShipHero line at zero", () => {
    // A transfer between our own locations is not a sale. A non-zero price
    // here would flow into revenue and COGS for goods nobody bought.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 50 }]);

    const rows = csvRows(plan.shipheroCsv);
    const priceIdx = rows[0].indexOf("Price");
    expect(rows.slice(1).every((r) => Number(r[priceIdx]) === 0)).toBe(true);
  });

  it("labels the order as a transfer so nobody reads it as a sale", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    expect(build([{ sku: "JX1-BLK-FBA", quantity: 50 }]).shipheroCsv)
      .toContain("stock transfer, not a sale");
  });

  it("reports value moving at cost, not at price", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 50 }]);
    expect(plan.totals.valueAtCost).toBe(300); // 50 × $6 landed, not 50 × $28
  });
});

describe("SKU spelling", () => {
  it("picks the warehouse spelling and ships as the Amazon one", () => {
    // ShipHero cannot pick "JX1-BLK-FBA"; Amazon must receive it as that.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 10 }]);

    expect(plan.lines[0].warehouseSku).toBe("JX1-BLK");
    expect(plan.lines[0].amazonSku).toBe("JX1-BLK-FBA");
    expect(plan.shipheroCsv).toContain("JX1-BLK,");
    expect(plan.fbaPlanCsv).toContain("JX1-BLK-FBA");
  });

  it("puts the product title on the FBA plan, not just a code", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    expect(build([{ sku: "JX1-BLK-FBA", quantity: 10 }]).fbaPlanCsv).toContain("Title JX1-BLK");
  });
});

describe("validation", () => {
  it("refuses more than the warehouse holds", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 20, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 100 }]);

    expect(plan.lines).toHaveLength(0);
    expect(plan.rejected[0].reason).toContain("Warehouse holds 20");
  });

  it("merges duplicate SKUs before checking stock", () => {
    // Two lines of 15 against 20 on hand is 30 requested — it must fail as
    // one line, not pass twice.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 20, landed: 6 });
    const plan = build([
      { sku: "JX1-BLK-FBA", quantity: 15 },
      { sku: "JX1-BLK-FBA", quantity: 15 },
    ]);
    expect(plan.lines).toHaveLength(0);
    expect(plan.rejected[0].requested).toBe(30);
  });

  it("merges duplicates that do fit into one line", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([
      { sku: "JX1-BLK-FBA", quantity: 10 },
      { sku: "JX1-BLK-FBA", quantity: 15 },
    ]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].quantity).toBe(25);
  });

  it("rejects a SKU the proposal has never heard of", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX-GHOST-FBA", quantity: 5 }]);
    expect(plan.rejected[0].reason).toContain("Not in the current replenishment proposal");
  });

  it("rejects a zero or negative quantity", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 0 }, { sku: "JX1-BLK-FBA", quantity: -5 }]);
    expect(plan.lines).toHaveLength(0);
    expect(plan.rejected).toHaveLength(2);
  });

  it("allows over-shipping the proposal but says how much cover it buys", () => {
    // The operator may be seeding a launch the model cannot see. Flag, do not
    // block — but make the consequence legible.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 500, paidUnits: 30, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 300 }]);

    expect(plan.lines[0].quantity).toBe(300);
    expect(plan.warnings.join(" ")).toContain("days of cover");
  });

  it("warns when a SKU has no cost basis rather than valuing it at zero silently", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: null });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 10 }]);
    expect(plan.warnings.join(" ")).toContain("no FIFO layer");
    expect(plan.lines[0].landedCostPerUnit).toBeNull();
  });
});

describe("straight from the proposal", () => {
  it("ships exactly what the proposal recommends", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 500, paidUnits: 30, landed: 6 });
    const plan = buildFbaTransferFromProposal({ reference: "FBA-AUTO", date: TODAY });
    // 1 unit/day × 60 days cover, nothing at Amazon yet.
    expect(plan.lines[0].quantity).toBe(60);
    expect(plan.totals.units).toBe(60);
  });

  it("produces an empty plan rather than a bad one when nothing is due", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 500, paidUnits: 0, landed: 6 });
    const plan = buildFbaTransferFromProposal({ reference: "FBA-AUTO", date: TODAY });
    expect(plan.lines).toEqual([]);
    expect(plan.totals.units).toBe(0);
  });
});

describe("recording", () => {
  it("records in-flight units so the next proposal knows they are gone", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 40 }]);
    expect(recordFbaTransfer(plan).recorded).toBe(1);

    const row = sqlite.prepare("SELECT * FROM amazon_fba_transfers").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      reference: "FBA-TEST", sku: "JX1-BLK-FBA", warehouse_sku: "JX1-BLK", quantity: 40,
    });
  });

  it("is idempotent on the same reference", () => {
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    const plan = build([{ sku: "JX1-BLK-FBA", quantity: 40 }]);
    recordFbaTransfer(plan);
    recordFbaTransfer(plan);
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM amazon_fba_transfers").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("does not record anything just from building a plan", () => {
    // Producing a plan to look at must never commit to it.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 200, landed: 6 });
    build([{ sku: "JX1-BLK-FBA", quantity: 40 }]);
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM amazon_fba_transfers").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("the in-flight loop", () => {
  it("stops a recorded transfer being proposed twice", () => {
    // Amazon can take days to acknowledge an inbound shipment, and during
    // that window its own inbound count reads zero. Without this the next
    // proposal recommends units that are already on a truck.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 500, paidUnits: 30, landed: 6 });

    const first = buildFbaTransferFromProposal({ reference: "FBA-1", date: TODAY });
    expect(first.lines[0].quantity).toBe(60);
    recordFbaTransfer(first);

    const second = buildReplenishmentProposal({ today: TODAY }).lines[0];
    expect(second.inFlight).toBe(60);
    expect(second.proposedQty).toBe(0);
  });

  it("stops counting a transfer once Amazon has received it", () => {
    // At that point Amazon's own available/inbound covers it, so continuing
    // to count ours would double it and starve the SKU.
    seed({ sku: "JX1-BLK-FBA", warehouseQty: 500, paidUnits: 30, landed: 6 });
    recordFbaTransfer(buildFbaTransferFromProposal({ reference: "FBA-1", date: TODAY }));
    sqlite.prepare("UPDATE amazon_fba_transfers SET received_at = ?").run(TODAY);

    expect(buildReplenishmentProposal({ today: TODAY }).lines[0].inFlight).toBe(0);
  });
});
