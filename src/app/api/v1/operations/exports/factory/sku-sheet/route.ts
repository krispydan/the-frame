export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { operationsExports } from "@/modules/catalog/schema";
import { loadWarehouseSkus } from "@/modules/operations/lib/load-skus";
import { buildFactorySkuSheetCsv, factorySkuSheetFilename } from "@/modules/operations/lib/factory/sku-sheet";

/**
 * GET /api/v1/operations/exports/factory/sku-sheet
 *
 * Query params:
 *   ?factory=JX1|JX2|JX3|JX4          (required — exports always scoped to one factory)
 *   ?skus=JX1001-BLK,JX1001-TOR       (optional — restrict to specific SKUs)
 *   ?preview=true
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const factory = searchParams.get("factory");
  const skusParam = searchParams.get("skus");
  const preview = searchParams.get("preview") === "true";

  if (!factory) {
    return NextResponse.json({ error: "factory query param required (e.g. JX3)" }, { status: 400 });
  }
  if (!/^JX\d$/.test(factory)) {
    return NextResponse.json({ error: "Invalid factory code. Expected JX1, JX2, JX3, or JX4." }, { status: 400 });
  }

  const skuList = skusParam ? skusParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;

  const warehouseSkus = await loadWarehouseSkus({
    factoryCode: factory,
    skuList,
  });

  const rows = warehouseSkus.map((s) => ({
    productName: s.productName,
    colorName: s.colorName ?? "",
    eachSku: s.sku,
    eachUpc: s.upc,
    innerPackSku: s.twelvePackSku,
    innerPackUpc: s.twelvePackUpc,
  }));

  const { csv, warnings } = buildFactorySkuSheetCsv(rows);

  if (preview) {
    return NextResponse.json({
      rowCount: warnings.emitted,
      warnings,
      sample: rows.slice(0, 10),
    });
  }

  const filename = factorySkuSheetFilename(factory);

  try {
    await db.insert(operationsExports).values({
      exportType: "factory_sku_sheet",
      filename,
      rowCount: warnings.emitted,
      filters: JSON.stringify({ factory, skus: skuList ?? null }),
      createdBy: "admin",
    });
  } catch (e) {
    console.error("[factory/sku-sheet] Audit log error:", e);
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Row-Count": String(warnings.emitted),
      "X-Missing-Each-Upc": String(warnings.missingEachUpc.length),
      "X-Missing-Inner-Pack-Upc": String(warnings.missingInnerPackUpc.length),
    },
  });
}
