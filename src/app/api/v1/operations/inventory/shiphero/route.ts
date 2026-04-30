export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/operations/inventory/shiphero
 *
 * Read cached inventory levels from shiphero_inventory table.
 * Optional query param: ?skus=JX1001-BLK,JX1002-WHT (comma-separated filter)
 */
export const GET = apiHandler(
  async (request: NextRequest) => {
    const skusParam = request.nextUrl.searchParams.get("skus");

    let inventory;
    if (skusParam) {
      const skuList = skusParam.split(",").map((s) => s.trim()).filter(Boolean);
      const placeholders = skuList.map(() => "?").join(",");
      inventory = sqlite.prepare(
        `SELECT sku, warehouse_id, on_hand, allocated, available, synced_at
         FROM shiphero_inventory WHERE sku IN (${placeholders})
         ORDER BY sku`
      ).all(...skuList);
    } else {
      inventory = sqlite.prepare(
        `SELECT sku, warehouse_id, on_hand, allocated, available, synced_at
         FROM shiphero_inventory ORDER BY sku`
      ).all();
    }

    const lastSync = sqlite.prepare(
      "SELECT MAX(synced_at) as last_synced_at FROM shiphero_inventory"
    ).get() as { last_synced_at: string | null } | undefined;

    return NextResponse.json({
      count: inventory.length,
      last_synced_at: lastSync?.last_synced_at ?? null,
      inventory,
    });
  },
  { auth: true, roles: ["owner", "warehouse", "finance"] },
);
