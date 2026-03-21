import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { copyVersions } from "@/modules/catalog/schema";
import { eq, and, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const productId = searchParams.get("productId");
  const field = searchParams.get("field");

  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const conditions = [eq(copyVersions.productId, productId)];
  if (field) conditions.push(eq(copyVersions.fieldName, field as any));

  const versions = await db
    .select()
    .from(copyVersions)
    .where(and(...conditions))
    .orderBy(desc(copyVersions.createdAt))
    .limit(20);

  return NextResponse.json({ versions });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { productId, fieldName, content, aiModel } = body;

  if (!productId || !fieldName || !content) {
    return NextResponse.json({ error: "productId, fieldName, content required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.insert(copyVersions).values({
    id,
    productId,
    fieldName: fieldName as any,
    content,
    aiModel: aiModel || "manual",
  });

  return NextResponse.json({ version: { id, productId, fieldName, content, aiModel } }, { status: 201 });
}
