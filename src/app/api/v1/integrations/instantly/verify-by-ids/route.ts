export const dynamic = "force-dynamic";
// Up to 50 emails per batch × ~3s NeverBounce / 5 concurrent ≈ 30s.
// 120s ceiling keeps us under Cloudflare's edge timeout per request.
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { verifyProspectEmails } from "@/modules/sales/lib/neverbounce/verify-prospects";

const MAX_PER_CALL = 50;
const MAX_IDS = 5000;

/**
 * POST /api/v1/integrations/instantly/verify-by-ids
 *
 * Source-agnostic verify-pending. Takes an explicit list of companyIds
 * and verifies the first N (default 50) that need it. Loop the endpoint
 * client-side until `remaining` hits 0.
 *
 * Body:
 *   { companyIds: string[], campaignId?: string, limit?: 50 }
 *
 * The optional campaignId is used purely as a filter to skip rows
 * already in that campaign — same definition of "pending" as the
 * preview endpoint uses, so counters stay consistent.
 */
export async function POST(req: NextRequest) {
  let body: { companyIds?: string[]; campaignId?: string; limit?: number } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const ids = Array.isArray(body.companyIds) ? body.companyIds.slice(0, MAX_IDS) : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "companyIds required" }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(MAX_PER_CALL, body.limit ?? MAX_PER_CALL));

  const idPh = ids.map(() => "?").join(",");
  const campaignGuard = body.campaignId
    ? `AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                       WHERE cl.campaign_id = ? AND cl.company_id = c.id)`
    : "";
  const args: unknown[] = [...ids];
  if (body.campaignId) args.push(body.campaignId);

  // Order by score so the "verify the hottest leads first" intuition wins
  // when the caller didn't pre-sort.
  // "Pending" = never verified, OR last attempt errored (transient NeverBounce
  // failure worth retrying). Real verdicts (valid/catchall/unknown/invalid/
  // disposable) are paid for once and trusted forever — see
  // verify-prospects.ts for the policy.
  const pending = sqlite.prepare(
    `SELECT c.id FROM companies c
      WHERE c.id IN (${idPh})
        AND c.email IS NOT NULL AND TRIM(c.email) != ''
        AND (c.email_verification_status IS NULL OR c.email_verification_status = 'error')
        ${campaignGuard}
      ORDER BY COALESCE(c.icp_score, -1) DESC
      LIMIT ?`,
  ).all(...args, limit) as Array<{ id: string }>;

  const remainingBefore = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c
      WHERE c.id IN (${idPh})
        AND c.email IS NOT NULL AND TRIM(c.email) != ''
        AND (c.email_verification_status IS NULL OR c.email_verification_status = 'error')
        ${campaignGuard}`,
  ).get(...args) as { c: number }).c;

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true, verified: 0, remaining: remainingBefore, stats: null,
    });
  }

  try {
    const stats = await verifyProspectEmails({ companyIds: pending.map((r) => r.id) });
    const remaining = Math.max(0, remainingBefore - pending.length);
    return NextResponse.json({ ok: true, verified: pending.length, remaining, stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
