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
  // filtering machinery just works.
  //
  // CRITICAL: tags is stored as a JSON array string. The previous
  // version of this endpoint did `tags || ',brand_carrier'` which
  // produced INVALID JSON like `["eyewear_cohort",...],brand_carrier`,
  // crashing the prospects API with a 500 on rows that matched.
  // We now read each row's current tags, parse leniently, add the
  // tag, and write back valid JSON.
  const stmt = sqlite.prepare(
    "UPDATE companies SET primary_competitor_brand = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const readTags = sqlite.prepare("SELECT tags FROM companies WHERE id = ?");
  const writeTags = sqlite.prepare(
    "UPDATE companies SET tags = ? WHERE id = ?",
  );

  function addBrandCarrierTag(currentRaw: string | null): string {
    // Parse leniently — same logic as the API's parseTagsLenient.
    let arr: string[] = [];
    if (currentRaw && currentRaw.trim()) {
      const s = currentRaw.trim();
      if (s.startsWith("[")) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) arr = parsed.map(String);
        } catch {
          // Hybrid form left over from the previous (buggy) backfill
          // — split into head + tail, both of which we keep.
          const closeIdx = s.lastIndexOf("]");
          if (closeIdx > 0) {
            try {
              const head = JSON.parse(s.slice(0, closeIdx + 1));
              if (Array.isArray(head)) {
                arr = [
                  ...head.map(String),
                  ...s.slice(closeIdx + 1).split(",").map((t) => t.trim()).filter(Boolean),
                ];
              }
            } catch { /* fall through */ }
          }
        }
      }
      if (arr.length === 0) {
        arr = s.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
    if (!arr.includes("brand_carrier")) arr.push("brand_carrier");
    return JSON.stringify(arr);
  }

  const txn = sqlite.transaction(() => {
    for (const u of updates) {
      stmt.run(u.brand, u.id);
      const row = readTags.get(u.id) as { tags: string | null } | undefined;
      const updated = addBrandCarrierTag(row?.tags ?? null);
      writeTags.run(updated, u.id);
    }
    // Idempotent re-tag pass: any row where the column is set but the
    // JSON tags array doesn't have brand_carrier gets fixed. Also
    // repairs the broken hybrid form left by the previous run.
    const allTagged = sqlite
      .prepare(
        "SELECT id, tags FROM companies WHERE primary_competitor_brand IS NOT NULL",
      )
      .all() as Array<{ id: string; tags: string | null }>;
    for (const r of allTagged) {
      const fixed = addBrandCarrierTag(r.tags);
      if (fixed !== r.tags) writeTags.run(fixed, r.id);
    }
  });
  txn();

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
