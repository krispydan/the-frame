export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tags } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const productId = searchParams.get("productId");

  const where = productId ? eq(tags.productId, productId) : undefined;
  const results = await db.select().from(tags).where(where);
  return NextResponse.json({ tags: results });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { productId, tagName, dimension, source } = body;

  if (!productId || !tagName) {
    return NextResponse.json({ error: "productId and tagName required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.insert(tags).values({
    id,
    productId,
    tagName,
    dimension: dimension || "other",
    source: source || "manual",
  });

  return NextResponse.json({ tag: { id, productId, tagName, dimension, source } }, { status: 201 });
}
