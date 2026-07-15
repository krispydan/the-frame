/**
 * Catalog reference data for SKU identification.
 *
 * (The AI contact-sheet builder that used to live here was removed with
 * the vision matcher — identification is now filename matching + manual
 * review against the catalog in the UI.)
 */
import { sqlite } from "@/lib/db";

export interface ReferenceSku {
  skuId: string;
  sku: string;             // e.g. JX1005-OLV
  productId: string;
  productName: string;
  colorName: string | null;
  imagePath: string | null; // catalog_images.file_path (best available)
}

/**
 * One best image per SKU: isBest first, then approved, then anything
 * with a local file. Includes SKUs without images (imagePath null) —
 * filename matching doesn't need a photo.
 */
export function loadReferenceSkus(): ReferenceSku[] {
  return sqlite.prepare(`
    SELECT s.id AS skuId, s.sku, p.id AS productId, p.name AS productName,
           s.color_name AS colorName,
           (SELECT i.file_path FROM catalog_images i
             WHERE i.sku_id = s.id AND i.file_path IS NOT NULL
             ORDER BY i.is_best DESC,
                      CASE i.status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
                      i.position ASC
             LIMIT 1) AS imagePath
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    WHERE s.sku IS NOT NULL
    ORDER BY p.name ASC, s.sku ASC
  `).all() as ReferenceSku[];
}
