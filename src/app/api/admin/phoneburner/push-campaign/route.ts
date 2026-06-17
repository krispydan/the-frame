export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { pushCampaignToPhoneBurner } from "@/modules/sales/lib/phoneburner-sync";

/**
 * POST /api/admin/phoneburner/push-campaign
 *
 * Admin-keyed mirror of /api/v1/integrations/phoneburner/push-campaign
 * (which sits behind login-session middleware). Same per-campaign push
 * logic. Use it to trigger pushes from CLI / SSH instead of the
 * browser session — useful for the initial backfill of existing
 * email-sourced campaigns into PhoneBurner.
 *
 * Body: { campaignId: string, dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { campaignId?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!body.campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }

  try {
    const result = await pushCampaignToPhoneBurner(body.campaignId, {
      dryRun: body.dryRun === true,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
