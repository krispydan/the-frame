/**
 * GET /api/v1/marketing/videos/skus — flat SKU list for the clip tag
 * pickers ({ id, sku, colorName, productName }). Optional ?search=.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get("search") || "";
  const params: unknown[] = [];
  let where = "";
  if (search) {
    where = "WHERE s.sku LIKE ? OR s.color_name LIKE ? OR p.name LIKE ?";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = sqlite.prepare(`
    SELECT s.id, s.sku, s.color_name AS colorName, p.name AS productName
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    ${where}
    ORDER BY p.name ASC, s.color_name ASC
    LIMIT 500
  `).all(...params);
  return NextResponse.json({ skus: rows });
}
