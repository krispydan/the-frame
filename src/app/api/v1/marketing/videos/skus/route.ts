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
  `).all(...params) as Array<{ id: string; sku: string | null; colorName: string | null; productName: string | null; productId: string }>;

  // Group into parent products — we tag products, not color variations.
  // Each product carries the full set of its SKU ids so tagging a product
  // stores all its SKUs (weighting/sales signals stay SKU-level).
  const byProduct = new Map<string, { id: string; name: string | null; skuIds: string[] }>();
  for (const r of rows) {
    const p = byProduct.get(r.productId) ?? { id: r.productId, name: r.productName, skuIds: [] };
    p.skuIds.push(r.id);
    byProduct.set(r.productId, p);
  }
  const products = [...byProduct.values()];

  // `skus` kept for backward compat; `products` is what the pickers use.
  return NextResponse.json({ products, skus: rows });
}
