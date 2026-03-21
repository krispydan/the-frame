export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { skus } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const allowedFields = [
    "colorName", "colorHex", "size", "upc", "weightOz",
    "costPrice", "wholesalePrice", "retailPrice", "inStock",
    "seoTitle", "metaDescription", "twelvePackSku", "twelvePackUpc", "status",
  ];

  const updates: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  await db.update(skus).set(updates as any).where(eq(skus.id, id));
  const updated = await db.select().from(skus).where(eq(skus.id, id)).limit(1);
  return NextResponse.json({ sku: updated[0] });
}
