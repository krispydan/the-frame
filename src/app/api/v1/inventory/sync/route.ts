export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

// ── Shopify Inventory Sync ──
// Pulls inventory_levels from Shopify API, maps to our inventory table by SKU,
// and generates low-stock notifications.

interface ShopifyInventoryLevel {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
}

interface ShopifyProduct {
  id: number;
  variants: Array<{
    id: number;
    sku: string;
    inventory_item_id: number;
    inventory_quantity: number;
  }>;
}

async function fetchShopifyProducts(): Promise<ShopifyProduct[]> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!domain || !token) {
    throw new Error("SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN must be set");
  }

  const allProducts: ShopifyProduct[] = [];
  let url: string | null = `https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,variants`;

  while (url) {
    const res: Response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    allProducts.push(...(data.products || []));

    // Pagination via Link header
    const link: string | null = res.headers.get("link");
    const nextMatch: RegExpMatchArray | null | undefined = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch?.[1] ?? null;
  }

  return allProducts;
}

function generateLowStockAlerts() {
  // Find items where quantity < reorder_point
  const lowStockItems = sqlite.prepare(`
    SELECT i.id, i.sku_id, i.quantity, i.reorder_point, s.sku, p.name as product_name, s.color_name
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    WHERE i.quantity < i.reorder_point AND i.location = 'warehouse'
  `).all() as Array<Record<string, any>>;

  let created = 0;
  for (const item of lowStockItems) {
    // Don't create duplicate alerts — check for unread/undismissed notification for this SKU
    const existing = sqlite.prepare(
      `SELECT id FROM notifications WHERE type = 'inventory' AND entity_id = ? AND dismissed = 0 AND read = 0`
    ).get(item.sku_id);
    if (existing) continue;

    // Severity based on how low
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

export async function POST(request: NextRequest) {
  try {
    const products = await fetchShopifyProducts();

    // Build SKU → Shopify quantity map from variants
    const shopifyStock = new Map<string, number>();
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.sku) {
          // Sum quantities if same SKU appears multiple times (shouldn't, but defensive)
          shopifyStock.set(variant.sku, (shopifyStock.get(variant.sku) || 0) + variant.inventory_quantity);
        }
      }
    }

    // Map to our inventory table by SKU
    const ourSkus = sqlite.prepare(`
      SELECT i.id, i.sku_id, i.quantity, s.sku
      FROM inventory i
      JOIN catalog_skus s ON i.sku_id = s.id
      WHERE i.location = 'warehouse'
    `).all() as Array<{ id: string; sku_id: string; quantity: number; sku: string }>;

    let synced = 0;
    let skipped = 0;
    const changes: Array<{ sku: string; oldQty: number; newQty: number }> = [];

    const updateStmt = sqlite.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`
    );
    const updateReorderFlag = sqlite.prepare(
      `UPDATE inventory SET needs_reorder = (quantity < reorder_point), updated_at = datetime('now') WHERE id = ?`
    );

    for (const row of ourSkus) {
      const shopifyQty = shopifyStock.get(row.sku);
      if (shopifyQty === undefined) {
        skipped++;
        continue;
      }

      if (shopifyQty !== row.quantity) {
        changes.push({ sku: row.sku, oldQty: row.quantity, newQty: shopifyQty });
        updateStmt.run(shopifyQty, row.id);
      }
      updateReorderFlag.run(row.id);
      synced++;
    }

    // Generate low stock alerts after sync
    const alerts = generateLowStockAlerts();

    return NextResponse.json({
      success: true,
      shopifyProducts: products.length,
      shopifyVariants: shopifyStock.size,
      synced,
      skipped,
      changes,
      alerts,
      syncedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Inventory sync error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync inventory" },
      { status: 500 }
    );
  }
}
