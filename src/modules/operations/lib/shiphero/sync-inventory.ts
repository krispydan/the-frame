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

    const batch = sqlite.transaction(() => {
      for (const item of inventory) {
        upsert.run(item.sku, item.warehouse_id, item.on_hand, item.allocated, item.available, syncedAt);
      }
    });

    batch();

    return { success: true, skuCount: inventory.length, syncedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, skuCount: 0, syncedAt, error: message };
  }
}
