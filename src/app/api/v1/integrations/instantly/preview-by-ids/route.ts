export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

const MAX_IDS = 5000;

/**
 * POST /api/v1/integrations/instantly/preview-by-ids
 *
 * Source-agnostic version of the StoreLeads-only pushable preview. Takes
 * an explicit list of companyIds + a campaignId and returns the four
 * counters the UI needs to decide what to do next:
 *
 *   selected            — companyIds the caller passed (informational)
 *   eligible            — has email + not already in THIS campaign
 *   pushable            — eligible AND verified valid/catchall AND not
 *                          already on Instantly anywhere
 *   pendingVerification — eligible AND no NeverBounce result yet
 *   ruledOut            — eligible BUT verified invalid/disposable/etc
 *   alreadyOnInstantly  — has the same email already on Instantly in
 *                          some other campaign_leads row
 *   alreadyInCampaign   — already in THIS campaign's leads
 *
 * Body:
 *   { campaignId: string, companyIds: string[] }
 */
export async function POST(req: NextRequest) {
  let body: { campaignId?: string; companyIds?: string[] } = {};
  try { body = await req.json(); } catch { /* ok */ }

  if (!body.campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }
  const ids = Array.isArray(body.companyIds) ? body.companyIds.slice(0, MAX_IDS) : [];
  if (ids.length === 0) {
    return NextResponse.json({
      selected: 0, eligible: 0, pushable: 0, pendingVerification: 0,
      ruledOut: 0, alreadyOnInstantly: 0, alreadyInCampaign: 0, sample: [],
    });
  }

  const idPh = ids.map(() => "?").join(",");

  // Each counter is a single SQL — share the FROM/WHERE as a CTE so the
  // SQLite query planner can hash-join the candidate IDs once. Counters
  // are mutually NON-exclusive (a row can be "alreadyOnInstantly" AND
  // "ruledOut" if it was previously pushed THEN ruled bad later) — the
  // UI shows them separately.
  const baseWhere = `WHERE c.id IN (${idPh})`;

  const selected = ids.length;
  const eligible = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND c.email IS NOT NULL AND TRIM(c.email) != ''
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                       WHERE cl.campaign_id = ? AND cl.company_id = c.id)`,
  ).get(...ids, body.campaignId) as { c: number }).c;

  const pushable = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND c.email IS NOT NULL AND TRIM(c.email) != ''
       AND c.email_verification_status IN ('valid','catchall')
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                       WHERE cl.campaign_id = ? AND cl.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                       WHERE LOWER(cl2.email) = LOWER(c.email)
                         AND cl2.instantly_lead_id IS NOT NULL)`,
  ).get(...ids, body.campaignId) as { c: number }).c;

  // "Pending" includes prior 'error' rows so they get one more shot —
  // matches verify-by-ids' candidate filter so the count + the actual
  // verify pass stay aligned.
  const pendingVerification = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND c.email IS NOT NULL AND TRIM(c.email) != ''
       AND (c.email_verification_status IS NULL OR c.email_verification_status = 'error')
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                       WHERE cl.campaign_id = ? AND cl.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                       WHERE LOWER(cl2.email) = LOWER(c.email)
                         AND cl2.instantly_lead_id IS NOT NULL)`,
  ).get(...ids, body.campaignId) as { c: number }).c;

  const ruledOut = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND c.email_verification_status IN ('invalid','disposable','unknown','error')`,
  ).get(...ids) as { c: number }).c;

  const alreadyOnInstantly = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND EXISTS (SELECT 1 FROM campaign_leads cl2
                   WHERE LOWER(cl2.email) = LOWER(c.email)
                     AND cl2.instantly_lead_id IS NOT NULL)`,
  ).get(...ids) as { c: number }).c;

  const alreadyInCampaign = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
     ${baseWhere}
       AND EXISTS (SELECT 1 FROM campaign_leads cl
                   WHERE cl.campaign_id = ? AND cl.company_id = c.id)`,
  ).get(...ids, body.campaignId) as { c: number }).c;

  // Sample 20 push-eligible rows for the operator to spot-check.
  const sample = sqlite.prepare(
    `SELECT c.id, c.name, c.domain, c.email, c.city, c.state, c.country,
            c.icp_tier, c.icp_score, c.email_verification_status, c.source_type
       FROM companies c
       ${baseWhere}
         AND c.email IS NOT NULL AND TRIM(c.email) != ''
         AND c.email_verification_status IN ('valid','catchall')
         AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                         WHERE cl.campaign_id = ? AND cl.company_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                         WHERE LOWER(cl2.email) = LOWER(c.email)
                           AND cl2.instantly_lead_id IS NOT NULL)
      ORDER BY COALESCE(c.icp_score, -1) DESC
      LIMIT 20`,
  ).all(...ids, body.campaignId) as Array<Record<string, unknown>>;

  return NextResponse.json({
    selected, eligible, pushable, pendingVerification,
    ruledOut, alreadyOnInstantly, alreadyInCampaign, sample,
  });
}
