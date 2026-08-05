/**
 * FBA replenishment proposals.
 *
 * Amazon supplies the demand forecast; this module applies the three
 * corrections Amazon cannot make. Each has a failure mode worth pinning:
 *
 *   - Ignore the warehouse → propose units that do not exist.
 *   - Ignore Vine          → ship stock to meet demand that does not pay.
 *                            THE important one on this account.
 *   - Ignore margin        → scarce stock goes to whatever Amazon ranks first.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  buildReplenishmentProposal,
  DEFAULT_COVER_DAYS,
} from "@/modules/integrations/lib/amazon/replenishment";

let sqlite: ReturnType<typeof getTestDb>;
const TODAY = "2026-08-04";
const SNAP = "2026-08-04";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function catalogSku(id: string, sku: string, alias?: string) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
  ).run();
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p-1', ?)").run(id, sku);
  if (alias) {
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES (?, ?, ?)",
    ).run(alias, id, sku);
  }
}

function warehouse(skuId: string, qty: number) {
  sqlite.prepare(
    "INSERT INTO inventory (id, sku_id, location, quantity) VALUES (?, ?, 'warehouse', ?)",
  ).run(crypto.randomUUID(), skuId, qty);
}

function layer(skuId: string, landed: number) {
  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, ?, 500, 500, ?, 0, 0, ?, '2026-05-01')
  `).run(crypto.randomUUID(), skuId, landed, landed);
}

function restock(opts: {
  sku: string; recommended?: number; sold30d?: number; available?: number;
  inbound?: number; price?: number; alert?: string; snapshot?: string;
}) {
  sqlite.prepare(`
    INSERT INTO amazon_restock_recommendations
      (id, snapshot_date, sku, internal_sku, asin, product_name, alert,
       recommended_qty, units_sold_30d, days_of_supply, available, inbound,
       working, receiving, total_units, price)
    VALUES (?, ?, ?, ?, 'B0AAA', 'Sunglasses', ?, ?, ?, 30, ?, ?, 0, 0, 0, ?)
  `).run(
    crypto.randomUUID(), opts.snapshot ?? SNAP, opts.sku,
    opts.sku.replace(/-FBA$/i, ""), opts.alert ?? "",
    opts.recommended ?? 0, opts.sold30d ?? 0,
    opts.available ?? 0, opts.inbound ?? 0, opts.price ?? null,
  );
}

/** N units on the Amazon-facing SKU in the trailing window. */
function sold(sku: string, units: number, opts: { free?: boolean; date?: string } = {}) {
  for (let i = 0; i < units; i++) {
    sqlite.prepare(`
      INSERT INTO amazon_order_rows
        (id, amazon_order_id, sku, quantity, item_price, item_tax,
         item_promotion_discount, ship_promotion_discount, shipping_price,
         shipping_tax, item_status, purchase_date)
      VALUES (?, ?, ?, 1, 28, 0, ?, 0, 0, 0, 'Shipped', ?)
    `).run(
      crypto.randomUUID(), crypto.randomUUID(), sku,
      opts.free ? 28 : 0, `${opts.date ?? "2026-07-20"}T12:00:00Z`,
    );
  }
}

const propose = (coverDays = DEFAULT_COVER_DAYS) =>
  buildReplenishmentProposal({ coverDays, today: TODAY });
const line = (sku: string) => propose().lines.find((l) => l.sku === sku)!;

describe("no data", () => {
  it("says what to run instead of proposing nothing silently", () => {
    const p = propose();
    expect(p.lines).toEqual([]);
    expect(p.warnings[0]).toContain("run the restock sync");
  });

  it("warns when the snapshot is stale rather than trusting it", () => {
    restock({ sku: "JX1-BLK-FBA", snapshot: "2026-07-01" });
    expect(propose().warnings.join(" ")).toContain("days old");
  });
});

describe("correction 1 — the warehouse Amazon cannot see", () => {
  it("caps the proposal at warehouse stock and reports the shortfall", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 20);
    restock({ sku: "JX1-BLK-FBA", recommended: 400, sold30d: 60 });
    sold("JX1-BLK-FBA", 60);

    const l = line("JX1-BLK-FBA");
    expect(l.paidDemandQty).toBe(120);   // 2/day × 60 days
    expect(l.proposedQty).toBe(20);      // capped by stock on hand
    expect(l.shortfall).toBe(100);
    expect(l.flags).toContain("warehouse_short");
  });

  it("resolves warehouse stock through the alias table", () => {
    // The catalog spells it JX1-S-BLK; Amazon reports JX1-BLK-FBA.
    catalogSku("s1", "JX1-S-BLK", "JX1-BLK");
    warehouse("s1", 90);
    restock({ sku: "JX1-BLK-FBA", recommended: 100, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    expect(line("JX1-BLK-FBA").warehouseAvailable).toBe(90);
  });

  it("proposes nothing when the warehouse is empty", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    restock({ sku: "JX1-BLK-FBA", recommended: 400, sold30d: 60 });
    sold("JX1-BLK-FBA", 60);

    const l = line("JX1-BLK-FBA");
    expect(l.proposedQty).toBe(0);
    expect(l.shortfall).toBe(120);
  });

  it("surfaces the shortfall as a purchasing signal in the warnings", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    restock({ sku: "JX1-BLK-FBA", recommended: 400, sold30d: 60 });
    sold("JX1-BLK-FBA", 60);
    expect(propose().warnings.join(" ")).toContain("purchasing signal");
  });
});

