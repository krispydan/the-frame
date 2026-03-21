import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { images } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const image = await db.select().from(images).where(eq(images.id, id)).limit(1);
  if (image.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ image: image[0] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const allowedFields = ["status", "isBest", "altText", "position", "imageTypeId"];
  const updates: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }

  // If setting as best, unset other bests for same SKU
  if (body.isBest === true) {
    const img = await db.select().from(images).where(eq(images.id, id)).limit(1);
    if (img.length > 0) {
      await db.update(images).set({ isBest: false }).where(eq(images.skuId, img[0].skuId));
    }
  }

  await db.update(images).set(updates as any).where(eq(images.id, id));
  const updated = await db.select().from(images).where(eq(images.id, id)).limit(1);
  return NextResponse.json({ image: updated[0] });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.delete(images).where(eq(images.id, id));
  return NextResponse.json({ deleted: true });
}
