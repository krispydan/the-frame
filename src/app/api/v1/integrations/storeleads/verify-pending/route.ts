export const dynamic = "force-dynamic";
// Up to 50 emails × ~3s NeverBounce / 5 concurrent ≈ 30s. 120s ceiling
// keeps us well under Cloudflare's ~100s edge timeout per request.
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { verifyProspectEmails } from "@/modules/sales/lib/neverbounce/verify-prospects";

const MAX_PER_CALL = 50;

/**
 * POST /api/v1/integrations/storeleads/verify-pending
 *
 * Pulls the push-eligible StoreLeads-sourced rows for the chosen
 * campaign/tiers EXCLUDING already-verified rows, verifies them via
 * NeverBounce with bounded concurrency, and writes the result back.
 *
 * Capped at 50 emails per call so the wall time stays under
 * Cloudflare's 100s edge — the UI loops until `remaining` is 0.
 *
 * Body:
 *   { campaignId: string, tiers?: ["A","B"], limit?: 50 }
 */
export async function POST(req: NextRequest) {
  let body: { campaignId?: string; tiers?: string[]; limit?: number } = {};
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
  const limit = Math.max(1, Math.min(MAX_PER_CALL, body.limit ?? MAX_PER_CALL));
  const tierPh = tiers.map(() => "?").join(",");

  const pending = sqlite
    .prepare(
      `SELECT c.id
         FROM companies c
        WHERE c.source_type = 'storeleads'
          AND c.email IS NOT NULL AND TRIM(c.email) != ''
          AND c.icp_tier IN (${tierPh})
          AND c.email_verification_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM campaign_leads cl
             WHERE cl.campaign_id = ? AND cl.company_id = c.id
          )
        ORDER BY COALESCE(c.icp_score, -1) DESC
        LIMIT ?`,
    )
    .all(...tiers, body.campaignId, limit) as Array<{ id: string }>;

  const remainingBefore = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM companies c
        WHERE c.source_type = 'storeleads'
          AND c.email IS NOT NULL AND TRIM(c.email) != ''
          AND c.icp_tier IN (${tierPh})
          AND c.email_verification_status IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM campaign_leads cl
             WHERE cl.campaign_id = ? AND cl.company_id = c.id
          )`,
    )
    .get(...tiers, body.campaignId) as { c: number }).c;

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true,
      verified: 0,
      remaining: remainingBefore,
      stats: null,
    });
  }

  try {
    const stats = await verifyProspectEmails({
      companyIds: pending.map((r) => r.id),
    });
    const remaining = Math.max(0, remainingBefore - pending.length);
    return NextResponse.json({
      ok: true,
      verified: pending.length,
      remaining,
      stats,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
