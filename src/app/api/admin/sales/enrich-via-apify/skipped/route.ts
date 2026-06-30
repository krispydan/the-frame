export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/enrich-via-apify/skipped
 *
 * Returns the companies the Apify Google Maps enrichment attempted
 * but couldn't match with high confidence. Each row was stamped with
 * `gmaps_skip_reason` so the operator can decide whether to:
 *
 *   - Fix the company name/city and re-run with `force=true`
 *   - Mark it as no_qualified manually
 *   - Leave it alone (e.g., truly has no Google Maps listing)
 *
 * Skip-reason buckets returned in the response:
 *   - "no_match"                : Apify returned 0 places for the search
 *   - "name_similarity_too_low" : returned a place but name didn't match
 *   - "city_mismatch"           : name matched but city was wrong
 *
 * Optional query params:
 *   ?reason=no_match,city_mismatch   filter to specific buckets
 *   ?limit=N                          page size (default 100, max 500)
 *   ?offset=N                         pagination offset
 *
 * POST /api/admin/sales/enrich-via-apify/skipped/clear
 *   Clears the gmaps_enrichment_attempted_at + gmaps_skip_reason for
 *   the specified company IDs so they re-enter the enrichment pool.
 *
 * Auth: x-admin-key
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const reasonCsv = url.searchParams.get("reason");
  const reasons = reasonCsv
    ? reasonCsv.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const limit = Math.min(
    500,
    Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100),
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") || "0", 10) || 0,
  );

  const where: string[] = [
    `c.gmaps_skip_reason IS NOT NULL`,
    // Don't re-surface companies that have since been matched / closed
    `c.google_place_id IS NULL`,
  ];
  const params: unknown[] = [];
  if (reasons && reasons.length > 0) {
    // Use LIKE so we match `city_mismatch (place=foo, company=bar)` too
    const ors = reasons.map(() => `c.gmaps_skip_reason LIKE ?`).join(" OR ");
    where.push(`(${ors})`);
    params.push(...reasons.map((r) => `${r}%`));
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const total = (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM companies c ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const reasonBuckets = sqlite
    .prepare(
      `SELECT
         CASE
           WHEN c.gmaps_skip_reason LIKE 'no_match%'              THEN 'no_match'
           WHEN c.gmaps_skip_reason LIKE 'name_similarity_too_low%' THEN 'name_similarity_too_low'
           WHEN c.gmaps_skip_reason LIKE 'city_mismatch%'         THEN 'city_mismatch'
           ELSE 'other'
         END AS bucket,
         COUNT(*) AS n
       FROM companies c
       WHERE c.gmaps_skip_reason IS NOT NULL
         AND c.google_place_id IS NULL
       GROUP BY bucket
       ORDER BY n DESC`,
    )
    .all();

  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.city, c.state, c.icp_tier, c.icp_score,
              c.status, c.domain, c.website,
              c.gmaps_skip_reason,
              c.gmaps_enrichment_attempted_at,
              (SELECT email FROM contacts ct WHERE ct.company_id = c.id
                ORDER BY is_primary DESC, created_at ASC LIMIT 1) AS primary_email
         FROM companies c ${whereSql}
        ORDER BY c.icp_score DESC NULLS LAST
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return NextResponse.json({
    ok: true,
    total,
    reason_buckets: reasonBuckets,
    page_size: limit,
    page_offset: offset,
    rows,
    note: "Reasons explained — no_match: Apify returned 0 places. name_similarity_too_low: returned a place but the name didn't fuzzy-match the company. city_mismatch: name matched but the city in Google Maps differs (could be a relocation, a duplicate listing, or a real mismatch).",
  });
}

/**
 * POST /api/admin/sales/enrich-via-apify/skipped/clear
 *
 * Clears the skip stamps for the given company IDs so they re-enter
 * the enrichment pool on the next enrich-via-apify call.
 *
 * Body: { company_ids: string[] }
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { company_ids?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }
  const ids = Array.isArray(body.company_ids)
    ? body.company_ids.filter((x) => typeof x === "string" && x.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { ok: false, error: "company_ids[] required" },
      { status: 400 },
    );
  }

  const stmt = sqlite.prepare(
    `UPDATE companies
        SET gmaps_enrichment_attempted_at = NULL,
            gmaps_skip_reason = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  );
  let cleared = 0;
  const txn = sqlite.transaction(() => {
    for (const id of ids) {
      const r = stmt.run(id);
      if (r.changes > 0) cleared++;
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    cleared,
    requested: ids.length,
  });
}
