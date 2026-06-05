export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import * as fs from "fs";
import * as path from "path";
import * as xlsx from "xlsx";

/**
 * POST /api/v1/integrations/shopify/import-seo-feed
 *
 * Server-side wrapper around scripts/import-seo-feed-recommendations.ts
 * so Daniel can apply the spreadsheet corrections to PROD's catalog DB
 * via curl, rather than running tsx locally (which only touches his
 * Mac's dev DB).
 *
 * Reads the .xlsx from the deployed file (uploaded into the repo before
 * the run), applies:
 *   - frame shape tag corrections (39 SKUs, westside hard-coded to
 *     square per brief)
 *   - product_type tag corrections (10 optical → sunglasses)
 *   - Wayfarer scrub on descriptions
 *
 * Body:
 *   { dryRun?: boolean }
 *
 * Reads the spreadsheet from one of:
 *   - docs/jaxy-seo-feed-recommendations-v2.xlsx  (preferred — in repo)
 *   - SEO_FEED_XLSX env var (absolute path on the Railway volume)
 */

const FLAG_OVERRIDES: Record<string, string> = { westside: "SQUARE" };

const SHAPE_TO_CANONICAL: Record<string, string> = {
  ROUND: "round", SQUARE: "square", RECTANGLE: "rectangle",
  OVAL: "oval", "CAT-EYE": "cat-eye", CATEYE: "cat-eye",
  AVIATOR: "aviator", HEXAGONAL: "hexagonal",
  GEOMETRIC: "geometric", BUTTERFLY: "butterfly", OVERSIZED: "oversized",
};

const OPTICAL_TO_SUNGLASSES_HANDLES = [
  "vinyl", "studio", "cosmic", "eastwood", "westside",
  "lennon", "dynasty", "captain", "theory", "horizon",
];

function nameToHandle(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findXlsxPath(): string | null {
  const candidates = [
    process.env.SEO_FEED_XLSX,
    path.join(process.cwd(), "docs", "jaxy-seo-feed-recommendations-v2.xlsx"),
    path.join(process.cwd(), "data", "jaxy-seo-feed-recommendations-v2.xlsx"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* ok */ }
  const apply = body.dryRun === false;

  const xlsxPath = findXlsxPath();
  if (!xlsxPath) {
    return NextResponse.json(
      {
        ok: false,
        error: "Spreadsheet not found. Set SEO_FEED_XLSX env, or place jaxy-seo-feed-recommendations-v2.xlsx in docs/ before deploy.",
      },
      { status: 400 },
    );
  }

  const wb = xlsx.readFile(xlsxPath);
  const sheet = wb.Sheets["Verified Shapes"];
  if (!sheet) {
    return NextResponse.json(
      { ok: false, error: "Sheet 'Verified Shapes' not found" },
      { status: 400 },
    );
  }
  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { range: 3 });

  // Build name→product index once
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

  const opticalSet = new Set(OPTICAL_TO_SUNGLASSES_HANDLES);

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
    descriptionChanged: boolean;
  }
  const changes: Change[] = [];
  const missing: string[] = [];

  for (const r of rows) {
    const handle = String(r["Handle"] ?? "").trim();
    const shape = String(r["Verified Shape"] ?? "").trim().toUpperCase();
    if (!handle || !shape) continue;

    const p = byHandle.get(handle);
    if (!p) { missing.push(handle); continue; }

    const resolvedShape = FLAG_OVERRIDES[handle] ?? shape;
    const canonical = SHAPE_TO_CANONICAL[resolvedShape];
    let newFrameShape: string | null = null;
    if (canonical) {
      const cur = getCurrentShapeTag.get(p.id) as { tag_name: string } | undefined;
      if (!cur || (cur.tag_name ?? "").toLowerCase() !== canonical) {
        newFrameShape = canonical;
      }
    }

    let newProductType: string | null = null;
    if (opticalSet.has(handle)) {
      const cur = getCurrentTypeTag.get(p.id) as { tag_name: string } | undefined;
      if ((cur?.tag_name ?? "").toLowerCase() !== "sunglasses") {
        newProductType = "sunglasses";
      }
    }

    const descriptionChanged =
      !!p.description && /wayfarer/i.test(p.description);

    if (newFrameShape || newProductType || descriptionChanged) {
      changes.push({
        handle, productId: p.id, newFrameShape, newProductType,
        descriptionChanged,
      });
    }
  }

  if (!apply) {
    return NextResponse.json({
      ok: true, dryRun: true,
      xlsxPath,
      plannedChanges: changes.length,
      missingHandles: missing,
      changes: changes.slice(0, 50), // truncate for response brevity
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
    `UPDATE catalog_products SET description = REPLACE(REPLACE(description, 'wayfarer', 'classic square'), 'Wayfarer', 'Classic Square'), updated_at = datetime('now')
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
      if (c.descriptionChanged) {
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
      descriptionScrubbed: c.descriptionChanged,
    })),
  });
}
