export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { catalogImageUrl } from "@/lib/storage/image-url";

/**
 * GET /api/v1/integrations/amazon/listings
 *
 * Lightweight listing of every approved catalog product joined with its
 * Amazon listing status + a hero thumbnail. Drives the client-side
 * /settings/integrations/amazon table so it can refresh without a full
 * page reload after each generation completes.
 *
 * Hero thumbnail rule: prefer the "best" image on any SKU of the
 * product; fall back to the first image we have. Same logic the AI
 * vision pipeline implicitly uses (loadExportProducts orders images
 * by isBest DESC, position ASC).
 */
export async function GET() {
  const rows = sqlite
    .prepare(
      `SELECT
        p.id,
        p.sku_prefix,
        p.name,
        p.status,
        CASE WHEN al.id IS NULL THEN 0 ELSE 1 END AS has_listing,
        al.generated_at,
        al.model_used,
        al.amazon_title,
        (
          SELECT ci.file_path
          FROM catalog_images ci
          JOIN catalog_skus cs ON ci.sku_id = cs.id
          WHERE cs.product_id = p.id
          ORDER BY ci.is_best DESC, ci.position ASC, ci.id ASC
          LIMIT 1
        ) AS hero_file_path
      FROM catalog_products p
      LEFT JOIN catalog_amazon_listings al ON al.product_id = p.id
      WHERE p.status NOT IN ('intake', 'processing')
      ORDER BY
        (CASE WHEN al.id IS NULL THEN 0 ELSE 1 END) ASC,
        p.sku_prefix ASC`,
    )
    .all() as Array<{
      id: string;
      sku_prefix: string;
      name: string | null;
      status: string;
      has_listing: number;
      generated_at: string | null;
      model_used: string | null;
      amazon_title: string | null;
      hero_file_path: string | null;
    }>;

  const out = rows.map((r) => ({
    id: r.id,
    skuPrefix: r.sku_prefix,
    name: r.name,
    status: r.status,
    hasListing: r.has_listing === 1,
    generatedAt: r.generated_at,
    modelUsed: r.model_used,
    amazonTitle: r.amazon_title,
    thumbnailUrl: catalogImageUrl(r.hero_file_path),
  }));

  return NextResponse.json({ rows: out });
}
