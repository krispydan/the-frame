export const dynamic = "force-dynamic";
export const maxDuration = 90;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  resolvePrimaryCompetitor,
  TARGET_COMPETITOR_BRANDS,
} from "@/modules/sales/lib/competitor-brands";

/**
 * POST /api/admin/sales/backfill-competitor-brand
 *
 * Walks every company with eyewear data and computes the canonical
 * `primary_competitor_brand` from top_brand + eyewear_top_competitors.
 *
 * Idempotent: re-running is a no-op for rows that haven't changed.
 *
 * Body:
 *   { dryRun?: boolean }   // default false
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
    /* empty body OK */
  }
  const dryRun = body.dryRun === true;

  const rows = sqlite
    .prepare(
      `SELECT id, top_brand, eyewear_top_competitors, primary_competitor_brand
         FROM companies
        WHERE (top_brand IS NOT NULL AND top_brand != '')
           OR (eyewear_top_competitors IS NOT NULL AND eyewear_top_competitors != '')`,
    )
    .all() as Array<{
    id: string;
    top_brand: string | null;
    eyewear_top_competitors: string | null;
    primary_competitor_brand: string | null;
  }>;

  type PerBrand = { brand: string; new: number; alreadyTagged: number };
  const byBrand = new Map<string, PerBrand>();
  for (const b of TARGET_COMPETITOR_BRANDS) {
    byBrand.set(b, { brand: b, new: 0, alreadyTagged: 0 });
  }

  const updates: Array<{ id: string; brand: string }> = [];
  let untagged = 0;
  let unchanged = 0;

  for (const r of rows) {
    const resolved = resolvePrimaryCompetitor({
      topBrand: r.top_brand,
      competitors: r.eyewear_top_competitors,
    });
    if (!resolved) {
      untagged++;
      continue;
    }
    if (r.primary_competitor_brand === resolved) {
      unchanged++;
      const acc = byBrand.get(resolved);
      if (acc) acc.alreadyTagged++;
      continue;
    }
    updates.push({ id: r.id, brand: resolved });
    const acc = byBrand.get(resolved);
    if (acc) acc.new++;
  }

  const counts = {
    scanned: rows.length,
    wouldUpdate: updates.length,
    alreadyCorrect: unchanged,
    notInTargetSet: untagged,
    perBrand: Array.from(byBrand.values()).sort((a, b) => b.new + b.alreadyTagged - (a.new + a.alreadyTagged)),
  };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts,
      sample: updates.slice(0, 15),
    });
  }

  // Update the column AND drop a 'brand_carrier' tag on each matching
  // company so the existing tag-based smart-list / prospects-list
  // filtering machinery just works — no new filter type to teach the
  // UI about. The tag is comma-appended only if not already present.
  const stmt = sqlite.prepare(
    "UPDATE companies SET primary_competitor_brand = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const tagStmt = sqlite.prepare(
    `UPDATE companies
        SET tags = CASE
                      WHEN tags IS NULL OR tags = '' OR tags = '[]'
                        THEN 'brand_carrier'
                      WHEN tags LIKE '%brand_carrier%'
                        THEN tags
                      ELSE tags || ',brand_carrier'
                    END
      WHERE id = ?`,
  );
  const txn = sqlite.transaction(() => {
    for (const u of updates) {
      stmt.run(u.brand, u.id);
      tagStmt.run(u.id);
    }
    // Also tag rows that were already correct on the column — first
    // run of this endpoint won't have any of those, but later runs
    // (after the column is populated by another path) should still
    // sync the tag.
  });
  txn();
  // Ensure every row with the column set also has the tag — separate
  // pass for idempotency. Cheap because of the index.
  sqlite
    .prepare(
      `UPDATE companies
          SET tags = CASE
                        WHEN tags IS NULL OR tags = '' OR tags = '[]'
                          THEN 'brand_carrier'
                        WHEN tags LIKE '%brand_carrier%'
                          THEN tags
                        ELSE tags || ',brand_carrier'
                      END
        WHERE primary_competitor_brand IS NOT NULL
          AND (tags IS NULL OR tags NOT LIKE '%brand_carrier%')`,
    )
    .run();

  // Recompute the per-brand totals now that the writes landed —
  // alreadyTagged + new collapse into a single "tagged" count.
  const finalRows = sqlite
    .prepare(
      `SELECT primary_competitor_brand AS brand, COUNT(*) AS n
         FROM companies
        WHERE primary_competitor_brand IS NOT NULL
        GROUP BY primary_competitor_brand
        ORDER BY n DESC`,
    )
    .all();

  return NextResponse.json({
    ok: true,
    counts: {
      scanned: rows.length,
      updated: updates.length,
      alreadyCorrect: unchanged,
      notInTargetSet: untagged,
    },
    perBrandFinal: finalRows,
  });
}
