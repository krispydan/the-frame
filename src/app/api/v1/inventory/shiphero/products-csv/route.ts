export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/v1/inventory/shiphero/products-csv
 *
 * ShipHero product-upload CSV for the pack SKUs (one product per {sku}-4PK),
 * matching the column set of the original 12-pack products file. Each UOM SKU
 * needs a product record in ShipHero before the UOM mapping can attach.
 *
 * Defaults mirror the 12-pack file (CN origin, tariff 9004.10.0000, Active 1,
 * zeros elsewhere), scaled for a 4-pack zip bag: weight 0.45 lb, 2×6×7 in.
 * Barcode left blank (no pack-level UPCs assigned yet — add in ShipHero later).
 *
 * Query params: packSize (default 4), scope=all|po, poId (when scope=po).
 */

const HEADER = [
  "Name", "SKU", "On Hand", "Thumbnail", "Reorder Level", "Reorder Amount", "Bin",
  "Overstock Bin", "Barcode", "Value", "Customs Value", "Customs Description", "Price",
  "No Air", "Weight", "Height", "Width", "Length", "Reserved", "Country Of Manufacture",
  "Tariff Code", "Do Not Cycle Count", "Ignore On Invoice", "Ignore On Customs",
  "Not Owned", "Product Note", "Virtual Product", "Custom Product", "Value Currency",
  "Final Sale", "Build Kit", "Dropship", "Tags", "Active",
];

const csvEscape = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const packSize = Math.max(1, parseInt(url.searchParams.get("packSize") || "4", 10) || 4);
  const scope = url.searchParams.get("scope") || "all";
  const poId = url.searchParams.get("poId");

  try {
    let skus: Array<{ sku: string; colorName: string | null; productName: string | null }>;
    if (scope === "po") {
      if (!poId) return NextResponse.json({ error: "poId required when scope=po" }, { status: 400 });
      skus = db.all(sql`
        SELECT DISTINCT s.sku, s.color_name AS colorName, p.name AS productName
        FROM inventory_po_line_items li
        JOIN catalog_skus s ON s.id = li.sku_id
        JOIN catalog_products p ON p.id = s.product_id
        WHERE li.po_id = ${poId} AND s.sku IS NOT NULL
        ORDER BY s.sku
      `) as typeof skus;
    } else {
      skus = db.all(sql`
        SELECT s.sku, s.color_name AS colorName, p.name AS productName
        FROM catalog_skus s
        JOIN catalog_products p ON p.id = s.product_id
        WHERE s.sku IS NOT NULL
        ORDER BY s.sku
      `) as typeof skus;
    }
    if (skus.length === 0) return NextResponse.json({ error: "No SKUs found" }, { status: 404 });

    // Scaled from the 12-pack file (1.25 lb, 3×6×9) to a 4-pack zip bag.
    const weight = packSize === 12 ? 1.25 : 0.45;
    const [h, w, l] = packSize === 12 ? [3, 6, 9] : [2, 6, 7];

    const rows = skus
      .filter((s) => !/-\d+PK$/i.test(s.sku))
      .map((s) => {
        const name = `${s.productName ?? s.sku}${s.colorName ? ` - ${s.colorName}` : ""} (${packSize}-pack)`;
        return [
          name, `${s.sku}-${packSize}PK`, 0, "", 0, 0, "", "",
          "", 0, 0, `Sunglasses (${packSize}-pack inner pack)`, 0,
          0, weight, h, w, l, 0, "CN",
          "9004.10.0000", 0, 0, 0,
          0, "", 0, 0, "USD",
          0, 0, 0, "", 1,
        ].map(csvEscape).join(",");
      });
    const csv = [HEADER.join(","), ...rows].join("\n") + "\n";

    const name = scope === "po" ? `shiphero_products_${packSize}pk_po_${poId}` : `shiphero_products_${packSize}pk_all`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.csv"`,
      },
    });
  } catch (e) {
    console.error("[shiphero-products-csv] failed:", e);
    return NextResponse.json({ error: "Failed to generate products CSV" }, { status: 500 });
  }
}
