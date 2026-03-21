import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, skus, images, tags, copyVersions } from "@/modules/catalog/schema";
import { like, sql, eq, and, or, type SQL } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";
  const withStats = searchParams.get("withStats") === "true";

  const conditions: SQL[] = [];
  if (search) {
    conditions.push(
      or(
        like(products.name, `%${search}%`),
        like(products.skuPrefix, `%${search}%`)
      )!
    );
  }
  if (status) {
    conditions.push(eq(products.status, status as "intake" | "processing" | "review" | "approved" | "published"));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      id: products.id,
      skuPrefix: products.skuPrefix,
      name: products.name,
      category: products.category,
      factoryName: products.factoryName,
      wholesalePrice: products.wholesalePrice,
      retailPrice: products.retailPrice,
      status: products.status,
      createdAt: products.createdAt,
      variantCount: sql<number>`(SELECT COUNT(*) FROM catalog_skus WHERE product_id = ${products.id})`,
      imageCount: withStats
        ? sql<number>`(SELECT COUNT(*) FROM catalog_images ci JOIN catalog_skus cs ON ci.sku_id = cs.id WHERE cs.product_id = ${products.id})`
        : sql<number>`0`,
      completeness: withStats
        ? sql<number>`(
            CAST(
              (CASE WHEN ${products.name} IS NOT NULL AND ${products.name} != '' THEN 1 ELSE 0 END) +
              (CASE WHEN ${products.description} IS NOT NULL AND ${products.description} != '' THEN 1 ELSE 0 END) +
              (CASE WHEN ${products.retailPrice} IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN ${products.wholesalePrice} IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN ${products.category} IS NOT NULL THEN 1 ELSE 0 END) +
              (CASE WHEN (SELECT COUNT(*) FROM catalog_skus WHERE product_id = ${products.id}) > 0 THEN 1 ELSE 0 END) +
              (CASE WHEN (SELECT COUNT(*) FROM catalog_images ci JOIN catalog_skus cs ON ci.sku_id = cs.id WHERE cs.product_id = ${products.id} AND ci.status = 'approved') > 0 THEN 1 ELSE 0 END) +
              (CASE WHEN (SELECT COUNT(*) FROM catalog_tags WHERE product_id = ${products.id}) > 0 THEN 1 ELSE 0 END)
            AS REAL) / 8.0 * 100
          )`
        : sql<number>`0`,
    })
    .from(products)
    .where(where)
    .orderBy(products.skuPrefix);

  return NextResponse.json({ products: results });
}
