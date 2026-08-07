/**
 * GET /api/v1/marketing/ads/options — everything the new-ad wizard
 * needs in one call: the recipe registry, the ratio set, SKUs that can
 * actually sit on a card (they have a catalog image), and the copy
 * variants. SKU list is small (a few hundred) so it ships whole and the
 * wizard filters client-side.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { listAdRecipes } from "@/modules/marketing/lib/ads/recipes";
import { AD_RATIOS, DEFAULT_RATIOS } from "@/modules/marketing/lib/ads/ratios";

export async function GET() {
  const skus = sqlite.prepare(`
    SELECT s.id, s.sku, s.color_name AS colorName, p.name AS productName,
           EXISTS (SELECT 1 FROM catalog_images i
                    WHERE i.sku_id = s.id
                      AND (i.file_path IS NOT NULL OR i.url IS NOT NULL)) AS hasImage
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    WHERE s.sku IS NOT NULL
    ORDER BY p.name, s.sku
  `).all();

  const copyVariants = sqlite.prepare(
    `SELECT code, primary_text AS primaryText, headline FROM marketing_ad_copy ORDER BY code`,
  ).all();

  return NextResponse.json({
    recipes: listAdRecipes().map((r) => ({
      slug: r.slug, code: r.code, name: r.name, description: r.description,
    })),
    ratios: Object.entries(AD_RATIOS).map(([slug, d]) => ({
      slug, ...d, default: (DEFAULT_RATIOS as string[]).includes(slug),
    })),
    skus,
    copyVariants,
  });
}
