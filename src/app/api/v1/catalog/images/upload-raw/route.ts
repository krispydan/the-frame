/**
 * POST /api/v1/catalog/images/upload-raw
 *
 * Upload a pre-processed image directly — no Sharp reprocessing.
 * Used for batch importing images that have already been through
 * the external pipeline (bg removal, crop, shadow, square canvas).
 *
 * multipart/form-data:
 *   file      — required, image/*
 *   skuId     — required, must reference an existing SKU
 *   imageType — optional, slug like "front", "side", "other-side" etc.
 *   position  — optional, sort order (default 0)
 *   source    — optional, defaults to "pipeline"
 *
 * Skips: no resize, no crop, no quality reduction. Just computes
 * checksum, dedupes, saves to disk, and inserts a catalog_images row.
 *
 * Response: { id, url, filePath, fileSize, width, height, checksum }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createHash } from "crypto";
import { sqlite } from "@/lib/db";
import { saveImage } from "@/lib/storage/local";
import { catalogImageUrl } from "@/lib/storage/image-url";

const MAX_RAW_SIZE = 20 * 1024 * 1024; // 20 MB

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  const skuId = formData.get("skuId") as string | null;
  const imageType = formData.get("imageType") as string | null;
  const position = parseInt((formData.get("position") as string) || "0", 10);
  const source = (formData.get("source") as string) || "pipeline";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }
  if (!skuId) {
    return NextResponse.json({ error: "skuId field is required" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: `Unsupported type: ${file.type}` }, { status: 400 });
  }
  if (file.size > MAX_RAW_SIZE) {
    return NextResponse.json({ error: `Too large: ${file.size} bytes` }, { status: 413 });
  }

  // Verify SKU exists — support both UUID and SKU string (e.g. "JX1001-BLK")
  let resolvedSkuId = skuId;
  let skuRow = sqlite.prepare("SELECT id FROM catalog_skus WHERE id = ?").get(skuId) as { id: string } | undefined;
  if (!skuRow) {
    // Try by SKU string
    skuRow = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ?").get(skuId) as { id: string } | undefined;
    if (skuRow) {
      resolvedSkuId = skuRow.id;
    } else {
      return NextResponse.json({ error: `SKU not found: ${skuId}` }, { status: 404 });
    }
  }

  // Read raw bytes — NO reprocessing
  const buffer = Buffer.from(await file.arrayBuffer());

  // Get metadata without altering the image
  const meta = await sharp(buffer).metadata();
  const checksum = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const ext = meta.format === "png" ? "png" : "jpg";
  const mimeType = ext === "png" ? "image/png" : "image/jpeg";

  const relPath = `${resolvedSkuId}/${checksum}.${ext}`;

  // Dedupe: if sku+checksum already exists, return it
  const existing = sqlite.prepare(
    "SELECT id, file_path, file_size, width, height, checksum FROM catalog_images WHERE sku_id = ? AND checksum = ?"
  ).get(resolvedSkuId, checksum) as Record<string, unknown> | undefined;

  if (existing) {
    return NextResponse.json({
      id: existing.id,
      skuId: resolvedSkuId,
      url: catalogImageUrl(existing.file_path as string),
      filePath: existing.file_path,
      fileSize: existing.file_size,
      width: existing.width,
      height: existing.height,
      checksum: existing.checksum,
      deduped: true,
    });
  }

  // Save to disk
  await saveImage(buffer, relPath);

  // Resolve image type ID
  let imageTypeId: string | null = null;
  if (imageType) {
    const typeRow = sqlite.prepare("SELECT id FROM catalog_image_types WHERE slug = ?").get(imageType) as { id: string } | undefined;
    if (typeRow) imageTypeId = typeRow.id;
  }

  // Insert DB row
  const id = crypto.randomUUID();
  const url = catalogImageUrl(relPath);

  sqlite.prepare(`
    INSERT INTO catalog_images
      (id, sku_id, file_path, url, file_size, mime_type, checksum, width, height,
       image_type_id, position, status, source, pipeline_status, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'completed', 'batch', datetime('now'))
  `).run(
    id, resolvedSkuId, relPath, url, buffer.length, mimeType, checksum,
    meta.width ?? 0, meta.height ?? 0,
    imageTypeId, position, source,
  );

  return NextResponse.json({
    id,
    skuId: resolvedSkuId,
    url,
    filePath: relPath,
    fileSize: buffer.length,
    width: meta.width,
    height: meta.height,
    checksum,
  });
}
