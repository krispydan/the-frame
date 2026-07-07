export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { renderEmailHtml } from "@/modules/marketing/lib/render-email";
import { campaignRowToData } from "@/modules/marketing/lib/campaign-render-data";
import {
  isOmnisendConfigured,
  importTemplate,
  createCampaign,
  sendCampaign,
} from "@/modules/marketing/lib/omnisend-client";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/push-omnisend
 *
 * Renders the campaign's email HTML, imports it as an Omnisend template,
 * and creates the Omnisend campaign — replacing the manual download-HTML →
 * paste-into-Omnisend step.
 *
 * Body (all optional):
 *   { schedule?: boolean }   also trigger send/scheduling. Default FALSE:
 *                            the campaign lands in Omnisend as a draft with
 *                            audience/schedule finalized there — safest
 *                            default while trust in the pipeline builds.
 *
 * Flag-gated: 409 with a clear message until OMNISEND_API_KEY is configured.
 * Idempotent-ish: re-push imports a fresh template + creates a NEW Omnisend
 * campaign (Omnisend campaigns are cheap drafts); the latest id is stored on
 * the row (omnisend_campaign_id).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isOmnisendConfigured()) {
    return NextResponse.json(
      { error: "Omnisend isn't connected yet — add OMNISEND_API_KEY (env) or the omnisend_api_key setting, then retry." },
      { status: 409 },
    );
  }

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  if (!row.subject) {
    return NextResponse.json({ error: "Campaign has no subject — generate copy first." }, { status: 400 });
  }

  let body: { schedule?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  const html = renderEmailHtml(campaignRowToData(row));
  const label = row.name || row.subject || id;

  const tpl = await importTemplate(`the-frame — ${label}`, html);
  if (!tpl.ok) return NextResponse.json({ error: tpl.error }, { status: 502 });

  const scheduledAt =
    body.schedule && row.scheduledDate
      ? // Send at 9am PT on the scheduled date (17:00 UTC covers PST/PDT well enough for v1).
        `${row.scheduledDate}T17:00:00Z`
      : null;

  const created = await createCampaign({
    name: label,
    subject: row.subject,
    preheader: row.preheader,
    senderName: "Jaxy",
    templateID: tpl.data.templateID,
    scheduledAt,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 502 });

  let sendTriggered = false;
  if (body.schedule && scheduledAt) {
    const sent = await sendCampaign(created.data.campaignID);
    sendTriggered = sent.ok;
    if (!sent.ok) {
      // Campaign exists as a draft — surface the partial success rather
      // than pretending the whole push failed.
      sqlite
        .prepare("UPDATE marketing_email_campaigns SET omnisend_campaign_id = ? WHERE id = ?")
        .run(created.data.campaignID, id);
      return NextResponse.json({
        ok: true,
        omnisendCampaignId: created.data.campaignID,
        scheduled: false,
        warning: `Campaign created in Omnisend as a draft, but scheduling failed: ${sent.error}`,
      });
    }
  }

  sqlite
    .prepare(
      `UPDATE marketing_email_campaigns
         SET omnisend_campaign_id = ?,
             status = CASE WHEN status IN ('design_review','copywriting','photography') THEN 'scheduled' ELSE status END,
             updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(created.data.campaignID, id);

  return NextResponse.json({
    ok: true,
    omnisendCampaignId: created.data.campaignID,
    scheduled: sendTriggered,
  });
}
