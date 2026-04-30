/**
 * Stock Sync Engine
 * Pulls inventory from Shopify DTC, Shopify Wholesale, and Faire,
 * updates inventory table, records movements, and generates low-stock alerts.
 */

import { sqlite } from "@/lib/db";

// ── Types ──

interface ShopifyProduct {
  id: number;
  variants: Array<{
    id: number;
    sku: string;
    inventory_item_id: number;
    inventory_quantity: number;
  }>;
}

interface ChannelStock {
  channel: "shopify_dtc" | "shopify_wholesale" | "faire";
  skuQuantities: Map<string, number>;
  productCount: number;
  variantCount: number;
}

interface SyncResult {
  success: boolean;
  channels: Array<{
    channel: string;
    products: number;
    variants: number;
    error?: string;
  }>;
  synced: number;
  skipped: number;
  changes: Array<{ sku: string; oldQty: number; newQty: number; channel: string }>;
  movementsRecorded: number;
  alerts: { lowStockCount: number; alertsCreated: number };
  syncedAt: string;
  error?: string;
}

// ── Shopify Fetcher ──
// Legacy fetchShopifyProducts(domain, token) was removed — the DB-backed
// `fetchProductsViaChannel` below now powers all channel fetches.

function shopifyProductsToStockMap(products: ShopifyProduct[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.sku) {
        map.set(variant.sku, (map.get(variant.sku) || 0) + variant.inventory_quantity);
      }
    }
  }
  return map;
}

// ── Channel Fetchers ──

async function fetchProductsViaChannel(channel: string): Promise<ShopifyProduct[]> {
  const { getShopifyClientByChannel } = await import("@/modules/integrations/lib/shopify/admin-api");
  const client = await getShopifyClientByChannel(channel);
  // Use REST product list via the DB-backed client (no more env vars).
  const all: ShopifyProduct[] = [];
  let path: string | null = `/products.json?limit=250&fields=id,variants`;
  while (path) {
    const data = (await client.rest("GET", path)) as { products: ShopifyProduct[] };
    all.push(...(data.products || []));
    // Pagination via Link header isn't exposed by the rest helper; for now
    // a single page (250 items) is enough since the catalog is ~115 SKUs.
    // TODO: add cursor-style pagination if catalog ever exceeds 250 products.
    path = null;
  }
  return all;
}

async function fetchShopifyDTC(): Promise<ChannelStock> {
  const products = await fetchProductsViaChannel("retail");
  const skuQuantities = shopifyProductsToStockMap(products);
  return {
    channel: "shopify_dtc",
    skuQuantities,
    productCount: products.length,
    variantCount: skuQuantities.size,
  };
}

async function fetchShopifyWholesale(): Promise<ChannelStock> {
  const products = await fetchProductsViaChannel("wholesale");
  const skuQuantities = shopifyProductsToStockMap(products);
  return {
    channel: "shopify_wholesale",
    skuQuantities,
    productCount: products.length,
    variantCount: skuQuantities.size,
  };
}

