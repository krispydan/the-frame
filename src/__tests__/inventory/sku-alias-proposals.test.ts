/**
 * SKU alias proposal tests.
 *
 * These proposals get written into catalog_sku_aliases, and from there they
 * decide which catalog SKU a warehouse's stock — and eventually its COGS —
 * is attributed to. A wrong alias is worse than a missing one: a missing
 * alias shows as zero stock and gets noticed, a wrong one looks right and
 * quietly costs the wrong product.
 *
 * So the ambiguity guard carries most of the weight here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  proposeSkuAliases,
  applySkuAliases,
  feedSpellings,
} from "@/modules/inventory/lib/sku-alias-proposals";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function sku(id: string, code: string) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES (?, ?, datetime('now'))",
  ).run("p-1", "Product");
  sqlite.prepare(
    "INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p-1', ?)",
  ).run(id, code);
}

function shiphero(code: string, onHand: number, warehouse = "wh-1") {
  sqlite.prepare(`
    INSERT INTO shiphero_inventory (sku, warehouse_id, on_hand, allocated, available, synced_at)
    VALUES (?, ?, ?, 0, ?, '2026-08-04T12:00:00Z')
  `).run(code, warehouse, onHand, onHand);
}

function fba(code: string, internal: string | null, qty: number) {
  sqlite.prepare(`
    INSERT INTO amazon_fba_inventory (id, sku, internal_sku, snapshot_date, total_qty)
    VALUES (?, ?, ?, '2026-08-04', ?)
  `).run(crypto.randomUUID(), code, internal, qty);
}

describe("feedSpellings", () => {
  it("drops each interior segment", () => {
    expect(feedSpellings("JX3004-S-BLK").sort()).toEqual(["JX3004-BLK", "JX3004-S-BLK"]);
  });

  it("never drops the style code or the colour", () => {
    // Those are the two parts no feed omits; dropping them would invent
    // matches against unrelated products.
    const out = feedSpellings("JX3004-S-BLK");
    expect(out).not.toContain("S-BLK");
    expect(out).not.toContain("JX3004-S");
  });

  it("leaves a two-segment SKU alone", () => {
    expect(feedSpellings("JX3004-BLK")).toEqual(["JX3004-BLK"]);
  });

  it("offers each drop for a four-segment SKU", () => {
    expect(feedSpellings("JX-3004-S-BLK").sort()).toEqual(
      ["JX-3004-BLK", "JX-3004-S-BLK", "JX-S-BLK"].sort(),
    );
  });
});

describe("proposals", () => {
  it("proposes the size-dropped spelling the warehouse uses", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-BLK", 600);

    const r = proposeSkuAliases();
    expect(r.proposed).toEqual([
      { alias: "JX3004-BLK", source: "shiphero", units: 600, skuId: "s1", canonicalSku: "JX3004-S-BLK" },
    ]);
    expect(r.totals.proposedUnits).toBe(600);
  });

  it("refuses to guess when two catalog SKUs claim the same spelling", () => {
    // If the catalog carried both a small and a medium, the warehouse's
    // JX3004-BLK could mean either. Attributing it is a coin flip.
    sku("s1", "JX3004-S-BLK");
    sku("s2", "JX3004-M-BLK");
    shiphero("JX3004-BLK", 600);

    const r = proposeSkuAliases();
    expect(r.proposed).toEqual([]);
    expect(r.ambiguous).toEqual([
      { alias: "JX3004-BLK", source: "shiphero", units: 600, candidates: ["JX3004-M-BLK", "JX3004-S-BLK"] },
    ]);
  });

  it("reports a feed SKU no catalog SKU explains", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX-GHOST", 12);
    expect(proposeSkuAliases().unmatched).toEqual([
      { alias: "JX-GHOST", source: "shiphero", units: 12 },
    ]);
  });

  it("skips SKUs that already match exactly", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-S-BLK", 600);
    const r = proposeSkuAliases();
    expect(r.proposed).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it("skips SKUs an alias already covers", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-BLK", 600);
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX3004-BLK', 's1', 'JX3004-S-BLK')",
    ).run();
    expect(proposeSkuAliases().proposed).toEqual([]);
  });

  it("sums a SKU across warehouses", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-BLK", 400, "wh-1");
    shiphero("JX3004-BLK", 200, "wh-2");
    expect(proposeSkuAliases().proposed[0].units).toBe(600);
  });

  it("proposes the FBA internal spelling, not the -FBA one", () => {
    // resolveCatalogSku strips -FBA before looking up, so storing the raw
    // spelling would create an alias nothing ever queries.
    sku("s1", "JX1004-S-BLK");
    fba("JX1004-BLK-FBA", "JX1004-BLK", 58);
    expect(proposeSkuAliases().proposed[0]).toMatchObject({
      alias: "JX1004-BLK", source: "fba", units: 58,
    });
  });

  it("falls back to stripping -FBA when internal_sku is missing", () => {
    sku("s1", "JX1004-S-BLK");
    fba("JX1004-BLK-FBA", null, 58);
    expect(proposeSkuAliases().proposed[0].alias).toBe("JX1004-BLK");
  });

  it("proposes a spelling once when both feeds report it", () => {
    sku("s1", "JX1004-S-BLK");
    shiphero("JX1004-BLK", 100);
    fba("JX1004-BLK-FBA", "JX1004-BLK", 58);
    expect(proposeSkuAliases().proposed).toHaveLength(1);
  });

  it("sorts by units so the biggest exposure reads first", () => {
    sku("s1", "JX1-S-BLK"); sku("s2", "JX2-S-BLK");
    shiphero("JX1-BLK", 10);
    shiphero("JX2-BLK", 900);
    expect(proposeSkuAliases().proposed.map((p) => p.alias)).toEqual(["JX2-BLK", "JX1-BLK"]);
  });
});

describe("apply", () => {
  it("writes nothing on a dry run", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-BLK", 600);
    const r = applySkuAliases({ dryRun: true });
    expect(r.written).toBe(0);
    expect(r.aliases).toEqual([{ alias: "JX3004-BLK", canonicalSku: "JX3004-S-BLK", units: 600 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_sku_aliases").get()).toEqual({ n: 0 });
  });

  it("writes the unambiguous proposals and leaves the rest", () => {
    sku("s1", "JX3004-S-BLK");
    sku("s2", "JX4000-S-BLK");
    sku("s3", "JX4000-M-BLK");
    shiphero("JX3004-BLK", 600);
    shiphero("JX4000-BLK", 300); // ambiguous
    shiphero("JX-GHOST", 5);     // unmatched

    const r = applySkuAliases();
    expect(r.written).toBe(1);
    expect(r.skipped).toEqual({ ambiguous: 1, unmatched: 1 });

    const rows = sqlite.prepare("SELECT alias, sku_id FROM catalog_sku_aliases").all();
    expect(rows).toEqual([{ alias: "JX3004-BLK", sku_id: "s1" }]);
  });

  it("is safe to run twice", () => {
    sku("s1", "JX3004-S-BLK");
    shiphero("JX3004-BLK", 600);
    applySkuAliases();
    const second = applySkuAliases();
    expect(second.written).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_sku_aliases").get()).toEqual({ n: 1 });
  });
});
