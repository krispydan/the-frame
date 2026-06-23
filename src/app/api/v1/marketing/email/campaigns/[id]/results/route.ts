export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns, emailSendResults } from "@/modules/marketing/schema";
import { eq, desc } from "drizzle-orm";
import { recordStrategyOutcome } from "@/modules/marketing/lib/strategy-outcomes";
import { statusIndex } from "@/modules/marketing/lib/workflow";

/**
 * GET  /api/v1/marketing/email/campaigns/[id]/results — list captured results.
 * POST /api/v1/marketing/email/campaigns/[id]/results — record one.
 *
 * Phase 6 manual capture: paste what Omnisend/Faire report. Persists to
 * marketing_email_send_results, derives open/click rates, tags the
 * strategy outcome for the learning loop, and advances status
 * (→ sent on a send, → analyzed once opens/clicks are in).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rows = await db
    .select()
    .from(emailSendResults)
    .where(eq(emailSendResults.campaignId, id))
    .orderBy(desc(emailSendResults.createdAt));

  const withRates = rows.map((r) => ({
    ...r,
    openRate: r.recipients && r.opens != null ? r.opens / r.recipients : null,
    clickRate: r.recipients && r.clicks != null ? r.clicks / r.recipients : null,
  }));
  return NextResponse.json({ results: withRates });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: {
    platform?: "omnisend" | "faire";
    sentAt?: string;
    recipients?: number;
    opens?: number;
    clicks?: number;
    notes?: string;
  } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (body.platform !== "omnisend" && body.platform !== "faire") {
    return NextResponse.json({ error: "platform must be 'omnisend' or 'faire'" }, { status: 400 });
  }

  const recipients = numOrNull(body.recipients);
  const opens = numOrNull(body.opens);
  const clicks = numOrNull(body.clicks);

  const resultId = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO marketing_email_send_results
        (id, campaign_id, platform, sent_at, recipients, opens, clicks, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(resultId, id, body.platform, body.sentAt ?? null, recipients, opens, clicks, body.notes ?? null);

  // Feed the learning loop with the strategy dimensions.
  recordStrategyOutcome({
    campaignId: id,
    audience: campaign.audience as "retail" | "wholesale",
    weekOf: campaign.weekOf ?? campaign.scheduledDate,
    scheduledDate: campaign.scheduledDate,
    recipients,
    opens,
    clicks,
  });

  // Advance status forward only.
  const target =
    opens != null || clicks != null ? "analyzed" : "sent";
  if (statusIndex(campaign.status) < statusIndex(target)) {
    sqlite
      .prepare(`UPDATE marketing_email_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(target, id);
  }

  return NextResponse.json({
    ok: true,
    resultId,
    statusAfter: statusIndex(campaign.status) < statusIndex(target) ? target : campaign.status,
    openRate: recipients && opens != null ? opens / recipients : null,
    clickRate: recipients && clicks != null ? clicks / recipients : null,
  });
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
