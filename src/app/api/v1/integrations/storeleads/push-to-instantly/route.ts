export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { handleSyncRequest } from "@/modules/sales/lib/instantly-sync";

/**
 * POST /api/v1/integrations/storeleads/push-to-instantly
 *
 * Body:
 *   {
 *     campaignId: string,   // our local campaigns.id (must already have
 *                           // an instantly_campaign_id)
 *     tiers?: ["A","B"],    // ICP tiers to include; default A+B
 *     limit?: number,       // cap on rows to push this run (default 500)
 *     dryRun?: false,
 *   }
 *
 * Two phases:
 *   1. Insert a campaign_leads row for each matching StoreLeads-sourced
 *      prospect (email + score in the chosen tiers + no row already for
 *      this campaign). The unique index on (campaign_id, company_id)
 *      makes re-runs safe.
 *   2. Call handleSyncRequest() which runs pushCampaigns() — that picks
 *      up the new queued rows and ships them to Instantly.
 *
 * Returns the per-step counts.
 */
export async function POST(req: NextRequest) {
  let body: {
    campaignId?: string;
    tiers?: string[];
    limit?: number;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body fine
  }
  if (!body.campaignId) {
    return NextResponse.json({ ok: false, error: "campaignId required" }, { status: 400 });
  }
  const tiers = (body.tiers && body.tiers.length > 0 ? body.tiers : ["A", "B"])
    .map((t) => t.trim().toUpperCase())
    .filter((t) => ["A", "B", "C", "D"].includes(t));
  if (tiers.length === 0) {
    return NextResponse.json(
      { ok: false, error: "tiers must include at least one of A,B,C,D" },
      { status: 400 },
    );
  }
  const limit = Math.max(1, Math.min(5000, body.limit ?? 500));

  const campaign = sqlite
    .prepare(
      `SELECT id, name, instantly_campaign_id FROM campaigns WHERE id = ? LIMIT 1`,
    )
    .get(body.campaignId) as { id: string; name: string; instantly_campaign_id: string | null } | undefined;
  if (!campaign) {
    return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
  }
  if (!campaign.instantly_campaign_id) {
    return NextResponse.json(
      {
        ok: false,
        error: "Campaign is not yet synced to Instantly — push the campaign first via the sales pipeline UI.",
      },
      { status: 400 },
    );
  }

  const tierPh = tiers.map(() => "?").join(",");
  // SL Phase 7.5: hard filter — only NeverBounce-verified 'valid' or
  // 'catchall' rows are eligible to push. Unverified or
  // invalid/disposable/unknown/error rows stay in the CRM but don't
  // ship to Instantly. The UI runs /verify-pending first (an explicit
  // step in the Push card) so unverified rows get checked before the
  // push button enables.
  const candidates = sqlite
    .prepare(
      `SELECT c.id, c.name, c.email, c.icp_tier
         FROM companies c
        WHERE c.source_type = 'storeleads'
          AND c.email IS NOT NULL AND TRIM(c.email) != ''
          AND c.icp_tier IN (${tierPh})
          AND c.email_verification_status IN ('valid','catchall')
          AND NOT EXISTS (
            SELECT 1 FROM campaign_leads cl
             WHERE cl.campaign_id = ? AND cl.company_id = c.id
          )
        ORDER BY COALESCE(c.icp_score, -1) DESC
        LIMIT ?`,
    )
    .all(...tiers, campaign.id, limit) as Array<{
      id: string;
      name: string;
      email: string;
      icp_tier: string;
    }>;

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      campaign: { id: campaign.id, name: campaign.name, instantlyCampaignId: campaign.instantly_campaign_id },
      tiers,
      candidateCount: candidates.length,
      preview: candidates.slice(0, 20),
    });
  }

  // Phase 1 — insert queued campaign_leads rows. The unique index makes
  // a concurrent caller's INSERT a no-op (ignore that case).
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

  // Phase 2 — kick the Instantly sync to ship the queued rows.
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
    tiers,
    candidateCount: candidates.length,
    inserted,
    instantly: syncResult,
  });
}
