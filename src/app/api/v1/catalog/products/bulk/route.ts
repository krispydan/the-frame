export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { inArray, sql } from "drizzle-orm";

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { ids, status } = body as { ids: string[]; status: string };

  if (!ids?.length || !status) {
    return NextResponse.json({ error: "ids and status required" }, { status: 400 });
  }

  const validStatuses = ["intake", "processing", "review", "approved", "published"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  await db
    .update(products)
    .set({ status: status as typeof products.$inferSelect["status"], updatedAt: sql`(datetime('now'))` })
    .where(inArray(products.id, ids));

  return NextResponse.json({ updated: ids.length });
}
