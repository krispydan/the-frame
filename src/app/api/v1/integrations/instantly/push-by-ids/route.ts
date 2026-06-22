export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { handleSyncRequest } from "@/modules/sales/lib/instantly-sync";

const MAX_IDS = 5000;

// Email is canonical in contacts now, not on companies. Centralized
// SQL fragments for readability in the heavy push query below.
const HAS_EMAIL_EXISTS = `EXISTS (
  SELECT 1 FROM contacts ct
  WHERE ct.company_id = c.id
    AND TRIM(COALESCE(ct.email, '')) <> ''
)`;
const PRIMARY_EMAIL_SUBQ = `(
  SELECT ct.email FROM contacts ct
  WHERE ct.company_id = c.id
    AND TRIM(COALESCE(ct.email, '')) <> ''
  ORDER BY ct.is_primary DESC, ct.created_at ASC
  LIMIT 1
)`;

/**
 * POST /api/v1/integrations/instantly/push-by-ids
 *
 * Source-agnostic push. Takes an explicit list of companyIds + a
 * campaignId, applies the same hard filters as the StoreLeads-specific
 * predecessor (verified valid/catchall, not already in this campaign,
 * not already on Instantly anywhere), inserts campaign_leads rows for
 * the survivors, and triggers the existing Instantly sync to ship them.
 *
 * Body:
 *   { campaignId: string, companyIds: string[], dryRun?: false }
 *
 * Returns:
 *   { ok, campaign, candidateCount, inserted, instantly }
 */
export async function POST(req: NextRequest) {
  let body: { campaignId?: string; companyIds?: string[]; dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* ok */ }

  if (!body.campaignId) {
    return NextResponse.json({ ok: false, error: "campaignId required" }, { status: 400 });
  }
  const ids = Array.isArray(body.companyIds) ? body.companyIds.slice(0, MAX_IDS) : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "companyIds required" }, { status: 400 });
  }

  const campaign = sqlite.prepare(
    `SELECT id, name, instantly_campaign_id FROM campaigns WHERE id = ? LIMIT 1`,
  ).get(body.campaignId) as { id: string; name: string; instantly_campaign_id: string | null } | undefined;
  if (!campaign) {
    return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
  }
  if (!campaign.instantly_campaign_id) {
    return NextResponse.json(
      {
        ok: false,
        error: "Campaign is not synced to Instantly. Click Sync campaigns on /settings/integrations first.",
      },
      { status: 400 },
    );
  }

  const idPh = ids.map(() => "?").join(",");
  const candidates = sqlite.prepare(
    `SELECT c.id, c.name, ${PRIMARY_EMAIL_SUBQ} AS email, c.icp_tier
       FROM companies c
      WHERE c.id IN (${idPh})
        AND ${HAS_EMAIL_EXISTS}
        AND c.email_verification_status IN ('valid','catchall')
        AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                        WHERE cl.campaign_id = ? AND cl.company_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                        WHERE LOWER(cl2.email) = LOWER(${PRIMARY_EMAIL_SUBQ})
                          AND cl2.instantly_lead_id IS NOT NULL)
      ORDER BY COALESCE(c.icp_score, -1) DESC`,
  ).all(...ids, campaign.id) as Array<{
    id: string; name: string; email: string; icp_tier: string | null;
  }>;

  if (body.dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true,
      campaign: { id: campaign.id, name: campaign.name, instantlyCampaignId: campaign.instantly_campaign_id },
      candidateCount: candidates.length,
      preview: candidates.slice(0, 20),
    });
  }

  // Insert queued campaign_leads. INSERT OR IGNORE handles the unique
  // index on (campaign_id, company_id) for any race.
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO campaign_leads
       (id, campaign_id, company_id, contact_id, email, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'queued', datetime('now'))`,
  );
  let inserted = 0;
  const txn = sqlite.transaction(() => {
    for (const c of candidates) {
      const res = insert.run(crypto.randomUUID(), campaign.id, c.id, c.email);
      if (res.changes > 0) inserted++;
    }
  });
  txn();

  let syncResult;
  try {
    syncResult = await handleSyncRequest();
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `Lead rows inserted (${inserted}) but Instantly sync failed: ${e instanceof Error ? e.message : String(e)}`,
        inserted,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    campaign: { id: campaign.id, name: campaign.name, instantlyCampaignId: campaign.instantly_campaign_id },
    candidateCount: candidates.length,
    inserted,
    instantly: syncResult,
  });
}
