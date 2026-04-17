/**
 * POST /api/admin/rekey-image
 *
 * Replace the file backing an existing catalog_images row with new bytes
 * (computes new checksum, writes to new path, updates the DB row).
 *
 * Use case: a DB row's current checksum points to a file that no
 * longer exists anywhere, but we have alternative bytes (e.g. a newer
 * local-generated version on Desktop) that should take its place.
 *
 * Body: { rowId: string, data: base64, overwrite?: boolean }
 *
 * Behavior:
 *  1. Load catalog_images row by id.
 *  2. Decode base64 → buffer.
 *  3. newChecksum = sha256(buffer).slice(0,16).
 *  4. newFilePath = existing file_path with old checksum replaced.
 *     (Works for both `<sku_id>/<source>/<hash>.<ext>` and
 *      `collections/<productId>/<hash>.<ext>` path patterns.)
 *  5. saveImage(buffer, newFilePath).
 *  6. UPDATE catalog_images SET file_path=?, checksum=?, file_size=?
 *     WHERE id=?.
 *
 * Response: { status: "ok", rowId, oldFilePath, newFilePath,
 *             oldChecksum, newChecksum, size }
 *
 * Auth: x-admin-key: jaxy2026
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import path from "path";
import { sqlite } from "@/lib/db";
import { saveImage, imageStat } from "@/lib/storage/local";
import { requireAdmin } from "@/lib/admin-auth";

type ImageRow = {
  id: string;
  file_path: string;
  checksum: string | null;
};

export async function POST(request: NextRequest) {
  const deny = requireAdmin(request);
  if (deny) return deny;

  let body: { rowId?: string; data?: string; overwrite?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const { rowId, data, overwrite } = body;
  if (!rowId) return NextResponse.json({ error: "rowId required" }, { status: 400 });
  if (!data) return NextResponse.json({ error: "data (base64) required" }, { status: 400 });

  const row = sqlite.prepare(
    "SELECT id, file_path, checksum FROM catalog_images WHERE id = ?"
  ).get(rowId) as ImageRow | undefined;

  if (!row || !row.file_path) {
    return NextResponse.json({ error: "row not found or missing file_path" }, { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(data, "base64");
  } catch {
    return NextResponse.json({ error: "invalid base64 data" }, { status: 400 });
  }

  const newChecksum = createHash("sha256").update(buffer).digest("hex").slice(0, 16);

  // Derive newFilePath by replacing the checksum portion of the filename.
  const dir = path.posix.dirname(row.file_path);
  const ext = path.posix.extname(row.file_path);
  const newFilePath = path.posix.join(dir, `${newChecksum}${ext}`);

  // The target path is content-addressed. If a file already exists at
  // the new path, it IS the same bytes — skip the write (unless overwrite
  // is explicitly set to force a re-write). The DB row still gets updated
  // below so the row points at the on-disk file.
  const existing = await imageStat(newFilePath);
  let wrote = false;
  if (!existing.exists || overwrite) {
    try {
      await saveImage(buffer, newFilePath);
      wrote = true;
    } catch (err) {
      return NextResponse.json({
        error: err instanceof Error ? err.message : String(err),
      }, { status: 500 });
    }
  }

  sqlite.prepare(`
    UPDATE catalog_images
    SET file_path = ?, checksum = ?, file_size = ?
    WHERE id = ?
  `).run(newFilePath, newChecksum, buffer.length, row.id);

  return NextResponse.json({
    status: "ok",
    rowId: row.id,
    oldFilePath: row.file_path,
    newFilePath,
    oldChecksum: row.checksum,
    newChecksum,
    size: buffer.length,
    wroteFile: wrote,
  });
}
