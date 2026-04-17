/**
 * POST /api/admin/upload-image
 *
 * Writes a base64-encoded image to the Railway /data/images volume at
 * the DB-specified relative path. Used to restore truly-missing files
 * that the Phase 1 audit flagged (DB record exists but file is gone).
 *
 * Body: {
 *   filePath: string,        // relative path, e.g. "<sku_id>/square/<hash>.jpg"
 *   data: string,            // base64
 *   expectedChecksum?: string, // optional: first 16 hex chars of sha256(buffer)
 *   overwrite?: boolean,     // default false → 409 if file exists
 * }
 *
 * Response: { status: "ok", filePath, size, checksum }
 *   or { error } with status 400 | 401 | 409.
 *
 * Auth: x-admin-key: jaxy2026
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { saveImage, imageStat } from "@/lib/storage/local";
import { requireAdmin } from "@/lib/admin-auth";

export async function POST(request: NextRequest) {
  const deny = requireAdmin(request);
  if (deny) return deny;

  let body: {
    filePath?: string;
    data?: string;
    expectedChecksum?: string;
    overwrite?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const { filePath, data, expectedChecksum, overwrite } = body;

  if (!filePath || typeof filePath !== "string") {
    return NextResponse.json({ error: "filePath required" }, { status: 400 });
  }
  if (!data || typeof data !== "string") {
    return NextResponse.json({ error: "data (base64) required" }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(data, "base64");
  } catch {
    return NextResponse.json({ error: "invalid base64 data" }, { status: 400 });
  }

  const checksum = createHash("sha256").update(buffer).digest("hex").slice(0, 16);

  if (expectedChecksum && checksum !== expectedChecksum) {
    return NextResponse.json({
      error: "checksum mismatch",
      expected: expectedChecksum,
      got: checksum,
    }, { status: 400 });
  }

  if (!overwrite) {
    const existing = await imageStat(filePath);
    if (existing.exists) {
      return NextResponse.json({ error: "exists", filePath, size: existing.size }, { status: 409 });
    }
  }

  try {
    await saveImage(buffer, filePath);
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
    }, { status: 400 });
  }

  return NextResponse.json({
    status: "ok",
    filePath,
    size: buffer.length,
    checksum,
  });
}
