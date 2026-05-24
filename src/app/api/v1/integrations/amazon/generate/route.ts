export const dynamic = "force-dynamic";
// Vision-AI calls are slow (multi-image vision → 30-90s per product on Opus).
// 600s ceiling lets a single batched call work on ~5-10 products before we
// hand control back to the UI for the next page.
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, amazonListings } from "@/modules/catalog/schema";
import { eq, inArray, isNull, and, ne, sql } from "drizzle-orm";
import { generateAmazonListing } from "@/modules/catalog/lib/amazon/ai-generate-amazon";

/**
 * POST /api/v1/integrations/amazon/generate
 *
 * Generate or regenerate the Amazon listing copy for a set of products.
 * Uses Claude with vision (sees the product photos from Shopify CDN)
 * and persists the result to catalog_amazon_listings + audit trail to
 * catalog_copy_versions.
 *
 * Body (all optional):
 *   {
 *     "productIds": ["…"]      // explicit list; defaults to all approved
 *                                // products without an existing listing
 *     "limit": 5,              // default 5 per call (Cloudflare 100s edge)
 *     "dryRun": false,         // validate but don't persist
 *     "regenerate": false,     // when true, includes products that already
 *                                // have a listing (full regen pass)
 *     "modelOverride": "claude-opus-4-1-20250805"
 *   }
 *
 * Response:
 *   {
 *     ok, processed, candidatesRemaining,
 *     results: [{ productId, productName, status, errors, warnings, persisted }]
 *   }
 *
 * Run repeatedly until candidatesRemaining hits 0 — same drain pattern as
 * the ShipHero / Faire backfills.
 */
export async function POST(req: NextRequest) {
  let body: {
    productIds?: string[];
    limit?: number;
    dryRun?: boolean;
    regenerate?: boolean;
    modelOverride?: string;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body ok */
  }

  const limit = Math.min(Math.max(body.limit ?? 5, 1), 25);
  const dryRun = !!body.dryRun;
  const regenerate = !!body.regenerate;

  // Resolve the candidate set.
  let candidates: Array<{ id: string }>;
  if (body.productIds && body.productIds.length > 0) {
    candidates = await db
      .select({ id: products.id })
      .from(products)
      .where(inArray(products.id, body.productIds.slice(0, limit)));
  } else {
    // Default: approved products. When !regenerate, skip products that
    // already have a listing row (drains cleanly across repeated runs).
    const baseCond = and(
      ne(products.status, "intake"),
      ne(products.status, "processing"),
    );
    if (regenerate) {
      candidates = await db
        .select({ id: products.id })
        .from(products)
        .where(baseCond)
        .limit(limit);
    } else {
      // LEFT JOIN amazon_listings, take rows where listing is NULL.
      const rows = await db
        .select({ id: products.id })
        .from(products)
        .leftJoin(amazonListings, eq(amazonListings.productId, products.id))
        .where(and(baseCond, isNull(amazonListings.id)))
        .limit(limit);
      candidates = rows;
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      candidatesRemaining: 0,
      results: [],
    });
  }

  const results: Array<{
    productId: string;
    productName: string | null;
    status: "ok" | "error";
    errors: string[];
    warnings: string[];
    persisted: boolean;
    title?: string;
  }> = [];

  for (const c of candidates) {
    const r = await generateAmazonListing(c.id, {
      dryRun,
      modelOverride: body.modelOverride,
    });
    results.push({
      productId: r.productId,
      productName: r.productName,
      status: r.errors.length === 0 ? "ok" : "error",
      errors: r.errors,
      warnings: r.warnings,
      persisted: r.persisted,
      title: r.output?.title,
    });
  }

  // Count remaining candidates (approved && no listing) for drain UX.
  const remainingRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .leftJoin(amazonListings, eq(amazonListings.productId, products.id))
    .where(
      and(
        ne(products.status, "intake"),
        ne(products.status, "processing"),
        isNull(amazonListings.id),
      ),
    )
    .get();
  const candidatesRemaining = Number(remainingRow?.count ?? 0);

  return NextResponse.json({
    ok: true,
    processed: results.length,
    candidatesRemaining,
    results,
  });
}
