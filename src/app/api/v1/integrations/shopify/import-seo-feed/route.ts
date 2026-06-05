export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import VERIFIED_SHAPES from "@/modules/catalog/lib/shopify-metafields/verified-shapes.json";

/**
 * POST /api/v1/integrations/shopify/import-seo-feed
 *
 * Apply the visually-verified frame-shape + product_type corrections
 * from jaxy-seo-feed-recommendations-v2.xlsx to The Frame's catalog
 * DB. Server-side wrapper around scripts/import-seo-feed-recommendations
 * .ts so the cutover is curl-able against prod.
 *
 * Data source: src/modules/catalog/lib/shopify-metafields/verified-
 * shapes.json — extracted from the spreadsheet at build time so the
 * runtime doesn't need filesystem access to arbitrary repo paths
 * (Next.js's standalone build doesn't ship docs/* files).
 *
 * Body:
 *   { dryRun?: boolean }   default true
 */

const FLAG_OVERRIDES: Record<string, string> = { westside: "SQUARE" };

const SHAPE_TO_CANONICAL: Record<string, string> = {
  ROUND: "round", SQUARE: "square", RECTANGLE: "rectangle",
  OVAL: "oval", "CAT-EYE": "cat-eye", CATEYE: "cat-eye",
  AVIATOR: "aviator", HEXAGONAL: "hexagonal",
  GEOMETRIC: "geometric", BUTTERFLY: "butterfly", OVERSIZED: "oversized",
};

const OPTICAL_TO_SUNGLASSES_HANDLES = new Set([
  "vinyl", "studio", "cosmic", "eastwood", "westside",
  "lennon", "dynasty", "captain", "theory", "horizon",
]);

function nameToHandle(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function POST(req: NextRequest) {
  try {
    return await runImport(req);
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

async function runImport(req: NextRequest) {
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* ok */ }
  const apply = body.dryRun === false;

  const verified = VERIFIED_SHAPES as Array<{
    handle: string; product: string; shape: string;
  }>;

  // Build name→product index once.
  const allProducts = sqlite.prepare(
    `SELECT id, name, description FROM catalog_products`,
  ).all() as Array<{ id: string; name: string | null; description: string | null }>;
  const byHandle = new Map<string, { id: string; name: string; description: string | null }>();
  for (const p of allProducts) {
    if (!p.name) continue;
    byHandle.set(nameToHandle(p.name), {
      id: p.id, name: p.name, description: p.description,
    });
  }

  const getCurrentShapeTag = sqlite.prepare(
    `SELECT tag_name FROM catalog_tags
      WHERE product_id = ? AND LOWER(dimension) IN ('frameshape','frame_shape')
      LIMIT 1`,
  );
  const getCurrentTypeTag = sqlite.prepare(
    `SELECT tag_name FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('producttype','product_type','category')
      LIMIT 1`,
  );

  interface Change {
    handle: string; productId: string;
    newFrameShape: string | null;
    newProductType: string | null;
    descriptionScrubbed: boolean;
  }
  const changes: Change[] = [];
  const missing: string[] = [];

  for (const v of verified) {
    if (!v.handle || !v.shape) continue;
    const p = byHandle.get(v.handle);
    if (!p) { missing.push(v.handle); continue; }

    const resolvedShape = FLAG_OVERRIDES[v.handle] ?? v.shape;
    const canonical = SHAPE_TO_CANONICAL[resolvedShape];
    let newFrameShape: string | null = null;
    if (canonical) {
      const cur = getCurrentShapeTag.get(p.id) as { tag_name: string } | undefined;
      if (!cur || (cur.tag_name ?? "").toLowerCase() !== canonical) {
        newFrameShape = canonical;
      }
    }

    let newProductType: string | null = null;
    if (OPTICAL_TO_SUNGLASSES_HANDLES.has(v.handle)) {
      const cur = getCurrentTypeTag.get(p.id) as { tag_name: string } | undefined;
      if ((cur?.tag_name ?? "").toLowerCase() !== "sunglasses") {
        newProductType = "sunglasses";
      }
    }

    const descriptionScrubbed =
      !!p.description && /wayfarer/i.test(p.description);

    if (newFrameShape || newProductType || descriptionScrubbed) {
      changes.push({
        handle: v.handle, productId: p.id, newFrameShape, newProductType,
        descriptionScrubbed,
      });
    }
  }

  if (!apply) {
    return NextResponse.json({
      ok: true, dryRun: true,
      verifiedRows: verified.length,
      productsInCatalog: allProducts.length,
      plannedChanges: changes.length,
      missingHandles: missing,
      changes: changes.slice(0, 50),
    });
  }

  // Apply
  const deleteShapeTag = sqlite.prepare(
    `DELETE FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('frameshape','frame_shape')`,
  );
  const deleteTypeTag = sqlite.prepare(
    `DELETE FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('producttype','product_type','category')`,
  );
  const insertTag = sqlite.prepare(
    `INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
     VALUES (?, ?, ?, ?, 'manual')`,
  );
  const updateDescription = sqlite.prepare(
    `UPDATE catalog_products
        SET description = REPLACE(REPLACE(description, 'wayfarer', 'classic square'), 'Wayfarer', 'Classic Square'),
            updated_at = datetime('now')
      WHERE id = ?`,
  );

  let applied = 0;
  const txn = sqlite.transaction(() => {
    for (const c of changes) {
      if (c.newFrameShape) {
        deleteShapeTag.run(c.productId);
        insertTag.run(crypto.randomUUID(), c.productId, c.newFrameShape, "frameShape");
      }
      if (c.newProductType) {
        deleteTypeTag.run(c.productId);
        insertTag.run(crypto.randomUUID(), c.productId, c.newProductType, "productType");
      }
      if (c.descriptionScrubbed) {
        updateDescription.run(c.productId);
      }
      applied++;
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    applied,
    missingHandles: missing,
    changesSummary: changes.map((c) => ({
      handle: c.handle,
      shape: c.newFrameShape,
      type: c.newProductType,
      descriptionScrubbed: c.descriptionScrubbed,
    })),
  });
}
