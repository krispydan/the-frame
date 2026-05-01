export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tags } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { scheduleShopifyTagSync } from "@/modules/catalog/lib/shopify-metafields/auto-sync";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Capture the productId before deleting so we can trigger a Shopify
  // re-sync for that product after the row is gone.
  const row = (await db.select().from(tags).where(eq(tags.id, id)).limit(1))[0];
  await db.delete(tags).where(eq(tags.id, id));
  if (row?.productId) scheduleShopifyTagSync(row.productId);
  return NextResponse.json({ deleted: true });
}