describe("correction 2 — Vine", () => {
  it("ignores giveaway units when sizing demand", () => {
    // Amazon says 30 units sold and wants 220. 28 of those took no money, so
    // the paid run-rate is 2 units in 30 days, not 30.
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 220, sold30d: 30 });
    sold("JX1-BLK-FBA", 28, { free: true });
    sold("JX1-BLK-FBA", 2);

    const l = line("JX1-BLK-FBA");
    expect(l.amazonUnitsSold30d).toBe(30);
    expect(l.paidUnits30d).toBe(2);
    expect(l.seededUnits30d).toBe(28);
    expect(l.amazonRecommendedQty).toBe(220);
    expect(l.proposedQty).toBe(4);  // 2/30 per day × 60 days
  });

  it("proposes nothing when every unit was a giveaway", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 300, sold30d: 20 });
    sold("JX1-BLK-FBA", 20, { free: true });

    const l = line("JX1-BLK-FBA");
    expect(l.proposedQty).toBe(0);
    expect(l.flags).toContain("no_paid_velocity");
    expect(l.flags).toContain("amazon_only_demand");
  });

  it("quantifies the giveaway share in the warnings", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    restock({ sku: "JX1-BLK-FBA", recommended: 100, sold30d: 10 });
    sold("JX1-BLK-FBA", 9, { free: true });
    sold("JX1-BLK-FBA", 1);

    const w = propose().warnings.join(" ");
    expect(w).toContain("90% of the last 30 days' units were giveaways");
    expect(w).toContain("Plan Vine units separately");
  });

  it("excludes sales outside the trailing 30 days", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 100, sold30d: 60 });
    sold("JX1-BLK-FBA", 60, { date: "2026-05-01" });

    expect(line("JX1-BLK-FBA").paidUnits30d).toBe(0);
  });

  it("pools demand across the merchant and FBA listings of one product", () => {
    // Corrected against production. Amazon lists many products twice and
    // reports the SAME FBA position on both rows, so they are one product:
    // demand must be summed, or each listing looks half as worth restocking.
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 50, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);
    sold("JX1-BLK", 60);

    expect(line("JX1-BLK-FBA").paidUnits30d).toBe(90);
  });

  it("counts the shared FBA position once across both listings", () => {
    // Both rows carry the same physical stock. Summing would double it and
    // make a product look covered when it is not.
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK", available: 40, sold30d: 30 });
    restock({ sku: "JX1-BLK-FBA", available: 40, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    const p = propose();
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].fbaAvailable).toBe(40);
    expect(p.lines[0].proposedQty).toBe(20); // 60 target − 40 already there
  });
});

describe("stock already at Amazon", () => {
  it("nets off FBA available and inbound before proposing", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 200, sold30d: 60, available: 50, inbound: 30 });
    sold("JX1-BLK-FBA", 60);

    // 2/day × 60 = 120 target, less 80 already there or on the way.
    expect(line("JX1-BLK-FBA").proposedQty).toBe(40);
  });

  it("flags a SKU already covered well beyond the target", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", recommended: 0, sold30d: 30, available: 900 });
    sold("JX1-BLK-FBA", 30);

    const l = line("JX1-BLK-FBA");
    expect(l.proposedQty).toBe(0);
    expect(l.flags).toContain("overstocked");
  });
});

