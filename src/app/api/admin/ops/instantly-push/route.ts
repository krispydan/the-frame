export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { pushCompaniesToCampaign } from "@/modules/sales/lib/instantly-push";
import { verifyProspectEmails } from "@/modules/sales/lib/neverbounce/verify-prospects";

/**
 * Verify and push an explicit list of companies to a campaign.
 *
 * POST ?confirm=1 { action:'verify', companyIds[], verifyLimit? }  → NeverBounce (spends)
 * POST ?confirm=1 { action:'push',   campaignId, companyIds[], dryRun? } → queue + ship
 *
 * Two separate actions on purpose. Verification is reversible and costs money;
 * pushing is irreversible and sends mail to real businesses. Collapsing them
 * into one call would mean a single mistyped request could do both.
 *
 * Verification is chunked (default 100) — a request killed past the ~100s
 * external limit still spends every credit it used.
 */
export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json({ error: "add ?confirm=1" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; campaignId?: string; companyIds?: string[];
    dryRun?: boolean; verifyLimit?: number; concurrency?: number; skipSync?: boolean;
  };
  const ids = Array.isArray(body.companyIds) ? body.companyIds : [];
  if (ids.length === 0) return NextResponse.json({ error: "companyIds[] required" }, { status: 400 });

  if (body.action === "verify") {
    const limit = Math.min(Number(body.verifyLimit) || 100, 500);
    const stats = await verifyProspectEmails({
      companyIds: ids.slice(0, limit),
      concurrency: Math.min(Number(body.concurrency) || 5, 10),
    });
    return NextResponse.json({ ok: true, submitted: Math.min(ids.length, limit), remaining: Math.max(0, ids.length - limit), stats });
  }

  if (body.action === "push") {
    if (!body.campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
    try {
      const res = await pushCompaniesToCampaign({
        campaignId: body.campaignId, companyIds: ids,
        dryRun: body.dryRun === true, skipSync: body.skipSync === true,
      });
      return NextResponse.json(res, { status: res.ok ? 200 : 502 });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  // Fail closed — never let an unrecognised action reach the sending path.
  return NextResponse.json(
    { error: `unknown action '${body.action ?? "(none)"}' — this endpoint supports: verify, push` },
    { status: 400 },
  );
}
