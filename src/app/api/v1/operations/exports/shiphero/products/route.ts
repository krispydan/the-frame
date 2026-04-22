export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { operationsExports } from "@/modules/catalog/schema";
import { loadWarehouseSkus } from "@/modules/operations/lib/load-skus";
import { buildProductBulkEditCsv } from "@/modules/operations/lib/shiphero/product-bulk-edit";
import { todayCompact } from "@/modules/operations/lib/shiphero/csv-utils";

/**
 * GET /api/v1/operations/exports/shiphero/products
 *
 * Query params:
 *   ?factory=JX1|JX2|JX3|JX4|all    (default: all)
 *   ?scope=new|all                   (default: new — only unsynced Inner Packs)
 *   ?preview=true                    (return JSON preview instead of CSV)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const factoryParam = searchParams.get("factory") || "all";
  const scope = searchParams.get("scope") || "new";
  const preview = searchParams.get("preview") === "true";

  const factoryCode = factoryParam === "all" ? undefined : factoryParam;
  const warehouseSkus = await loadWarehouseSkus({
    factoryCode,
    newOnly: scope === "new",
  });

  const inputs = warehouseSkus.map((s) => ({
    eachSku: s.sku,
    productName: s.productName,
    colorName: s.colorName ?? "",
    innerPackSku: s.twelvePackSku,
    innerPackUpc: s.twelvePackUpc,
  }));

  const { csvs, warnings } = buildProductBulkEditCsv(inputs);

  if (preview) {
    return NextResponse.json({
      rowCount: warnings.emitted,
      files: csvs.length,
      warnings,
      sample: warehouseSkus.slice(0, 10).map((s) => ({
        eachSku: s.sku,
        innerPackSku: s.twelvePackSku,
        innerPackUpc: s.twelvePackUpc,
        productName: s.productName,
        colorName: s.colorName,
      })),
    });
  }

  const scopeLabel = factoryParam === "all" ? scope : `${factoryParam}-${scope}`;
  const filename = `shiphero_products_${scopeLabel}_${todayCompact()}.csv`;

  // Audit log
  try {
    await db.insert(operationsExports).values({
      exportType: "shiphero_products",
      filename,
      rowCount: warnings.emitted,
      filters: JSON.stringify({ factory: factoryParam, scope }),
      createdBy: "admin",
    });
  } catch (e) {
    console.error("[shiphero/products] Audit log error:", e);
  }

  // If multiple chunks, return the first (UI can request subsequent via pagination in the future).
  // Most workflows won't hit 800 rows.
  const csv = csvs[0];
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Row-Count": String(warnings.emitted),
      "X-Export-Files": String(csvs.length),
      "X-Skipped-No-Inner-Pack-Sku": String(warnings.skippedNoInnerPackSku.length),
      "X-Skipped-No-Upc": String(warnings.skippedNoUpc.length),
    },
  });
}
