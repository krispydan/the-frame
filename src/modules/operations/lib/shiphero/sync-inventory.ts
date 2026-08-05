/**
 * ShipHero inventory sync — pulls all stock levels and upserts into shiphero_inventory table.
 */

import { sqlite } from "@/lib/db";
import { getInventoryLevels, isConfigured } from "./api-client";

export interface SyncResult {
  success: boolean;
  skuCount: number;
  syncedAt: string;
  error?: string;
}

/**
 * Returns true if we're within PST business hours (9 AM – 6 PM, Mon–Fri).
 */
export function isDuringBusinessHours(): boolean {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = pst.getDay(); // 0=Sun, 6=Sat
  const hour = pst.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

/**
 * Pull all inventory from ShipHero and upsert into shiphero_inventory.
 */
export async function syncShipHeroInventory(): Promise<SyncResult> {
  if (!isConfigured()) {
    return { success: false, skuCount: 0, syncedAt: new Date().toISOString(), error: "SHIPHERO_ACCESS_TOKEN not set" };
  }

  const syncedAt = new Date().toISOString();

  try {
    const inventory = await getInventoryLevels();

    const upsert = sqlite.prepare(`
      INSERT INTO shiphero_inventory (sku, warehouse_id, on_hand, allocated, available, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku, warehouse_id) DO UPDATE SET
        on_hand = excluded.on_hand,
        allocated = excluded.allocated,
        available = excluded.available,
        synced_at = excluded.synced_at
    `);

    // Also update the main inventory table used by the dashboard.
    // Match ShipHero SKUs to catalog_skus.sku → inventory.sku_id.
    // Aggregate across warehouses (sum on_hand/allocated per SKU) since
    // the inventory table has one row per SKU, not per warehouse.
    const skuTotals = new Map<string, { onHand: number; allocated: number }>();
    for (const item of inventory) {
      const existing = skuTotals.get(item.sku) ?? { onHand: 0, allocated: 0 };
      existing.onHand += item.on_hand;
      existing.allocated += item.allocated;
      skuTotals.set(item.sku, existing);
    }

    // Lookup catalog_skus.id by sku for the inventory table join.
    //
    // Exact match alone is not enough: the catalog spells a SKU JX3004-S-BLK
    // while ShipHero reports JX3004-BLK. Matching only exactly silently
    // dropped 20k of 20.3k units on the floor — stock that plainly existed
    // read as zero across inventory levels, days-of-stock, reorder points and
    // the FIFO-vs-physical reconciliation, with no error anywhere.
    //
    // catalog_sku_aliases is the same table the Amazon order importer already
    // resolves through (see resolveCatalogSku), so a spelling fixed for one
    // channel now fixes it for the warehouse too. Exact matches still win:
    // an alias can never shadow a real catalog SKU.
    const skuIdLookup = sqlite.prepare(
      "SELECT id, sku FROM catalog_skus WHERE sku IS NOT NULL"
    ).all() as Array<{ id: string; sku: string }>;
    const skuToId = new Map<string, string>();
    try {
      const aliases = sqlite.prepare(
        "SELECT alias, sku_id FROM catalog_sku_aliases"
      ).all() as Array<{ alias: string; sku_id: string }>;
      for (const a of aliases) skuToId.set(a.alias, a.sku_id);
    } catch {
      // Alias table is optional in some environments (e.g. minimal test DBs).
    }
    for (const r of skuIdLookup) skuToId.set(r.sku, r.id);

    const upsertMainInventory = sqlite.prepare(`
      INSERT INTO inventory (id, sku_id, location, quantity, reserved_quantity, updated_at)
      VALUES (lower(hex(randomblob(16))), ?, 'warehouse', ?, ?, ?)
      ON CONFLICT(sku_id, location) DO UPDATE SET
        quantity = excluded.quantity,
        reserved_quantity = excluded.reserved_quantity,
        updated_at = excluded.updated_at
    `);

    // getInventoryLevels() is a FULL paginated pull of every ShipHero
    // warehouse product (including on_hand: 0). So any catalog SKU that is
    // NOT in this response genuinely has zero warehouse stock. Previously we
    // only upserted the SKUs we saw and left everything else at its last
    // value — meaning a SKU that sold out (or whose ShipHero record was
    // removed / never matched) kept a stale non-zero quantity forever
    // (e.g. Phoenix · Black stuck at 495). We now reconcile: zero out any
    // warehouse row whose SKU wasn't seen in this pull.
    //
    // SAFETY GUARD: only reconcile when the pull looks complete. A glitchy
    // partial pull (API hiccup returning a handful of rows) must never zero
    // the whole catalog. Jaxy's warehouse has well over this floor of SKUs.
    const MIN_SYNC_ROWS_FOR_RECONCILE = 50;
    const pullLooksComplete = inventory.length >= MIN_SYNC_ROWS_FOR_RECONCILE;

    // Collect the catalog sku_ids ShipHero actually returned this run.
    const seenSkuIds = new Set<string>();
    for (const sku of skuTotals.keys()) {
      if (sku.includes("-12PK")) continue;
      const skuId = skuToId.get(sku);
      if (skuId) seenSkuIds.add(skuId);
    }

    let zeroedCount = 0;
    const batch = sqlite.transaction(() => {
      for (const item of inventory) {
        upsert.run(item.sku, item.warehouse_id, item.on_hand, item.allocated, item.available, syncedAt);
      }

      // Write aggregated totals to main inventory table.
      //
      // Aggregate by RESOLVED sku_id, not by ShipHero spelling. Now that
      // aliases resolve, two spellings (JX3004-BLK and JX3004-S-BLK) can land
      // on one catalog SKU — and the upsert below SETs quantity rather than
      // adding, so writing per-spelling would have the second row silently
      // overwrite the first instead of summing.
      const idTotals = new Map<string, { onHand: number; allocated: number }>();
      for (const [sku, totals] of skuTotals) {
        // Skip inner pack SKUs (12PK) — only sync each/unit SKUs
        if (sku.includes("-12PK")) continue;
        const skuId = skuToId.get(sku);
        if (!skuId) continue;
        const acc = idTotals.get(skuId) ?? { onHand: 0, allocated: 0 };
        acc.onHand += totals.onHand;
        acc.allocated += totals.allocated;
        idTotals.set(skuId, acc);
      }
      for (const [skuId, totals] of idTotals) {
        upsertMainInventory.run(skuId, totals.onHand, totals.allocated, syncedAt);
      }

      // Reconcile: zero warehouse rows for SKUs ShipHero didn't return.
      if (pullLooksComplete) {
        const staleRows = sqlite.prepare(
          "SELECT sku_id, quantity FROM inventory WHERE location = 'warehouse' AND quantity > 0",
        ).all() as Array<{ sku_id: string; quantity: number }>;
        const zeroStmt = sqlite.prepare(
          "UPDATE inventory SET quantity = 0, reserved_quantity = 0, updated_at = ? WHERE sku_id = ? AND location = 'warehouse'",
        );
        for (const row of staleRows) {
          if (!seenSkuIds.has(row.sku_id)) {
            zeroStmt.run(syncedAt, row.sku_id);
            zeroedCount++;
          }
        }
      }
    });

    batch();

    if (!pullLooksComplete) {
      console.warn(
        `[shiphero-inventory-sync] Pull returned only ${inventory.length} rows (< ${MIN_SYNC_ROWS_FOR_RECONCILE}); skipped stale-SKU reconciliation to avoid zeroing real stock.`,
      );
    } else if (zeroedCount > 0) {
      console.log(`[shiphero-inventory-sync] Reconciled ${zeroedCount} SKU(s) to 0 (not present in ShipHero full pull).`);
    }

    return { success: true, skuCount: inventory.length, syncedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, skuCount: 0, syncedAt, error: message };
  }
}
