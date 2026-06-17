export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { pushCampaignToPhoneBurner } from "@/modules/sales/lib/phoneburner-sync";

/**
 * POST /api/v1/integrations/phoneburner/push-campaign
 *
 * Body: { campaignId: string, dryRun?: boolean }
 *
 * Pushes every undismissed lead in the campaign to PhoneBurner. The
 * campaign's PB folder is created on first push and cached on
 * campaigns.phoneburner_folder_id. Leads without a usable US phone
 * are skipped (returned in skipped_no_phone). Already-pushed leads
 * (phoneburner_contact_id stamped) are skipped to avoid duplicate
 * PB contact rows.
 *
 * dryRun=true returns the same shape but makes zero PB API calls.
 *
 * Auth: session-based (existing /api/v1 middleware gate). The Frame's
 * sales role implicitly has access by virtue of seeing campaigns at all.
 */
export async function POST(req: NextRequest) {
  let body: { campaignId?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!body.campaignId) {
    return NextResponse.json(
      { error: "campaignId required" },
      { status: 400 },
    );
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
