export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { composeAmazonRows } from "@/modules/catalog/lib/amazon/compose-rows";
import {
  validateAmazonBatch,
  isBatchReleasable,
  type ValidateInput,
} from "@/modules/catalog/lib/amazon/validator";
import { buildAmazonXlsxBuffer } from "@/modules/catalog/lib/amazon/xlsx-writer";

/**
 * GET /api/v1/integrations/amazon/download
 *
 * The final step — runs the same compose + validate as /validate, and if
 * (and only if) the batch is releasable (zero blocked-severity issues
 * across all products), serialises the XLSX and streams it as an
 * attachment. Otherwise returns 422 with the ProductValidationResult[]
 * so the UI can show what needs fixing.
 *
 * Query params:
 *   ?productIds=a,b,c  (comma-separated; default = all approved products)
 *
 * Why GET: matches the broader /api/v1/catalog/export/[platform]
 * pattern and lets ops invoke from a plain link / window.location =
 * "…" call. The composition is read-only.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("productIds");
  const productIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const composed = await composeAmazonRows(productIds);
  if (composed.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No products in batch" },
      { status: 400 },
    );
  }

  const inputs: ValidateInput[] = composed.map((c) => ({
    productId: c.productId,
    productName: c.productName,
    skuPrefix: c.skuPrefix,
    rows: c.rows,
    skuIdentifiers: c.skuIdentifiers,
  }));
  const results = validateAmazonBatch(inputs);

  if (!isBatchReleasable(results)) {
    const blocked = results.filter((r) => r.status === "blocked");
    return NextResponse.json(
      {
        ok: false,
        error: "Validation blocked the download",
        blockedProducts: blocked.length,
        results,
      },
      { status: 422 },
    );
  }

  // Flatten rows in product order: parent + children of product 1, then
  // parent + children of product 2, etc. (Each composed.rows is already
  // [parent, ...children].)
  const allRows = composed.flatMap((c) => c.rows);
  const buf = buildAmazonXlsxBuffer(allRows);

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="jaxy_amazon_${stamp}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