describe("correction 3 — margin ranking", () => {
  it("ranks the higher-earning SKU first when both need stock", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    catalogSku("s2", "JX2-BLK", "JX2-BLK");
    warehouse("s1", 500); warehouse("s2", 500);
    layer("s1", 20);  // $28 − $20 = $8
    layer("s2", 5);   // $28 − $5  = $23
    restock({ sku: "JX1-BLK-FBA", sold30d: 30, price: 28 });
    restock({ sku: "JX2-BLK-FBA", sold30d: 30, price: 28 });
    sold("JX1-BLK-FBA", 30); sold("JX2-BLK-FBA", 30);

    expect(propose().lines[0].sku).toBe("JX2-BLK-FBA");
  });

  it("reports contribution per unit from real landed cost", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 100); layer("s1", 6.25);
    restock({ sku: "JX1-BLK-FBA", sold30d: 30, price: 28 });
    sold("JX1-BLK-FBA", 30);

    const l = line("JX1-BLK-FBA");
    expect(l.landedCostPerUnit).toBe(6.25);
    expect(l.contributionPerUnit).toBe(21.75);
  });

  it("sorts an unknown cost basis last rather than as zero", () => {
    // A missing cost is not a bad product; treating it as zero contribution
    // would bury a SKU that might be the best one to send.
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    catalogSku("s2", "JX2-BLK", "JX2-BLK");
    warehouse("s1", 500); warehouse("s2", 500);
    layer("s2", 5);
    restock({ sku: "JX1-BLK-FBA", sold30d: 30, price: 28 });
    restock({ sku: "JX2-BLK-FBA", sold30d: 30, price: 28 });
    sold("JX1-BLK-FBA", 30); sold("JX2-BLK-FBA", 30);

    const l = propose().lines;
    expect(l[0].sku).toBe("JX2-BLK-FBA");
    expect(l[1].flags).toContain("no_cost_basis");
    expect(l[1].contributionPerUnit).toBeNull();
  });

  it("puts every proposable SKU above every non-proposable one", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    catalogSku("s2", "JX2-BLK", "JX2-BLK");
    warehouse("s2", 500);
    layer("s1", 1);   // huge contribution but no stock to send
    layer("s2", 20);
    restock({ sku: "JX1-BLK-FBA", sold30d: 30, price: 28 });
    restock({ sku: "JX2-BLK-FBA", sold30d: 30, price: 28 });
    sold("JX1-BLK-FBA", 30); sold("JX2-BLK-FBA", 30);

    expect(propose().lines[0].sku).toBe("JX2-BLK-FBA");
  });
});

describe("totals", () => {
  it("reports ours against Amazon's so the gap is visible", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500); layer("s1", 5);
    restock({ sku: "JX1-BLK-FBA", recommended: 220, sold30d: 30, price: 28 });
    sold("JX1-BLK-FBA", 28, { free: true });
    sold("JX1-BLK-FBA", 2);

    const t = propose().totals;
    expect(t.amazonRecommendedUnits).toBe(220);
    expect(t.proposedUnits).toBe(4);
    expect(t.proposedCost).toBe(20);
  });

  it("respects a custom cover target", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 500);
    restock({ sku: "JX1-BLK-FBA", sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    expect(propose(30).lines[0].proposedQty).toBe(30);
    expect(propose(90).lines[0].proposedQty).toBe(90);
  });
});

describe("no row multiplication", () => {
  it("lists a SKU once even when several spellings map to it", () => {
    // Found in production: sku_map yields one row per SPELLING, and a naive
    // per-sku_id join through it multiplied every row. All 140 SKUs were
    // listed twice with doubled totals, and every unit test passed because
    // no fixture had both a catalog SKU and an alias for it.
    catalogSku("s1", "JX1-S-BLK", "JX1-BLK");
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX1-ALT', 's1', 'JX1-S-BLK')",
    ).run();
    warehouse("s1", 100);
    restock({ sku: "JX1-BLK-FBA", recommended: 50, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    const p = propose();
    expect(p.lines.filter((l) => l.sku === "JX1-BLK-FBA")).toHaveLength(1);
    expect(p.totals.skusConsidered).toBe(1);
    // And the warehouse figure must not be double-counted either.
    expect(p.lines[0].warehouseAvailable).toBe(100);
  });

  it("lets a real catalog SKU win over an alias claiming the same spelling", () => {
    catalogSku("s1", "JX1-BLK");
    catalogSku("s2", "JX2-BLK");
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX1-BLK', 's2', 'JX2-BLK')",
    ).run();
    warehouse("s1", 77);
    warehouse("s2", 11);
    restock({ sku: "JX1-BLK-FBA", recommended: 10, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    const l = propose().lines.find((x) => x.sku === "JX1-BLK-FBA")!;
    expect(l.warehouseAvailable).toBe(77);
  });

  it("sums warehouse rows for one SKU rather than emitting a line each", () => {
    catalogSku("s1", "JX1-BLK", "JX1-BLK");
    warehouse("s1", 40);
    restock({ sku: "JX1-BLK-FBA", recommended: 10, sold30d: 30 });
    sold("JX1-BLK-FBA", 30);

    const p = propose();
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].warehouseAvailable).toBe(40);
  });
});
