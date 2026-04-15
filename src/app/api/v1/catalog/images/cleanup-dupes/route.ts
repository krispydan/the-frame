/**
 * POST /api/v1/catalog/images/cleanup-dupes
 *
 * Find and remove duplicate images: when a SKU has multiple images with
 * the same source and image_type (angle), keep only the newest one.
 *
 * This handles the case where old-style images (JX3001-BLK_CROPPED.png)
 * were uploaded as "front" and later replaced by newer angle-named versions
 * (JX3001-BLK-FRONT_CROPPED.png), also "front". Both exist in the DB.
 *
 * Query params:
 *   ?dry=true  — preview what would be deleted without actually deleting
 *
 * Response: { deleted: [...], kept: [...], total_deleted: number }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { deleteImage } from "@/lib/storage/local";

interface ImageRow {
  id: string;
  sku_id: string;
  file_path: string;
  source: string;
  image_type_id: string | null;
  checksum: string;
  created_at: string;
}

export async function POST(request: NextRequest) {
  const dry = request.nextUrl.searchParams.get("dry") === "true";

  // Find all images grouped by sku_id + source + image_type_id
  // where there are duplicates (more than one image for the same combo)
  const allImages = sqlite.prepare(`
    SELECT ci.id, ci.sku_id, ci.file_path, ci.source, ci.image_type_id,
           ci.checksum, ci.created_at,
           cit.slug as angle_slug,
           cs.sku
    FROM catalog_images ci
    LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
    LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
    ORDER BY ci.sku_id, ci.source, ci.image_type_id, ci.created_at DESC
  `).all() as (ImageRow & { angle_slug: string | null; sku: string | null })[];

  // Group by sku_id + source + image_type_id
  const groups = new Map<string, typeof allImages>();
  for (const img of allImages) {
    const key = `${img.sku_id}|${img.source}|${img.image_type_id || "null"}`;
    const arr = groups.get(key) || [];
    arr.push(img);
    groups.set(key, arr);
  }

  const toDelete: { id: string; sku: string | null; source: string; angle: string | null; checksum: string; file_path: string }[] = [];
  const toKeep: { id: string; sku: string | null; source: string; angle: string | null; checksum: string }[] = [];

  for (const [, imgs] of groups) {
    if (imgs.length <= 1) continue;

    // Keep the newest (first in array since sorted DESC by created_at)
    const kept = imgs[0];
    toKeep.push({
      id: kept.id,
      sku: kept.sku,
      source: kept.source,
      angle: kept.angle_slug,
      checksum: kept.checksum,
    });

    // Delete the rest
    for (const old of imgs.slice(1)) {
      toDelete.push({
        id: old.id,
        sku: old.sku,
        source: old.source,
        angle: old.angle_slug,
        checksum: old.checksum,
        file_path: old.file_path,
      });
    }
  }

  if (!dry) {
    const deleteStmt = sqlite.prepare("DELETE FROM catalog_images WHERE id = ?");
    for (const item of toDelete) {
      try {
        await deleteImage(item.file_path);
      } catch {
        // File may already be gone
      }
      deleteStmt.run(item.id);
    }
  }

  return NextResponse.json({
    dry_run: dry,
    total_deleted: toDelete.length,
    total_kept: toKeep.length,
    deleted: toDelete.slice(0, 50), // Preview first 50
    kept: toKeep.slice(0, 50),
  });
}
