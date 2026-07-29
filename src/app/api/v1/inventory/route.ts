export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inventory } from "@/modules/inventory/schema";
import { skus, products } from "@/modules/catalog/schema";
import { eq, sql, and, lte, gt } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const factoryFilter = params.get("factory");
  const stockFilter = params.get("stock"); // all, low, out, overstocked
  const search = params.get("search") || "";
  const sortBy = params.get("sortBy") || "days_of_stock";
  const sortDir = params.get("sortDir") || "asc";

  try {
    // Raw query for joined data
    const rows = db.all(sql`
      SELECT
        i.id,
        i.sku_id,
        i.quantity,
        i.reserved_quantity,
        i.reorder_point,
        i.sell_through_weekly,
        i.days_of_stock,
        i.needs_reorder,
        i.reorder_date,
        s.sku,
        s.color_name,
        s.cost_price,
        s.wholesale_price,
        s.retail_price,
        p.name as product_name,
        p.sku_prefix,
        p.factory_name,
        p.category,
        -- Units on POs that haven't been received yet, at the same exact-SKU
        -- grain as this row. Received/complete POs are already counted in
        -- i.quantity, so including them would double-count. quantity is
        -- multiplied by pack_size because a line may be entered in packs.
        COALESCE(oo.on_order, 0) as on_order,
        COALESCE(oo.po_count, 0) as open_po_count,
        oo.next_arrival
      FROM inventory i
      JOIN catalog_skus s ON i.sku_id = s.id
      JOIN catalog_products p ON s.product_id = p.id
      LEFT JOIN (
        SELECT li.sku_id,
               SUM(li.quantity * MAX(COALESCE(li.pack_size, 1), 1)) as on_order,
               COUNT(DISTINCT li.po_id) as po_count,
               MIN(po.expected_arrival_date) as next_arrival
          FROM inventory_po_line_items li
          JOIN inventory_purchase_orders po ON po.id = li.po_id
         WHERE po.status IN ('draft','submitted','confirmed','in_production','shipped','in_transit')
         GROUP BY li.sku_id
      ) oo ON oo.sku_id = i.sku_id
      ORDER BY
        CASE WHEN i.days_of_stock = 9999 THEN 999999 ELSE i.days_of_stock END ASC
    `) as Array<Record<string, unknown>>;

    let filtered = rows;

    // Factory filter
    if (factoryFilter && factoryFilter !== "all") {
      filtered = filtered.filter((r) => {
        const sku = r.sku as string;
        return sku.startsWith(factoryFilter);
      });
    }

    // Stock filter
    if (stockFilter && stockFilter !== "all") {
      filtered = filtered.filter((r) => {
        const qty = r.quantity as number;
        const reorder = r.reorder_point as number;
        if (stockFilter === "out") return qty === 0;
        if (stockFilter === "low") return qty > 0 && qty <= reorder;
        if (stockFilter === "overstocked") return (r.days_of_stock as number) > 180;
        return true;
      });
    }

    // Search
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter((r) =>
        (r.sku as string).toLowerCase().includes(s) ||
        (r.product_name as string || "").toLowerCase().includes(s) ||
        (r.color_name as string || "").toLowerCase().includes(s)
      );
    }

    // Sort
    if (sortBy === "days_of_stock") {
      filtered.sort((a, b) => {
        const aVal = a.days_of_stock as number;
        const bVal = b.days_of_stock as number;
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      });
    } else if (sortBy === "sell_through") {
      filtered.sort((a, b) => {
        const aVal = a.sell_through_weekly as number;
        const bVal = b.sell_through_weekly as number;
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      });
    } else if (sortBy === "quantity") {
      filtered.sort((a, b) => {
        const aVal = a.quantity as number;
        const bVal = b.quantity as number;
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      });
    }

    // Summary stats
    const totalSkus = rows.length;
    const inStock = rows.filter((r) => (r.quantity as number) > 0).length;
    const lowStock = rows.filter((r) => {
      const qty = r.quantity as number;
      const reorder = r.reorder_point as number;
      return qty > 0 && qty <= reorder;
    }).length;
    const outOfStock = rows.filter((r) => (r.quantity as number) === 0).length;
    const needsReorder = rows.filter((r) => r.needs_reorder).length;

    return NextResponse.json({
      items: filtered,
      summary: { totalSkus, inStock, lowStock, outOfStock, needsReorder },
    });
  } catch (error) {
    console.error("Inventory API error:", error);
    return NextResponse.json({ error: "Failed to fetch inventory" }, { status: 500 });
  }
}
