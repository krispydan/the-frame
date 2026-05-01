export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getCuratedAttrsForProducts } from "@/modules/catalog/lib/curated-attributes";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";
  const withStats = searchParams.get("withStats") === "true";

  const conditions: string[] = [];
  const params: any[] = [];

  if (search) {
    conditions.push("(p.name LIKE ? OR p.sku_prefix LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    conditions.push("p.status = ?");
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const statsColumns = withStats
    ? `, (SELECT COUNT(*) FROM catalog_images ci JOIN catalog_skus cs ON ci.sku_id = cs.id WHERE cs.product_id = p.id) as image_count,
       CAST(
         (CASE WHEN p.name IS NOT NULL AND p.name != '' THEN 1 ELSE 0 END) +
         (CASE WHEN p.description IS NOT NULL AND p.description != '' THEN 1 ELSE 0 END) +
         (CASE WHEN p.retail_price IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN p.wholesale_price IS NOT NULL THEN 1 ELSE 0 END) +
         (CASE WHEN EXISTS (SELECT 1 FROM catalog_tags WHERE product_id = p.id AND lower(dimension) IN ('category','producttype','product_type')) THEN 1 ELSE 0 END) +
         (CASE WHEN (SELECT COUNT(*) FROM catalog_skus WHERE product_id = p.id) > 0 THEN 1 ELSE 0 END) +
         (CASE WHEN (SELECT COUNT(*) FROM catalog_images ci2 JOIN catalog_skus cs2 ON ci2.sku_id = cs2.id WHERE cs2.product_id = p.id AND ci2.status = 'approved') > 0 THEN 1 ELSE 0 END) +
         (CASE WHEN (SELECT COUNT(*) FROM catalog_tags WHERE product_id = p.id) > 0 THEN 1 ELSE 0 END)
       AS REAL) / 8.0 * 100 as completeness`
    : `, 0 as image_count, 0 as completeness`;

  const rows = sqlite.prepare(`
    SELECT p.id, p.sku_prefix as skuPrefix, p.name, p.factory_name as factoryName,
           p.wholesale_price as wholesalePrice, p.retail_price as retailPrice, p.status,
           p.created_at as createdAt,
           (SELECT COUNT(*) FROM catalog_skus WHERE product_id = p.id) as variantCount
           ${statsColumns}
    FROM catalog_products p
    ${whereClause}
    ORDER BY p.sku_prefix
  `).all(...params);

  // Enrich each row with tag-derived category (the column was just removed
  // from the SELECT). Single batched query.
  const ids = (rows as Array<{ id: string }>).map((r) => r.id);
  const curated = await getCuratedAttrsForProducts(ids);
  const enriched = (rows as Array<Record<string, unknown> & { id: string }>).map((r) => ({
    ...r,
    category: curated.get(r.id)?.category ?? null,
  }));

  return NextResponse.json({ products: enriched });
}
