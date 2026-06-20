export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";

/**
 * POST /api/v1/sales/prospects/[id]/add-to-campaign
 *
 * Body: { campaignId: string, contactId?: string, email?: string }
 *
 * Inserts a campaign_leads row for this prospect → campaign pair if
 * one doesn't already exist. Returns the lead row (existing OR newly
 * created) plus a flag indicating which.
 *
 * This is the "Add to campaign" affordance on the prospect detail
 * page. It does NOT push to Instantly or PhoneBurner — that happens
 * later from the campaign view (Sync to Instantly / Push to PB
 * buttons). All this does is establish membership.
 *
 * Defaults:
 *   - status:   "queued"
 *   - email:    body.email, falling back to the primary contact's
 *               email if not provided
 *   - contact_id: body.contactId, falling back to the primary contact
 *               of the company if any
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: companyId } = await params;
  let body: { campaignId?: string; contactId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!body.campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }

  // Verify both exist
  const company = sqlite
    .prepare("SELECT id, name FROM companies WHERE id = ?")
    .get(companyId) as { id: string; name: string } | undefined;
  if (!company) {
    return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
  }
  const campaign = sqlite
    .prepare("SELECT id, name, status FROM campaigns WHERE id = ?")
    .get(body.campaignId) as
    | { id: string; name: string; status: string }
    | undefined;
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Already a member? Surface the existing row, no-op the insert.
  const existing = sqlite
    .prepare(
      "SELECT id, campaign_id, status, dismissed FROM campaign_leads WHERE campaign_id = ? AND company_id = ? LIMIT 1",
    )
    .get(body.campaignId, companyId) as
    | { id: string; campaign_id: string; status: string; dismissed: number | null }
    | undefined;
  if (existing) {
    // If the lead was dismissed (soft-removed from the campaign),
    // un-dismiss it on re-add so the user gets the obvious "yes
    // you're in this campaign now" outcome.
    if (existing.dismissed) {
      sqlite
        .prepare(
          "UPDATE campaign_leads SET dismissed = 0, status = 'queued' WHERE id = ?",
        )
        .run(existing.id);
    }
    return NextResponse.json({
      ok: true,
      already_member: true,
      undismissed: Boolean(existing.dismissed),
      lead_id: existing.id,
      campaign_id: existing.campaign_id,
    });
  }

  // Fall back to the primary contact if the caller didn't pin one.
  let contactId = body.contactId ?? null;
  let email = body.email ?? null;
  if (!contactId) {
    const primary = sqlite
      .prepare(
        "SELECT id, email FROM contacts WHERE company_id = ? AND is_primary = 1 LIMIT 1",
      )
      .get(companyId) as { id: string; email: string | null } | undefined;
    if (primary) {
      contactId = primary.id;
      email = email ?? primary.email;
    }
  }
  // If still no email, fall back to the company's own email — Instantly
  // sync rejects null-email leads so this maximizes the chance the
  // newly-added lead is actually pushable later.
  if (!email) {
    const co = sqlite
      .prepare("SELECT email FROM companies WHERE id = ?")
      .get(companyId) as { email: string | null } | undefined;
    email = co?.email ?? null;
  }

  const leadId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO campaign_leads
         (id, campaign_id, company_id, contact_id, email, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'))`,
    )
    .run(leadId, body.campaignId, companyId, contactId, email);

  // Trail in activity_feed so the prospect timeline shows it.
  sqlite
    .prepare(
      `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
       VALUES (?, 'campaign_added', 'sales', 'company', ?, ?)`,
    )
    .run(
      randomUUID(),
      companyId,
      JSON.stringify({
        campaign_id: campaign.id,
        campaign_name: campaign.name,
      }),
    );

  return NextResponse.json({
    ok: true,
    already_member: false,
    lead_id: leadId,
    campaign_id: campaign.id,
  });
}
