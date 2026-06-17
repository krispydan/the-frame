export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/catalog/auto-tag-new-products
 *
 * One-shot follow-up to the Master-PO bulk import (see
 * /api/admin/catalog/import-po). The PO products were created with no
 * tags; this walks the new products and assigns the right
 * `dimension=category` tag based on their SKU naming convention:
 *
 *   SKU contains "-R-"  →  tag_name="reading"
 *   SKU contains "-S-"  →  tag_name="sunglasses"
 *
 * Existing pre-PO products (under the old `JX3003-BRW` naming, no
 * type infix) are NOT touched — they had no category tags before
 * and we don't infer one here.
 *
 * Idempotent: a product that already has a category tag is skipped.
 * Re-runnable safely.
 *
 * Body:
 *   { dryRun?: boolean }  // default false
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun === true;

  // Find every product that has at least one SKU with -R- or -S- in
  // the code. Group by product so we can emit one tag per (product,
  // category). Also pulls products that ALREADY have a category tag
  // so we can skip them.
  const rows = sqlite
    .prepare(
      `SELECT
         p.id AS product_id,
         p.sku_prefix,
         p.name,
         SUM(CASE WHEN s.sku LIKE '%-R-%' THEN 1 ELSE 0 END) AS reading_skus,
         SUM(CASE WHEN s.sku LIKE '%-S-%' THEN 1 ELSE 0 END) AS sunglass_skus,
         (SELECT t.tag_name FROM catalog_tags t
            WHERE t.product_id = p.id AND t.dimension = 'category'
            LIMIT 1) AS existing_category
       FROM catalog_products p
       JOIN catalog_skus s ON s.product_id = p.id
       WHERE s.sku LIKE '%-R-%' OR s.sku LIKE '%-S-%'
       GROUP BY p.id, p.sku_prefix, p.name`,
    )
    .all() as Array<{
    product_id: string;
    sku_prefix: string;
    name: string;
    reading_skus: number;
    sunglass_skus: number;
    existing_category: string | null;
  }>;

  type Plan = { productId: string; skuPrefix: string; name: string; tag: string };
  const toInsert: Plan[] = [];
  const skipped: Array<Plan & { reason: string }> = [];
  const ambiguous: Array<Plan & { reason: string }> = [];

  for (const r of rows) {
    let category: string | null = null;
    if (r.reading_skus > 0 && r.sunglass_skus === 0) category = "reading";
    else if (r.sunglass_skus > 0 && r.reading_skus === 0) category = "sunglasses";
    else {
      // Both types under one product — shouldn't happen with this PO,
      // but log it so we don't silently mis-tag.
      ambiguous.push({
        productId: r.product_id,
        skuPrefix: r.sku_prefix,
        name: r.name,
        tag: "",
        reason: `mixed: ${r.reading_skus} reading + ${r.sunglass_skus} sunglass SKUs`,
      });
      continue;
    }

    if (r.existing_category) {
      skipped.push({
        productId: r.product_id,
        skuPrefix: r.sku_prefix,
        name: r.name,
        tag: r.existing_category,
        reason: `already tagged: ${r.existing_category}`,
      });
      continue;
    }

    toInsert.push({
      productId: r.product_id,
      skuPrefix: r.sku_prefix,
      name: r.name,
      tag: category,
    });
  }

  const counts = {
    scanned: rows.length,
    wouldTag: toInsert.length,
    alreadyTagged: skipped.length,
    ambiguous: ambiguous.length,
    readingCount: toInsert.filter((t) => t.tag === "reading").length,
    sunglassCount: toInsert.filter((t) => t.tag === "sunglasses").length,
  };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts,
      sample: toInsert.slice(0, 12),
      ambiguous,
    });
  }

  const insert = sqlite.prepare<unknown[]>(
    `INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
     VALUES (?, ?, ?, 'category', 'auto')`,
  );
  const txn = sqlite.transaction(() => {
    for (const p of toInsert) {
      insert.run(crypto.randomUUID(), p.productId, p.tag);
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    counts,
    sample: toInsert.slice(0, 12),
    ambiguous,
  });
}
