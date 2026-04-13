/**
 * POST /api/v1/inventory/bulk-update
 *
 * Bulk upsert inventory quantities by SKU string.
 * Body: { items: [{ sku: "JX1001-BLK", quantity: 53 }, ...] }
 *
 * For each item:
 *   1. Look up the SKU ID from catalog_skus
 *   2. Upsert into inventory table (warehouse location)
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

interface BulkItem {
  sku: string;
  quantity: number;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const items: BulkItem[] = body.items;

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array required" }, { status: 400 });
  }

  const results = { updated: 0, created: 0, failed: 0, errors: [] as string[] };

  const findSku = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ?");
  const findInventory = sqlite.prepare("SELECT id FROM inventory WHERE sku_id = ? AND location = 'warehouse'");
  const updateStmt = sqlite.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?");
  const insertStmt = sqlite.prepare(`
    INSERT INTO inventory (id, sku_id, location, quantity, reserved_quantity, created_at, updated_at)
    VALUES (?, ?, 'warehouse', ?, 0, datetime('now'), datetime('now'))
  `);

  for (const item of items) {
    const skuRow = findSku.get(item.sku) as { id: string } | undefined;
    if (!skuRow) {
      results.failed++;
      results.errors.push(`SKU not found: ${item.sku}`);
      continue;
    }

    try {
      const existing = findInventory.get(skuRow.id) as { id: string } | undefined;
      if (existing) {
        updateStmt.run(item.quantity, existing.id);
        results.updated++;
      } else {
        insertStmt.run(crypto.randomUUID(), skuRow.id, item.quantity);
        results.created++;
      }
    } catch (err: unknown) {
      results.failed++;
      results.errors.push(`${item.sku}: ${(err as Error).message}`);
    }
  }

  return NextResponse.json(results);
}
