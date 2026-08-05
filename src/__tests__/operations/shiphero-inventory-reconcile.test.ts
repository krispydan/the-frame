/**
 * ShipHero inventory reconcile guard.
 *
 * The reconcile exists so a SKU that sold out drops to zero instead of
 * keeping a stale quantity forever. Its danger is the mirror image: if a pull
 * comes back truncated, every SKU the response omitted looks sold out, and
 * the reconcile zeroes real stock while reporting success.
 *
 * That is not hypothetical. After the 2026-08-04 pagination incident a short
 * pull cleared the old absolute floor of 50 rows, and warehouse stock went
 * from ~20,300 units to 78. Nothing errored. Every reader of `inventory` —
 * stock levels, days-of-stock, reorder points, sell-through, and the
 * FIFO-vs-physical reconciliation — worked from near-zero until someone
 * noticed.
 *
 * So these tests are about the guard, not the happy path: a shrunken pull
 * must leave quantities alone, and it must say so rather than pass silently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

const levels = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/modules/operations/lib/shiphero/api-client", () => ({
  isConfigured: () => true,
  getInventoryLevels: async () => levels.rows,
}));

import { syncShipHeroInventory } from "@/modules/operations/lib/shiphero/sync-inventory";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
  levels.rows = [];
});

/** N catalog SKUs named SKU-0..N-1, each with a matching ShipHero row. */
function seedCatalog(n: number) {
  sqlite.prepare(
    "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
  ).run();
  for (let i = 0; i < n; i++) {
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p-1', ?)",
    ).run(`s-${i}`, `SKU-${i}`);
  }
}

function pull(n: number, onHand = 100) {
  levels.rows = Array.from({ length: n }, (_, i) => ({
    sku: `SKU-${i}`, warehouse_id: "wh-1", on_hand: onHand, allocated: 0, available: onHand,
  }));
}

const warehouseTotal = () =>
  (sqlite.prepare(
    "SELECT IFNULL(SUM(quantity), 0) AS n FROM inventory WHERE location = 'warehouse'",
  ).get() as { n: number }).n;

describe("a full pull", () => {
  it("lands every SKU and reconciles the ones that vanished", async () => {
    seedCatalog(100);
    pull(100);
    await syncShipHeroInventory();
    expect(warehouseTotal()).toBe(10_000);

    // SKU-99 genuinely sold out and drops out of the feed.
    pull(99);
    const r = await syncShipHeroInventory();
    expect(r.truncatedPull).toBe(false);
    expect(r.zeroed).toBe(1);
    expect(warehouseTotal()).toBe(9_900);
  });
});

describe("a truncated pull", () => {
  it("does not zero stock the response merely omitted", async () => {
    seedCatalog(100);
    pull(100);
    await syncShipHeroInventory();
    expect(warehouseTotal()).toBe(10_000);

    // 60 rows clears the old absolute floor of 50 — this is the exact shape
    // that emptied the table in production.
    pull(60);
    const r = await syncShipHeroInventory();

    expect(r.truncatedPull).toBe(true);
    expect(r.zeroed).toBe(0);
    // The 60 SKUs present are updated; the 40 omitted keep last-known-good.
    expect(warehouseTotal()).toBe(10_000);
  });

  it("reports the shortfall instead of passing silently", async () => {
    seedCatalog(100);
    pull(100);
    await syncShipHeroInventory();

    pull(60);
    const r = await syncShipHeroInventory();
    expect(r.success).toBe(true);
    expect(r.distinctSkus).toBe(60);
    expect(r.expectedSkus).toBe(80); // 80% of the last known 100
  });

  it("still updates the quantities it did receive", async () => {
    seedCatalog(100);
    pull(100, 100);
    await syncShipHeroInventory();

    pull(60, 5);
    await syncShipHeroInventory();
    // 60 SKUs at 5 + 40 SKUs left at 100.
    expect(warehouseTotal()).toBe(60 * 5 + 40 * 100);
  });

  it("accepts a pull just inside the shrink tolerance", async () => {
    seedCatalog(100);
    pull(100);
    await syncShipHeroInventory();

    pull(80);
    const r = await syncShipHeroInventory();
    expect(r.truncatedPull).toBe(false);
    expect(r.zeroed).toBe(20);
  });
});

describe("the first run", () => {
  it("reconciles on a healthy pull with no history to compare against", async () => {
    seedCatalog(100);
    pull(100);
    const r = await syncShipHeroInventory();
    expect(r.truncatedPull).toBe(false);
    expect(warehouseTotal()).toBe(10_000);
  });

  it("still refuses to reconcile a tiny first pull", async () => {
    // No history means no relative floor, so the absolute backstop has to
    // hold — otherwise a 3-row first pull would zero a seeded catalog.
    seedCatalog(100);
    sqlite.prepare(
      "INSERT INTO inventory (id, sku_id, location, quantity) VALUES ('i-1', 's-0', 'warehouse', 500)",
    ).run();
    pull(3);
    const r = await syncShipHeroInventory();
    expect(r.truncatedPull).toBe(true);
    expect(r.zeroed).toBe(0);
  });
});

describe("alias resolution", () => {
  it("maps a ShipHero spelling the catalog does not carry", async () => {
    sqlite.prepare(
      "INSERT INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s-1', 'p-1', 'JX3004-S-BLK')",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX3004-BLK', 's-1', 'JX3004-S-BLK')",
    ).run();

    levels.rows = [
      { sku: "JX3004-BLK", warehouse_id: "wh-1", on_hand: 600, allocated: 0, available: 600 },
    ];
    await syncShipHeroInventory();
    expect(warehouseTotal()).toBe(600);
  });

  it("sums two spellings that resolve to one catalog SKU", async () => {
    // The upsert SETs quantity rather than adding, so writing per-spelling
    // would have the second row silently replace the first.
    sqlite.prepare(
      "INSERT INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s-1', 'p-1', 'JX3004-S-BLK')",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX3004-BLK', 's-1', 'JX3004-S-BLK')",
    ).run();

    levels.rows = [
      { sku: "JX3004-BLK", warehouse_id: "wh-1", on_hand: 600, allocated: 0, available: 600 },
      { sku: "JX3004-S-BLK", warehouse_id: "wh-1", on_hand: 40, allocated: 0, available: 40 },
    ];
    await syncShipHeroInventory();
    expect(warehouseTotal()).toBe(640);
  });

  it("never lets an alias shadow a real catalog SKU", async () => {
    sqlite.prepare(
      "INSERT INTO catalog_products (id, name, created_at) VALUES ('p-1', 'P', datetime('now'))",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s-1', 'p-1', 'JX1-BLK')",
    ).run();
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s-2', 'p-1', 'JX2-BLK')",
    ).run();
    // A stale alias claiming a spelling that is also a real SKU.
    sqlite.prepare(
      "INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku) VALUES ('JX1-BLK', 's-2', 'JX2-BLK')",
    ).run();

    levels.rows = [
      { sku: "JX1-BLK", warehouse_id: "wh-1", on_hand: 10, allocated: 0, available: 10 },
    ];
    await syncShipHeroInventory();
    const row = sqlite.prepare(
      "SELECT sku_id, quantity FROM inventory WHERE location='warehouse' AND quantity > 0",
    ).get() as { sku_id: string; quantity: number };
    expect(row).toEqual({ sku_id: "s-1", quantity: 10 });
  });
});
