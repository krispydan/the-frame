export const dynamic = "force-dynamic";
// AI categorization runs Gemini once per product. 4 products × ~5s
// each + headroom = ~30-60s typical. 95s ceiling stays under
// Cloudflare's 100s edge timeout.
export const maxDuration = 95;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { products, tags as tagsTable, skus as skusTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { categorizeProduct } from "@/modules/catalog/lib/shopify-metafields/ai-categorize";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";

/**
 * POST /api/v1/integrations/shopify/run-ai-categorization
 *
 * Bulk-run Gemini AI categorization across the catalog so the
 * shopify.* taxonomy metafields (eyewear-frame-color, lens-color,
 * age-group, color-pattern) get populated. Chunked like
 * run-metafield-sync to stay under Cloudflare's 100s edge timeout.
 *
 * Body (all optional):
 *   { offset?: number, limit?: number }   // default offset=0, limit=4
 *
 * Returns:
 *   { ok, totalProducts, processed, processedThrough, remaining,
 *     successes, failures: [{ skuPrefix, error }] }
 *
 * Loop until `remaining === 0`. After the loop completes, re-run
 * run-metafield-sync to push the new categorizations into Shopify
 * (the metafield sync reads products.ai_categorization).
 */
export async function POST(req: NextRequest) {
  try {
    return await run(req);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 8).join("\n") : undefined,
      },
      { status: 500 },
    );
  }
}

async function run(req: NextRequest) {
  const start = Date.now();
  let body: { offset?: number; limit?: number } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const offset = Math.max(0, body.offset ?? 0);
  const limit = Math.max(1, Math.min(20, body.limit ?? 4));

  const allProducts = await db.select().from(products);
  const slice = allProducts.slice(offset, offset + limit);

  const updateCategorization = sqlite.prepare(
    `UPDATE catalog_products
        SET ai_categorization = ?,
            ai_categorized_at = datetime('now'),
            ai_categorization_model = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  );

  let successes = 0;
  const failures: Array<{ skuPrefix: string; error: string }> = [];

  for (const product of slice) {
    if (!product.skuPrefix) {
      failures.push({ skuPrefix: product.id, error: "missing skuPrefix" });
      continue;
    }

    // Build the Gemini input: name, color (representative SKU),
    // description, curated frame shape + gender.
    const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
    const curated = curatedAttrsFromTags(
      tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
    );
    const skuRows = await db.select().from(skusTable).where(eq(skusTable.productId, product.id));
    const firstColor = skuRows[0]?.colorName ?? null;

    try {
      const res = await categorizeProduct({
        productId: product.id,
        name: product.name ?? product.skuPrefix,
        colorName: firstColor,
        description: product.description,
        frameShape: curated.frameShape,
        gender: curated.gender,
      });

      if (res.output) {
        updateCategorization.run(
          JSON.stringify(res.output),
          res.model,
          product.id,
        );
        successes++;
      } else {
        failures.push({
          skuPrefix: product.skuPrefix,
          error: res.error ?? res.problems.map((p) => `${p.field}: ${p.message}`).join("; "),
        });
      }
    } catch (e) {
      failures.push({
        skuPrefix: product.skuPrefix,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const processedThrough = offset + slice.length;
  return NextResponse.json({
    ok: true,
    totalProducts: allProducts.length,
    processed: slice.length,
    processedThrough,
    remaining: Math.max(0, allProducts.length - processedThrough),
    successes,
    failures,
    durationMs: Date.now() - start,
  });
}
