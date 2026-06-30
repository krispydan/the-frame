export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/cohort-needing-phone-enrichment
 *
 * Returns the count + tier distribution of companies that are:
 *   - in any Instantly campaign (campaign_leads with instantly_lead_id)
 *   - have NO row in company_phones (no phone for Sandra to call)
 *   - have at least city + state OR a non-empty address (Apify needs
 *     this to match the right Google Maps place)
 *
 * Used to size the Apify Google Maps enrichment batch before running.
 *
 * Optional ?status=qualified_lead,interested filters to a subset.
 * Optional ?tier=A,B filters by ICP tier.
 *
 * Auth: x-admin-key
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusCsv = url.searchParams.get("status");
  const tierCsv = url.searchParams.get("tier");

  const statuses = statusCsv
    ? statusCsv.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const tiers = tierCsv
    ? tierCsv.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  const where: string[] = [
    // In any Instantly campaign
    `EXISTS (
      SELECT 1 FROM campaign_leads cl
      WHERE cl.company_id = c.id
        AND cl.instantly_lead_id IS NOT NULL
    )`,
    // No phone yet
    `NOT EXISTS (
      SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
    )`,
    // Enough address info for Google Maps disambiguation
    `(
      (c.city IS NOT NULL AND TRIM(c.city) <> '' AND
       c.state IS NOT NULL AND TRIM(c.state) <> '')
      OR (c.address IS NOT NULL AND TRIM(c.address) <> '')
    )`,
    // EXCLUDE leads in any dead-end state. The hub-and-spoke status
    // sync rolls Instantly "not interested" replies into
    // companies.status = 'not_interested', so this single filter
    // covers Instantly-replied-no leads plus anyone manually
    // marked as a no-go.
    //   - not_interested  : replied "not interested" in Instantly
    //                       OR manually marked
    //   - ghosted         : stopped responding after engagement
    //   - not_qualified   : ICP/manual disqualified
    //   - rejected        : hard reject
    //   - customer        : already a customer, don't cold-call
    `c.status NOT IN ('not_interested', 'ghosted', 'not_qualified', 'rejected', 'customer')`,
  ];
  const params: unknown[] = [];
  if (statuses && statuses.length > 0) {
    where.push(
      `c.status IN (${statuses.map(() => "?").join(",")})`,
    );
    params.push(...statuses);
  }
  if (tiers && tiers.length > 0) {
    where.push(
      `c.icp_tier IN (${tiers.map(() => "?").join(",")})`,
    );
    params.push(...tiers);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const total = (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM companies c ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const byTier = sqlite
    .prepare(
      `SELECT COALESCE(c.icp_tier, '(unset)') AS tier, COUNT(*) AS n
         FROM companies c ${whereSql}
        GROUP BY c.icp_tier
        ORDER BY tier`,
    )
    .all(...params);

  const byStatus = sqlite
    .prepare(
      `SELECT COALESCE(c.status, '(unset)') AS status, COUNT(*) AS n
         FROM companies c ${whereSql}
        GROUP BY c.status
        ORDER BY n DESC`,
    )
    .all(...params);

  // 10 highest-ICP-score samples for spot-check
  const sample = sqlite
    .prepare(
      `SELECT c.id, c.name, c.city, c.state, c.icp_tier, c.icp_score,
              c.status, c.domain, c.website,
              (SELECT email FROM contacts ct WHERE ct.company_id = c.id
                ORDER BY is_primary DESC, created_at ASC LIMIT 1) AS primary_email
         FROM companies c ${whereSql}
        ORDER BY c.icp_score DESC NULLS LAST
        LIMIT 10`,
    )
    .all(...params);

  return NextResponse.json({
    ok: true,
    total,
    by_tier: byTier,
    by_status: byStatus,
    sample,
    filters_applied: {
      status: statuses,
      tier: tiers,
    },
    note: "Each company in this cohort can be enriched via Apify Google Maps in batch. Estimated cost: ~$2-3 per 1000 lookups.",
  });
}
