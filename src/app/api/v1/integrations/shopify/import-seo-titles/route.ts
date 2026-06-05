export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import VERIFIED_SEO from "@/modules/catalog/lib/shopify-metafields/verified-seo.json";

/**
 * POST /api/v1/integrations/shopify/import-seo-titles
 *
 * Write the hand-curated SEO titles + descriptions from the
 * "SEO Recs (Verified)" sheet into products.seo_title and
 * products.meta_description. These become the source of truth for
 * what Shopify's global.title_tag / description_tag carry — the
 * extended-metafields builder prefers stored values over the
 * deterministic formula when present.
 *
 * Effectively the v2 "override mechanism" using existing columns.
 *
 * The spreadsheet's Westside FLAG row is dropped during extraction
 * (no usable title) — needs manual review before publishing.
 *
 * Body:
 *   { dryRun?: boolean }   default true
 *
 * Returns:
 *   { ok, planned/applied, missingHandles, changes[] }
 */

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
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* ok */ }
  const apply = body.dryRun === false;

  const rows = VERIFIED_SEO as Array<{
    handle: string; title: string; description: string;
  }>;

  const allProducts = sqlite.prepare(
    `SELECT id, name, seo_title, meta_description FROM catalog_products`,
  ).all() as Array<{
    id: string; name: string | null;
    seo_title: string | null; meta_description: string | null;
  }>;
  const byHandle = new Map<string, typeof allProducts[number]>();
  for (const p of allProducts) {
    if (!p.name) continue;
    byHandle.set(nameToHandle(p.name), p);
  }

  interface Change {
    handle: string; productId: string;
    titleChanged: boolean;
    descriptionChanged: boolean;
    oldTitle?: string | null;
    newTitle: string;
    oldDescription?: string | null;
    newDescription: string;
  }
  const changes: Change[] = [];
  const missing: string[] = [];

  for (const v of rows) {
    const p = byHandle.get(v.handle);
    if (!p) { missing.push(v.handle); continue; }
    const titleChanged = (p.seo_title ?? "") !== v.title;
    const descriptionChanged = (p.meta_description ?? "") !== v.description;
    if (titleChanged || descriptionChanged) {
      changes.push({
        handle: v.handle, productId: p.id,
        titleChanged, descriptionChanged,
        oldTitle: p.seo_title, newTitle: v.title,
        oldDescription: p.meta_description, newDescription: v.description,
      });
    }
  }

  if (!apply) {
    return NextResponse.json({
      ok: true, dryRun: true,
      verifiedRows: rows.length,
      productsInCatalog: allProducts.length,
      plannedChanges: changes.length,
      missingHandles: missing,
      // Trim previews so the response stays readable.
      changes: changes.slice(0, 10).map((c) => ({
        handle: c.handle,
        titleChanged: c.titleChanged,
        newTitle: c.newTitle,
        descriptionChanged: c.descriptionChanged,
        newDescriptionPreview: c.newDescription.slice(0, 80) + (c.newDescription.length > 80 ? "..." : ""),
      })),
    });
  }

  const update = sqlite.prepare(
    `UPDATE catalog_products
        SET seo_title = ?, meta_description = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );
  let applied = 0;
  const txn = sqlite.transaction(() => {
    for (const c of changes) {
      update.run(c.newTitle, c.newDescription, c.productId);
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
      titleChanged: c.titleChanged,
      descriptionChanged: c.descriptionChanged,
    })),
  });
}
