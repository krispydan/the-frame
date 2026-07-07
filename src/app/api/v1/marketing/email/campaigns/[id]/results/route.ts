export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns, emailSendResults } from "@/modules/marketing/schema";
import { eq, desc } from "drizzle-orm";

/**
 * Send-results capture — the learning-loop input.
 *
 * The email itself is sent from Omnisend / Faire, so results (recipients,
 * opens, clicks) live in those dashboards. This endpoint lets the operator
 * record them against the campaign in ~20 seconds, which (a) completes the
 * campaign lifecycle (status → analyzed) and (b) gives the strategy engine
 * real performance data to weight future plans with.
 *
 * GET  → { results: [...] }  (newest first)
 * POST → { platform, sentAt?, recipients?, opens?, clicks?, notes? }
 *        Inserts a result row. Repeat sends (e.g. Omnisend + Faire for the
 *        same campaign) are separate rows. Auto-advances campaign status
 *        sent → analyzed once results exist.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const results = await db
    .select()
    .from(emailSendResults)
    .where(eq(emailSendResults.campaignId, id))
    .orderBy(desc(emailSendResults.createdAt));
  return NextResponse.json({ results });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [campaign] = await db
    .select({ id: emailCampaigns.id, status: emailCampaigns.status })
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  let body: {
    platform?: string;
    sentAt?: string;
    recipients?: number;
    opens?: number;
    clicks?: number;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  if (body.platform !== "omnisend" && body.platform !== "faire") {
    return NextResponse.json({ error: "platform must be 'omnisend' or 'faire'" }, { status: 400 });
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

  const [inserted] = await db
    .insert(emailSendResults)
    .values({
      campaignId: id,
      platform: body.platform,
      sentAt: body.sentAt || null,
      recipients: num(body.recipients),
      opens: num(body.opens),
      clicks: num(body.clicks),
      notes: body.notes?.slice(0, 2000) || null,
    })
    .returning();

  // Lifecycle: recording results is what "analyzed" means. Only advance
  // from sent/scheduled — never yank a campaign backwards or skip the
  // operator's earlier stages.
  let statusAfter = campaign.status;
  if (campaign.status === "sent" || campaign.status === "scheduled") {
    await db
      .update(emailCampaigns)
      .set({ status: "analyzed" })
      .where(eq(emailCampaigns.id, id));
    statusAfter = "analyzed";
  }

  // statusAfter tells the client the REAL post-insert status — the editor
  // must not assume "analyzed" (a draft campaign stays draft).
  return NextResponse.json({ ok: true, result: inserted, statusAfter });
}
