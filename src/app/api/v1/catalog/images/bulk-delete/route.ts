/**
 * POST /api/v1/catalog/images/bulk-delete
 *
 * Delete images by checksum + source. Used for cleaning up old/duplicate
 * images that have been replaced by newer versions.
 *
 * Body: { items: [{ checksum: string, source: string }] }
 * Response: { deleted: number, notFound: number }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { deleteImage } from "@/lib/storage/local";

export async function POST(request: NextRequest) {
  let body: { items: { checksum: string; source: string }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "items array is required" }, { status: 400 });
  }

  let deleted = 0;
  let notFound = 0;

  const findStmt = sqlite.prepare(
    "SELECT id, file_path FROM catalog_images WHERE checksum = ? AND source = ?"
  );
  const deleteStmt = sqlite.prepare("DELETE FROM catalog_images WHERE id = ?");

  for (const item of body.items) {
    const rows = findStmt.all(item.checksum, item.source) as { id: string; file_path: string }[];

    if (rows.length === 0) {
      notFound++;
      continue;
    }

    for (const row of rows) {
      // Delete from disk
      try {
        await deleteImage(row.file_path);
      } catch {
        // File may already be gone — that's fine
      }
      // Delete from DB
      deleteStmt.run(row.id);
      deleted++;
    }
  }

  return NextResponse.json({ deleted, notFound, total: body.items.length });
}
