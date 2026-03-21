export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, skus, images, tags, copyVersions } from "@/modules/catalog/schema";
import { eq, sql } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const product = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (product.length === 0) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const productSkus = await db.select().from(skus).where(eq(skus.productId, id));
  const productTags = await db.select().from(tags).where(eq(tags.productId, id));
  const productCopy = await db.select().from(copyVersions).where(eq(copyVersions.productId, id));

  // Count images per SKU
  const imageStats = productSkus.length > 0
    ? await Promise.all(productSkus.map(async (sku) => {
        const count = await db.select({ count: sql<number>`COUNT(*)` }).from(images).where(eq(images.skuId, sku.id));
        const approved = await db.select({ count: sql<number>`COUNT(*)` }).from(images).where(sql`${images.skuId} = ${sku.id} AND ${images.status} = 'approved'`);
        return { skuId: sku.id, total: count[0]?.count || 0, approved: approved[0]?.count || 0 };
      }))
    : [];

  return NextResponse.json({
    product: product[0],
    skus: productSkus,
    tags: productTags,
    copyVersions: productCopy,
    imageStats,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const allowedFields = [
    "name", "description", "shortDescription", "bulletPoints", "category",
    "frameShape", "frameMaterial", "gender", "lensType",
    "wholesalePrice", "retailPrice", "msrp", "factoryName", "factorySku",
    "seoTitle", "metaDescription", "status",
  ];

  const updates: Record<string, unknown> = { updatedAt: sql`(datetime('now'))` };
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }

  await db.update(products).set(updates as any).where(eq(products.id, id));

  const updated = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return NextResponse.json({ product: updated[0] });
}
