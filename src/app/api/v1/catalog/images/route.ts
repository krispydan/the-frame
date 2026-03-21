import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { images, skus, products, imageTypes } from "@/modules/catalog/schema";
import { eq, and, inArray, sql, like } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const skuId = searchParams.get("skuId");
  const productId = searchParams.get("productId");
  const status = searchParams.get("status");

  let conditions: any[] = [];

  if (skuId) {
    conditions.push(eq(images.skuId, skuId));
  } else if (productId) {
    const productSkus = await db.select({ id: skus.id }).from(skus).where(eq(skus.productId, productId));
    const skuIds = productSkus.map((s) => s.id);
    if (skuIds.length === 0) return NextResponse.json({ images: [] });
    conditions.push(inArray(images.skuId, skuIds));
  }

  if (status) {
    conditions.push(eq(images.status, status as any));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      id: images.id,
      skuId: images.skuId,
      filePath: images.filePath,
      imageTypeId: images.imageTypeId,
      position: images.position,
      altText: images.altText,
      width: images.width,
      height: images.height,
      aiModelUsed: images.aiModelUsed,
      status: images.status,
      isBest: images.isBest,
      createdAt: images.createdAt,
    })
    .from(images)
    .where(where)
    .orderBy(images.position);

  // Get image types for reference
  const types = await db.select().from(imageTypes);

  return NextResponse.json({ images: results, imageTypes: types });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { skuId, filePath, imageTypeId, altText, width, height, status: imgStatus } = body;

  if (!skuId || !filePath) {
    return NextResponse.json({ error: "skuId and filePath required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.insert(images).values({
    id,
    skuId,
    filePath,
    imageTypeId: imageTypeId || null,
    altText: altText || null,
    width: width || null,
    height: height || null,
    status: imgStatus || "draft",
  });

  const created = await db.select().from(images).where(eq(images.id, id)).limit(1);
  return NextResponse.json({ image: created[0] }, { status: 201 });
}
