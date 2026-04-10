export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { images } from "@/modules/catalog/schema";
import { inArray } from "drizzle-orm";
import { deleteImage } from "@/lib/storage/local";

/**
 * PATCH — bulk set status OR reassign to a different SKU.
 * Body: { ids: string[], status?: "draft"|"review"|"approved"|"rejected", skuId?: string }
 */
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { ids, status, skuId } = body as {
    ids: string[];
    status?: string;
    skuId?: string;
  };

  if (!ids?.length) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }
  if (!status && !skuId) {
    return NextResponse.json(
      { error: "status or skuId required" },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = {};
  if (status) {
    const valid = ["draft", "review", "approved", "rejected"];
    if (!valid.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = status;
  }
  if (skuId) updates.skuId = skuId;

  await db.update(images).set(updates as never).where(inArray(images.id, ids));
  return NextResponse.json({ updated: ids.length });
}

/**
 * DELETE — bulk delete image rows and their files on disk.
 * Body: { ids: string[] }
 */
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { ids } = body as { ids: string[] };

  if (!ids?.length) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }

  // Fetch filePaths before deleting rows so we can clean up disk
  const rows = await db
    .select({ id: images.id, filePath: images.filePath })
    .from(images)
    .where(inArray(images.id, ids));

  await db.delete(images).where(inArray(images.id, ids));

  // Remove files (best-effort; don't fail the API if disk cleanup errors)
  for (const row of rows) {
    if (!row.filePath) continue;
    try {
      await deleteImage(row.filePath);
    } catch (err) {
      console.warn("[images/bulk] disk cleanup failed", row.filePath, err);
    }
  }

  return NextResponse.json({ deleted: rows.length });
}
