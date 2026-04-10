/**
 * POST /api/v1/catalog/images/upload
 *
 * multipart/form-data:
 *   file   — required, image/*
 *   skuId  — required, must reference an existing SKU
 *
 * Runs the uploaded bytes through the sharp pipeline (square crop →
 * 2000×2000 JPEG q80, EXIF stripped), writes the result to
 * <IMAGES_ROOT>/<skuId>/<sha256>.jpg, and inserts a catalog_images row.
 *
 * Filename is the sha256 of the processed buffer, so re-uploading the
 * same photo is a no-op (dedupe per SKU).
 *
 * Response: { id, url, fileSize, width, height, checksum }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { images, skus } from "@/modules/catalog/schema";
import { and, eq } from "drizzle-orm";
import { processImage } from "@/lib/storage/image-processing";
import { saveImage } from "@/lib/storage/local";
import { catalogImageUrl } from "@/lib/storage/image-url";
import { getSessionUser } from "@/lib/get-session";

const MAX_RAW_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(request: NextRequest) {
  // Auth + uploader attribution
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse multipart
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  const skuId = formData.get("skuId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }
  if (typeof skuId !== "string" || skuId.length === 0) {
    return NextResponse.json({ error: "skuId field is required" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: `Unsupported content type: ${file.type}` },
      { status: 400 },
    );
  }
  if (file.size > MAX_RAW_SIZE) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes, max ${MAX_RAW_SIZE})` },
      { status: 413 },
    );
  }

  // Verify SKU exists
  const skuRow = await db.select().from(skus).where(eq(skus.id, skuId)).get();
  if (!skuRow) {
    return NextResponse.json({ error: "SKU not found" }, { status: 404 });
  }

  // Read raw bytes
  const rawBuffer = Buffer.from(await file.arrayBuffer());

  // Run through sharp pipeline
  let processed;
  try {
    processed = await processImage(rawBuffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "Image processing failed", detail: msg },
      { status: 400 },
    );
  }

  const relPath = `${skuId}/${processed.checksum}.jpg`;

  // Dedupe: if a row already exists for this sku+checksum, return it
  const existing = await db
    .select()
    .from(images)
    .where(and(eq(images.skuId, skuId), eq(images.checksum, processed.checksum)))
    .get();

  if (existing) {
    return NextResponse.json({
      id: existing.id,
      skuId,
      url: catalogImageUrl(existing.filePath),
      filePath: existing.filePath,
      fileSize: existing.fileSize,
      width: existing.width,
      height: existing.height,
      checksum: existing.checksum,
      deduped: true,
    });
  }

  // Persist to disk
  try {
    await saveImage(processed.buffer, relPath);
  } catch (err: unknown) {
    console.error("[upload] saveImage failed", err);
    return NextResponse.json({ error: "Failed to save image" }, { status: 500 });
  }

  // Insert row
  const id = crypto.randomUUID();
  const url = catalogImageUrl(relPath);

  await db.insert(images).values({
    id,
    skuId,
    filePath: relPath,
    url,
    fileSize: processed.size,
    mimeType: processed.mimeType,
    checksum: processed.checksum,
    width: processed.width,
    height: processed.height,
    status: "review",
    uploadedBy: session.id,
  });

  return NextResponse.json({
    id,
    skuId,
    url,
    filePath: relPath,
    fileSize: processed.size,
    width: processed.width,
    height: processed.height,
    checksum: processed.checksum,
  });
}