async function fetchFaire(): Promise<ChannelStock> {
  const apiKey = process.env.FAIRE_API_KEY;

  if (!apiKey) {
    throw new Error("FAIRE_API_KEY must be set");
  }

  // Faire API: GET /api/v1/products to get inventory
  // Faire's API is limited — they primarily manage orders, not real-time inventory.
  // We fetch products and use available_quantity from their product variants.
  const skuQuantities = new Map<string, number>();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(`https://www.faire.com/api/v1/products?page=${page}&page_size=50`, {
      headers: {
        "X-FAIRE-ACCESS-TOKEN": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Faire API ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const products = data.products || [];

    for (const product of products) {
      for (const option of product.options || []) {
        if (option.sku && option.available_quantity != null) {
          skuQuantities.set(option.sku, (skuQuantities.get(option.sku) || 0) + option.available_quantity);
        }
      }
    }

    hasMore = products.length === 50;
    page++;
  }

  return {
    channel: "faire",
    skuQuantities,
    productCount: 0, // Faire doesn't separate products/variants the same way
    variantCount: skuQuantities.size,
  };
}

// ── Movement Recording ──

function recordMovement(
  skuId: string,
  oldQty: number,
  newQty: number,
  reason: "purchase" | "sale" | "return" | "adjustment" | "transfer",
  referenceId?: string
) {
  const qty = newQty - oldQty;
  if (qty === 0) return;

  sqlite.prepare(
    `INSERT INTO inventory_movements (id, sku_id, from_location, to_location, quantity, reason, reference_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    crypto.randomUUID(),
    skuId,
    qty < 0 ? "warehouse" : null,
    qty > 0 ? "warehouse" : null,
    Math.abs(qty),
    reason,
    referenceId || null
  );
}

// ── Low Stock Alerts ──

function generateLowStockAlerts(): { lowStockCount: number; alertsCreated: number } {
  const lowStockItems = sqlite.prepare(`
    SELECT i.id, i.sku_id, i.quantity, i.reorder_point, s.sku, p.name as product_name, s.color_name
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    WHERE i.quantity < i.reorder_point AND i.location = 'warehouse'
  `).all() as Array<Record<string, any>>;

  let created = 0;
  for (const item of lowStockItems) {
    // Skip if there's already an active alert for this SKU
    const existing = sqlite.prepare(
      `SELECT id FROM notifications WHERE type = 'inventory' AND entity_id = ? AND dismissed = 0 AND read = 0`
    ).get(item.sku_id);
    if (existing) continue;

    let severity: string;
    let title: string;
    if (item.quantity === 0) {
      severity = "critical";
      title = `Out of stock: ${item.sku}`;
    } else if (item.quantity <= item.reorder_point * 0.25) {
      severity = "critical";
      title = `Critical low stock: ${item.sku}`;
    } else if (item.quantity <= item.reorder_point * 0.5) {
      severity = "high";
      title = `Low stock warning: ${item.sku}`;
    } else {
      severity = "medium";
      title = `Below reorder point: ${item.sku}`;
    }

    const message = `${item.product_name} — ${item.color_name || "Default"}: ${item.quantity} units remaining (reorder point: ${item.reorder_point})`;

    sqlite.prepare(
      `INSERT INTO notifications (id, type, title, message, severity, module, entity_id, entity_type, read, dismissed, created_at)
       VALUES (?, 'inventory', ?, ?, ?, 'inventory', ?, 'sku', 0, 0, datetime('now'))`
    ).run(crypto.randomUUID(), title, message, severity, item.sku_id);

    created++;
  }

  return { lowStockCount: lowStockItems.length, alertsCreated: created };
}

// ── Sync Status ──

export function getSyncStatus(): {
  lastSyncAt: string | null;
  lastSyncResult: string | null;
} {
  const row = sqlite.prepare(
    `SELECT value FROM settings WHERE key = 'inventory_last_sync'`
  ).get() as { value: string } | undefined;

  const resultRow = sqlite.prepare(
    `SELECT value FROM settings WHERE key = 'inventory_last_sync_result'`
  ).get() as { value: string } | undefined;

  return {
    lastSyncAt: row?.value || null,
    lastSyncResult: resultRow?.value || null,
  };
}

function saveSyncStatus(result: SyncResult) {
  const upsert = sqlite.prepare(
    `INSERT INTO settings (key, value, type, module, updated_at)
     VALUES (?, ?, 'string', 'inventory', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  upsert.run("inventory_last_sync", result.syncedAt);
  upsert.run("inventory_last_sync_result", JSON.stringify({
    synced: result.synced,
    changes: result.changes.length,
    alerts: result.alerts.alertsCreated,
    channels: result.channels.map((c) => c.channel),
  }));
}

// ── Main Sync ──

export async function runStockSync(): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    channels: [],
    synced: 0,
    skipped: 0,
    changes: [],
    movementsRecorded: 0,
    alerts: { lowStockCount: 0, alertsCreated: 0 },
    syncedAt: new Date().toISOString(),
  };

  // Aggregate stock across all channels
  const aggregatedStock = new Map<string, number>();

  // 1. Fetch from each channel (continue on individual failures)
  const channelFetchers: Array<{
    name: string;
    fetch: () => Promise<ChannelStock>;
    required: boolean;
  }> = [
    {
      name: "shopify_dtc",
      fetch: fetchShopifyDTC,
      required: true, // Must have at least DTC
    },
    {
      name: "shopify_wholesale",
      fetch: fetchShopifyWholesale,
      required: false,
    },
    {
      name: "faire",
      fetch: fetchFaire,
      required: false,
    },
  ];

  let hasAnyData = false;

  for (const fetcher of channelFetchers) {
    try {
      const channelData = await fetcher.fetch();
      result.channels.push({
        channel: fetcher.name,
        products: channelData.productCount,
        variants: channelData.variantCount,
      });

      // Merge into aggregated stock (sum across channels)
      for (const [sku, qty] of channelData.skuQuantities) {
        aggregatedStock.set(sku, (aggregatedStock.get(sku) || 0) + qty);
      }

      hasAnyData = true;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      result.channels.push({
        channel: fetcher.name,
        products: 0,
        variants: 0,
        error: errorMsg,
      });

      if (fetcher.required) {
        result.error = `Required channel ${fetcher.name} failed: ${errorMsg}`;
        saveSyncStatus(result);
        return result;
      }
      // Non-required channels: log and continue
      console.warn(`[stock-sync] Optional channel ${fetcher.name} failed: ${errorMsg}`);
    }
  }

  if (!hasAnyData) {
    result.error = "No channel data retrieved";
    saveSyncStatus(result);
    return result;
  }

  // 2. Update inventory table
  const ourSkus = sqlite.prepare(`
    SELECT i.id, i.sku_id, i.quantity, s.sku
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    WHERE i.location = 'warehouse'
  `).all() as Array<{ id: string; sku_id: string; quantity: number; sku: string }>;

  const updateStmt = sqlite.prepare(
    `UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updateReorderFlag = sqlite.prepare(
    `UPDATE inventory SET needs_reorder = (quantity < reorder_point), updated_at = datetime('now') WHERE id = ?`
  );

  const syncTransaction = sqlite.transaction(() => {
    for (const row of ourSkus) {
      const newQty = aggregatedStock.get(row.sku);
      if (newQty === undefined) {
        result.skipped++;
        continue;
      }

      if (newQty !== row.quantity) {
        result.changes.push({
          sku: row.sku,
          oldQty: row.quantity,
          newQty,
          channel: "aggregated",
        });

        // Record movement
        const reason = newQty > row.quantity ? "purchase" : "sale";
        recordMovement(row.sku_id, row.quantity, newQty, reason as any, `sync-${result.syncedAt}`);
        result.movementsRecorded++;

        updateStmt.run(newQty, row.id);
      }

      updateReorderFlag.run(row.id);
      result.synced++;
    }
  });

  syncTransaction();

  // 3. Generate alerts
  result.alerts = generateLowStockAlerts();

  // 4. Save sync status
  result.success = true;
  saveSyncStatus(result);

  return result;
}
