export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { operationsExports } from "@/modules/catalog/schema";
import { loadWarehouseSkus } from "@/modules/operations/lib/load-skus";
import { buildUomMappingCsv } from "@/modules/operations/lib/shiphero/uom-mapping";
import { todayCompact } from "@/modules/operations/lib/shiphero/csv-utils";

/**
 * GET /api/v1/operations/exports/shiphero/uom
 *
 * Query params:
 *   ?factory=JX1|JX2|JX3|JX4|all    (default: all)
 *   ?scope=new|all                   (default: new)
 *   ?preview=true
 *
 * Format is STRICT: CRLF line endings + QUOTE_ALL. See uom-mapping.ts.
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
    innerPackSku: s.twelvePackSku,
    innerPackQty: 12,
  }));

  const { csvs, warnings } = buildUomMappingCsv(inputs);

  if (preview) {
    return NextResponse.json({
      rowCount: warnings.emitted,
      files: csvs.length,
      warnings,
      sample: warehouseSkus.slice(0, 10).map((s) => ({
        eachSku: s.sku,
        innerPackSku: s.twelvePackSku,
        innerPackQty: 12,
      })),
    });
  }

  const scopeLabel = factoryParam === "all" ? scope : `${factoryParam}-${scope}`;
  const filename = `shiphero_uom_${scopeLabel}_${todayCompact()}.csv`;

  try {
    await db.insert(operationsExports).values({
      exportType: "shiphero_uom",
      filename,
      rowCount: warnings.emitted,
      filters: JSON.stringify({ factory: factoryParam, scope }),
      createdBy: "admin",
    });
  } catch (e) {
    console.error("[shiphero/uom] Audit log error:", e);
  }

  const csv = csvs[0];
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Row-Count": String(warnings.emitted),
      "X-Export-Files": String(csvs.length),
    },
  });
}
