export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  resolveProducts,
  getProductPickList,
  searchProducts,
  suggestRandomProducts,
} from "@/modules/marketing/lib/product-selector";

/**
 * GET /api/v1/marketing/email/products
 *
 * Candidate products for the campaign editor's "Featured products"
 * picker + the planner's auto-suggest. One endpoint, four modes:
 *
 *   ?ids=a,b,c              → resolve specific ids (the current selection)
 *   ?q=honey                → free-text search (name / sku)
 *   ?mode=top_sellers       → most-ordered featurable products
 *   ?mode=in_stock          → products with an in-stock SKU (default)
 *   ?suggest=2&mode=in_stock→ N random featurable products
 *
 * &limit=12 caps list size. Returns { products: ProductSummary[] }.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Number(sp.get("limit") ?? "12");

  const ids = sp.get("ids");
  if (ids) {
    const products = await resolveProducts(ids.split(",").map((s) => s.trim()).filter(Boolean));
    return NextResponse.json({ products });
  }

  const suggest = sp.get("suggest");
  if (suggest) {
    const n = Math.min(Math.max(parseInt(suggest, 10) || 1, 1), 5);
    const mode = sp.get("mode") === "top_sellers" ? "top_sellers" : "in_stock";
    const products = await suggestRandomProducts(n, mode);
    return NextResponse.json({ products });
  }

  const q = sp.get("q");
  if (q) {
    const products = await searchProducts(q, limit);
    return NextResponse.json({ products });
  }

  const mode = sp.get("mode") === "top_sellers" ? "top_sellers" : "in_stock";
  const products = await getProductPickList({ mode, limit });
  return NextResponse.json({ products });
}
