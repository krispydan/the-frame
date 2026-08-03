export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/v1/inventory/shiphero/uom-csv
 *
 * ShipHero Units-of-Measure upload CSV: one row per pack SKU mapping it to its
 * component (individual) SKU. Matches the format of the original 12-pack file:
 *   UOM SKU,Component SKU,Component QTY,UoM type
 *   JX1011-S-AMB-4PK,JX1011-S-AMB,4,Inner Pack
 *
 * Factories now pack 4 pairs per zip bag (Aug 2026) — packSize defaults to 4.
 * SKU names come from the live catalog, so -S- renames flow through.
 *
 * Query params:
 *   packSize — default 4
 *   scope    — "all" (default: every catalog SKU) | "po" (only SKUs on a PO)
 *   poId     — required when scope=po
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const packSize = Math.max(1, parseInt(url.searchParams.get("packSize") || "4", 10) || 4);
  const scope = url.searchParams.get("scope") || "all";
  const poId = url.searchParams.get("poId");

  try {
    let skus: Array<{ sku: string }>;
    if (scope === "po") {
      if (!poId) return NextResponse.json({ error: "poId required when scope=po" }, { status: 400 });
      skus = db.all(sql`
        SELECT DISTINCT s.sku FROM inventory_po_line_items li
        JOIN catalog_skus s ON s.id = li.sku_id
        WHERE li.po_id = ${poId} AND s.sku IS NOT NULL
        ORDER BY s.sku
      `) as Array<{ sku: string }>;
    } else {
      skus = db.all(sql`
        SELECT sku FROM catalog_skus WHERE sku IS NOT NULL ORDER BY sku
      `) as Array<{ sku: string }>;
    }
    if (skus.length === 0) return NextResponse.json({ error: "No SKUs found" }, { status: 404 });

    const rows = skus
      .filter((s) => !/-\d+PK$/i.test(s.sku)) // never build a pack of a pack
      .map((s) => `${s.sku}-${packSize}PK,${s.sku},${packSize},Inner Pack`);
    const csv = ["UOM SKU,Component SKU,Component QTY,UoM type", ...rows].join("\n") + "\n";

    const name = scope === "po" ? `shiphero_uom_po_${poId}` : `shiphero_uom_${packSize}pk_all`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.csv"`,
      },
    });
  } catch (e) {
    console.error("[shiphero-uom-csv] failed:", e);
    return NextResponse.json({ error: "Failed to generate UOM CSV" }, { status: 500 });
  }
}
