/**
 * POST /api/v1/catalog/images/regen-collections
 *
 * Regenerate collection (composite) images for all products using the
 * newest front images from the DB. This ensures collection images
 * reflect updated source images after old duplicates are cleaned up.
 *
 * Uses the no_bg source for compositing (transparent background),
 * preferring the newest approved front image per SKU.
 *
 * Response: { regenerated: [...], failed: [...], skipped: [...] }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { readImage, saveImage } from "@/lib/storage/local";
import { getCollectionPath } from "@/lib/storage/local";
import { catalogImageUrl } from "@/lib/storage/image-url";
import { generateCollectionImage } from "@/modules/catalog/lib/image-editor/canvas/collection";
import { createHash } from "crypto";

export async function POST(_request: NextRequest) {
  // Get all products with SKUs
  const products = sqlite.prepare(`
    SELECT DISTINCT p.id, p.sku_prefix, p.name
    FROM catalog_products p
    INNER JOIN catalog_skus s ON s.product_id = p.id
    ORDER BY p.sku_prefix
  `).all() as { id: string; sku_prefix: string; name: string | null }[];

  const regenerated: { productId: string; skuPrefix: string; variantCount: number; filePath: string }[] = [];
  const failed: { productId: string; skuPrefix: string; error: string }[] = [];
  const skipped: { productId: string; skuPrefix: string; reason: string }[] = [];

  for (const product of products) {
    try {
      // Get all SKUs for this product
      const skuRows = sqlite.prepare(
        "SELECT id, sku, color_name FROM catalog_skus WHERE product_id = ? ORDER BY sku"
      ).all(product.id) as { id: string; sku: string; color_name: string }[];

      if (skuRows.length === 0) {
        skipped.push({ productId: product.id, skuPrefix: product.sku_prefix, reason: "no SKUs" });
        continue;
      }

      // Find the best no_bg front image for each SKU (newest first)
      const variants: { buffer: Buffer; label: string }[] = [];

      for (const sku of skuRows) {
        const img = sqlite.prepare(`
          SELECT ci.file_path FROM catalog_images ci
          LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
          WHERE ci.sku_id = ?
            AND ci.file_path IS NOT NULL
            AND ci.source = 'cropped'
          ORDER BY
            CASE WHEN cit.slug = 'front' THEN 0 ELSE 1 END,
            CASE WHEN ci.status = 'approved' THEN 0 WHEN ci.status = 'review' THEN 1 ELSE 2 END,
            CASE WHEN ci.is_best = 1 THEN 0 ELSE 1 END,
            ci.created_at DESC
          LIMIT 1
        `).get(sku.id) as { file_path: string } | undefined;

        if (img) {
          try {
            const buffer = await readImage(img.file_path);
            variants.push({ buffer, label: sku.color_name || sku.sku });
          } catch {
            // File missing — skip this variant
          }
        }
      }

      if (variants.length === 0) {
        skipped.push({ productId: product.id, skuPrefix: product.sku_prefix, reason: "no images found" });
        continue;
      }

      // Generate collection image
      const result = await generateCollectionImage(
        variants.map((v) => ({ buffer: v.buffer, label: v.label })),
        { canvasWidth: 2048, canvasHeight: 2048, background: "#F8F9FA" }
      );

      // Save to disk
      const checksum = createHash("sha256").update(result.buffer).digest("hex").slice(0, 16);
      const filePath = getCollectionPath(product.id, checksum, "jpg");
      await saveImage(result.buffer, filePath);

      // Upsert collection image record
      sqlite.prepare(`
        INSERT INTO catalog_collection_images (id, product_id, file_path, file_size, width, height, layout, variant_count, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(product_id) DO UPDATE SET
          file_path = excluded.file_path, file_size = excluded.file_size,
          width = excluded.width, height = excluded.height,
          layout = excluded.layout, variant_count = excluded.variant_count,
          updated_at = datetime('now')
      `).run(product.id, filePath, result.fileSize, result.width, result.height, result.layout, variants.length);

      // Also upsert into catalog_images so the Faire export can find it via source='collection'
      // Attach to the first SKU of the product
      const firstSkuId = skuRows[0].id;
      const url = catalogImageUrl(filePath);

      // Delete old collection images for all SKUs of this product
      const allSkuIds = skuRows.map((s) => s.id);
      sqlite.prepare(`
        DELETE FROM catalog_images
        WHERE sku_id IN (${allSkuIds.map(() => "?").join(",")})
          AND source = 'collection'
      `).run(...allSkuIds);

      // Insert new one
      sqlite.prepare(`
        INSERT INTO catalog_images
          (id, sku_id, file_path, url, file_size, mime_type, checksum, width, height,
           image_type_id, position, status, source, pipeline_status, uploaded_by, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'image/jpeg', ?, ?, ?,
                NULL, 0, 'approved', 'collection', 'completed', 'regen-script', datetime('now'))
      `).run(firstSkuId, filePath, url, result.fileSize, checksum, result.width, result.height);

      regenerated.push({
        productId: product.id,
        skuPrefix: product.sku_prefix,
        variantCount: variants.length,
        filePath,
      });
    } catch (e: unknown) {
      failed.push({
        productId: product.id,
        skuPrefix: product.sku_prefix,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    total_products: products.length,
    regenerated: regenerated.length,
    failed: failed.length,
    skipped: skipped.length,
    details: { regenerated, failed, skipped },
  });
}
