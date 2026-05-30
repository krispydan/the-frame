export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/integrations/storeleads/instantly-pushable?campaignId=…
 *
 * Counts StoreLeads-sourced prospects ready to be pushed to a specific
 * Instantly campaign:
 *   - source_type = 'storeleads'
 *   - has a usable email (not null/blank)
 *   - icp_tier IN ('A','B') (configurable via the `tiers` query param)
 *   - NOT already in campaign_leads for the chosen campaign
 *
 * Also returns the per-tier breakdown and the first 20 sample rows for
 * a preview before the operator clicks Push.
 *
 * Query params:
 *   campaignId — required; our local campaigns.id
 *   tiers      — comma-separated, defaults to "A,B"
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const campaignId = url.searchParams.get("campaignId");
  const tiersRaw = url.searchParams.get("tiers") ?? "A,B";
  const tiers = tiersRaw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => ["A", "B", "C", "D"].includes(t));
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }
  if (tiers.length === 0) {
    return NextResponse.json({ error: "tiers must include at least one of A,B,C,D" }, { status: 400 });
  }

  const tierPh = tiers.map(() => "?").join(",");
  const sqlBase = `
    FROM companies c
    WHERE c.source_type = 'storeleads'
      AND c.email IS NOT NULL AND TRIM(c.email) != ''
      AND c.icp_tier IN (${tierPh})
      AND NOT EXISTS (
        SELECT 1 FROM campaign_leads cl
        WHERE cl.campaign_id = ? AND cl.company_id = c.id
      )
  `;

  // Bind args repeat per query — sqlite prepared statements re-bind per call.
  const bind = [...tiers, campaignId];

  // Total candidates (before NeverBounce filter). Surfaces "how many
  // are eligible by score but blocked by verification" vs the push count.
  const totalRow = sqlite
    .prepare(`SELECT COUNT(*) AS c ${sqlBase}`)
    .get(...bind) as { c: number };

  // Push-eligible = NeverBounce-verified 'valid' or 'catchall'. This is
  // what the Push button actually moves.
  const pushable = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c ${sqlBase} AND c.email_verification_status IN ('valid','catchall')`,
    )
    .get(...bind) as { c: number }).c;

  // Still need verification.
  const pendingVerification = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c ${sqlBase} AND c.email_verification_status IS NULL`,
    )
    .get(...bind) as { c: number }).c;

  // Verified as bad — surfaces what NeverBounce ruled out.
  const ruledOut = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c ${sqlBase} AND c.email_verification_status IN ('invalid','disposable','unknown','error')`,
    )
    .get(...bind) as { c: number }).c;

  const perTier = sqlite
    .prepare(`SELECT c.icp_tier AS tier, COUNT(*) AS c ${sqlBase} GROUP BY c.icp_tier`)
    .all(...bind) as Array<{ tier: string; c: number }>;

  const sample = sqlite
    .prepare(
      `SELECT c.id, c.name, c.domain, c.email, c.city, c.state, c.country,
              c.icp_tier, c.icp_score, c.estimated_yearly_sales_cents,
              c.email_verification_status
       ${sqlBase}
       ORDER BY COALESCE(c.icp_score, -1) DESC, COALESCE(c.estimated_yearly_sales_cents, -1) DESC
       LIMIT 20`,
    )
    .all(...bind) as Array<Record<string, unknown>>;

  return NextResponse.json({
    campaignId,
    tiers,
    total: totalRow.c,
    pushable,
    pendingVerification,
    ruledOut,
    perTier,
    sample,
  });
}
