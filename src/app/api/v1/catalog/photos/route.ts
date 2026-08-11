/**
 * GET /api/v1/catalog/photos — the product-photo coverage matrix for
 * the UI: per SKU, which kinds exist (with thumbnail URLs) and which
 * required kinds are missing. Same lib the MCP coverage tool uses.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { photoCoverage } from "@/modules/catalog/lib/photo-ingest";
import { PHOTO_KINDS } from "@/modules/catalog/lib/photo-kinds";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rows = photoCoverage({
    productId: searchParams.get("productId") || undefined,
    search: searchParams.get("search") || undefined,
  });
  const missingOnly = searchParams.get("missingOnly") === "1";

  const out = (missingOnly ? rows.filter((r) => r.missingRequired.length > 0) : rows).map((r) => ({
    ...r,
    kinds: Object.fromEntries(
      Object.entries(r.kinds).map(([k, v]) => [k, { ...v, url: v.url ?? null }]),
    ),
  }));

  return NextResponse.json({
    kinds: PHOTO_KINDS,
    skus: out,
    summary: {
      total: rows.length,
      complete: rows.filter((r) => r.missingRequired.length === 0).length,
    },
  });
}
