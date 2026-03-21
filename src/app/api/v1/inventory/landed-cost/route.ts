export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { calculateLandedCost, DEFAULT_COST_SETTINGS } from "@/modules/inventory/lib/landed-cost";

export async function GET(request: NextRequest) {
  const skuId = request.nextUrl.searchParams.get("skuId");

  try {
    if (skuId) {
      // Single SKU
      const row = db.get(sql`
        SELECT s.cost_price, s.wholesale_price, s.retail_price, s.sku
        FROM catalog_skus s
        WHERE s.id = ${skuId}
      `) as { cost_price: number; wholesale_price: number; retail_price: number; sku: string } | undefined;

      if (!row) return NextResponse.json({ error: "SKU not found" }, { status: 404 });

      const result = calculateLandedCost(
        row.cost_price || 7,
        row.wholesale_price || 14,
        row.retail_price || 30,
        1000, 0, 0, 0
      );
      return NextResponse.json({ sku: row.sku, ...result });
    }

    // All SKUs
    const rows = db.all(sql`
      SELECT s.id, s.sku, s.cost_price, s.wholesale_price, s.retail_price, p.name as product_name
      FROM catalog_skus s
      JOIN catalog_products p ON s.product_id = p.id
    `) as Array<Record<string, unknown>>;

    const items = rows.map((row) => {
      const result = calculateLandedCost(
        (row.cost_price as number) || 7,
        (row.wholesale_price as number) || 14,
        (row.retail_price as number) || 30,
        1000, 0, 0, 0
      );
      return { skuId: row.id, sku: row.sku, productName: row.product_name, ...result };
    });

    return NextResponse.json({
      items,
      settings: DEFAULT_COST_SETTINGS,
      avgLandedCost: Math.round(items.reduce((s, i) => s + i.landedCost, 0) / items.length * 100) / 100,
      avgWholesaleMargin: Math.round(items.reduce((s, i) => s + i.wholesaleMarginPct, 0) / items.length * 100) / 100,
    });
  } catch (error) {
    console.error("Landed cost error:", error);
    return NextResponse.json({ error: "Failed to calculate landed cost" }, { status: 500 });
  }
}
