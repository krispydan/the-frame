export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/disqualify-by-keyword
 *
 * Bulk-disqualify (status='rejected') companies whose data contains
 * any of the given keywords across any of the given fields. Used
 * for off-ICP cleanup passes — e.g. "jewelry store" appearing in
 * the imported StoreLeads cohort.
 *
 * Auth: x-admin-key: jaxy2026 (same as the other /api/admin/*).
 *
 * Body:
 *   {
 *     keywords: string[]          // case-insensitive substring match
 *     fields?: string[]           // companies columns to search; default
 *                                 //   ["name","description","meta_description",
 *                                 //    "top_brand","industry","category","tags"]
 *     reason: string              // written to disqualify_reason on each
 *                                 //   matched row (max 200 chars)
 *     dry_run?: boolean           // returns the match count + a 20-row
 *                                 //   sample WITHOUT writing
 *     respect_manual_override?: boolean = true
 *                                 // when true, skip rows where
 *                                 //   icp_manual_override = 1 — those
 *                                 //   were curated by a human and
 *                                 //   shouldn't be overwritten by a
 *                                 //   broad keyword sweep
 *   }
 *
 * Returns:
 *   {
 *     ok: true,
 *     scanned: <total matches>,
 *     already_rejected: <skipped — already had status='rejected'>,
 *     manual_override_skipped: <skipped due to icp_manual_override>,
 *     disqualified: <newly set to status='rejected'>,
 *     sample: [{ id, name, domain, status, source_type, hit_field, snippet }]
 *   }
 */

// Fields the endpoint will accept for matching. Restricted to a
// known set so a bad request can't inject arbitrary column names
// into the WHERE clause.
const ALLOWED_FIELDS = new Set([
  "name", "description", "meta_description",
  "top_brand", "industry", "category", "tags",
  "eyewear_sample_titles", "eyewear_top_competitors",
  "installed_apps_names", "meta_keywords", "source_query",
]);

export async function POST(req: NextRequest) {
  try {
    const key = req.headers.get("x-admin-key");
    if (key !== "jaxy2026") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json() as {
      keywords?: string[];
      fields?: string[];
      reason?: string;
      dry_run?: boolean;
      respect_manual_override?: boolean;
    };

    const keywords = (body.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) {
      return NextResponse.json({ error: "keywords[] required" }, { status: 400 });
    }
    if (!body.reason || body.reason.trim().length === 0) {
      return NextResponse.json({ error: "reason required (written to disqualify_reason)" }, { status: 400 });
    }
    const reason = body.reason.trim().slice(0, 200);
    const dryRun = !!body.dry_run;
    const respectOverride = body.respect_manual_override !== false;  // default true

    // Default field set — name + description + meta_description +
    // top_brand catches the "Jewelry store" / "Sapphire & Sons
    // Jewelry" / "Fine Jewelry by Anna" pattern across the various
    // places a store identity can surface.
    const fields = (body.fields ?? [
      "name", "description", "meta_description",
      "top_brand", "industry", "tags",
    ]).filter((f) => ALLOWED_FIELDS.has(f));

    if (fields.length === 0) {
      return NextResponse.json({ error: "no valid fields" }, { status: 400 });
    }

    // Build WHERE: any keyword appearing in any field. SQLite LIKE
    // is case-insensitive for ASCII by default — sufficient for our
    // English-only keyword list.
    const fieldClauses = fields.flatMap((f) =>
      keywords.map(() => `LOWER(COALESCE(${f}, '')) LIKE ?`),
    );
    const whereMatch = `(${fieldClauses.join(" OR ")})`;
    const params = fields.flatMap(() => keywords.map((k) => `%${k}%`));

    // Total matches (regardless of current status / override)
    const totalMatch = (sqlite.prepare(
      `SELECT COUNT(*) AS c FROM companies WHERE ${whereMatch}`,
    ).get(...params) as { c: number }).c;

    // Already rejected — won't be touched
    const alreadyRejected = (sqlite.prepare(
      `SELECT COUNT(*) AS c FROM companies WHERE ${whereMatch} AND status = 'rejected'`,
    ).get(...params) as { c: number }).c;

    // Manual-override count — skipped when respect_manual_override=true
    const manualOverrideCount = respectOverride
      ? (sqlite.prepare(
          `SELECT COUNT(*) AS c FROM companies
            WHERE ${whereMatch}
              AND COALESCE(icp_manual_override, 0) = 1
              AND status != 'rejected'`,
        ).get(...params) as { c: number }).c
      : 0;

    // Sample 20 rows that would be disqualified — show WHICH field
    // matched + a 100-char snippet for spot-checking.
    const eligibleWhere = respectOverride
      ? `${whereMatch} AND status != 'rejected' AND COALESCE(icp_manual_override, 0) = 0`
      : `${whereMatch} AND status != 'rejected'`;
    const sampleRows = sqlite.prepare(
      `SELECT id, name, domain, status, source_type,
              substr(COALESCE(description, ''), 1, 120) AS description_snippet,
              substr(COALESCE(meta_description, ''), 1, 120) AS meta_snippet,
              top_brand
         FROM companies
        WHERE ${eligibleWhere}
        ORDER BY name
        LIMIT 20`,
    ).all(...params) as Array<Record<string, unknown>>;

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        total_matched: totalMatch,
        already_rejected: alreadyRejected,
        manual_override_skipped: manualOverrideCount,
        would_disqualify: totalMatch - alreadyRejected - manualOverrideCount,
        sample: sampleRows,
      });
    }

    // Apply the update in a transaction.
    const updateStmt = sqlite.prepare(
      `UPDATE companies
          SET status = 'rejected',
              disqualify_reason = ?,
              updated_at = datetime('now')
        WHERE ${eligibleWhere}`,
    );
    const result = updateStmt.run(reason, ...params);

    return NextResponse.json({
      ok: true,
      total_matched: totalMatch,
      already_rejected: alreadyRejected,
      manual_override_skipped: manualOverrideCount,
      disqualified: result.changes,
      reason,
      sample: sampleRows.slice(0, 10),  // smaller post-run sample
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: err.message, stack: err.stack?.split("\n").slice(0, 5) },
      { status: 500 },
    );
  }
}
