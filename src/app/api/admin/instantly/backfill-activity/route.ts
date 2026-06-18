export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/instantly/backfill-activity
 *
 * For every campaign_lead whose status / timestamp implies an Instantly
 * event happened (sent / opened / replied / bounced / unsubscribed),
 * synthesize the matching activity_feed row IF one doesn't already exist.
 *
 * Backfills the long pre-webhook era. The original pull-sync updated
 * campaign_leads.status + sent_at/opened_at/replied_at but never wrote
 * activity_feed entries — so the prospect timeline was blank for ~95% of
 * leads. Webhook-driven leads from 2026-06-17 onwards already have proper
 * activity_feed rows; this script only fills in the gap.
 *
 * Idempotent on (entity_id, event_type, data.lead_id) — re-running won't
 * create duplicates.
 *
 * Body (all optional):
 *   { dryRun?: boolean }      // default false
 *
 * Auth: x-admin-key: jaxy2026
 */

interface LeadRow {
  lead_id: string;
  company_id: string;
  campaign_id: string;
  email: string | null;
  instantly_lead_id: string | null;
  status: string;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  reply_text: string | null;
  created_at: string | null;
  campaign_name: string | null;
  instantly_campaign_id: string | null;
}

// (status, timestampField) → event_type
const STATUS_EVENTS: Array<{
  status: string;
  tsField: keyof LeadRow;
  eventType: string;
}> = [
  { status: "sent",         tsField: "sent_at",    eventType: "instantly_email_sent" },
  { status: "opened",       tsField: "opened_at",  eventType: "instantly_email_opened" },
  { status: "replied",      tsField: "replied_at", eventType: "instantly_reply_received" },
  { status: "bounced",      tsField: "sent_at",    eventType: "instantly_email_bounced" },
  { status: "unsubscribed", tsField: "sent_at",    eventType: "instantly_lead_unsubscribed" },
];

// Which event types each status implies (cumulative — replied implies
// sent + opened + replied). Lets us synthesize the FULL history from a
// terminal status.
const STATUS_IMPLIED: Record<string, string[]> = {
  sent:         ["sent"],
  opened:       ["sent", "opened"],
  replied:      ["sent", "opened", "replied"],
  bounced:      ["bounced"],
  unsubscribed: ["unsubscribed"],
};

function activityFeedDupExists(opts: {
  companyId: string;
  eventType: string;
  leadId: string;
}): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM activity_feed
        WHERE entity_id = ?
          AND event_type = ?
          AND data LIKE ?
        LIMIT 1`,
    )
    .get(opts.companyId, opts.eventType, `%"campaign_lead_id":"${opts.leadId}"%`);
  return !!row;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch { /* empty body OK */ }
  const dryRun = body.dryRun === true;

  const leads = sqlite
    .prepare(
      `SELECT cl.id          AS lead_id,
              cl.company_id  AS company_id,
              cl.campaign_id AS campaign_id,
              cl.email,
              cl.instantly_lead_id,
              cl.status,
              cl.sent_at,
              cl.opened_at,
              cl.replied_at,
              cl.reply_text,
              cl.created_at,
              c.name         AS campaign_name,
              c.instantly_campaign_id
         FROM campaign_leads cl
         LEFT JOIN campaigns c ON c.id = cl.campaign_id
        WHERE cl.status IN ('sent','opened','replied','bounced','unsubscribed')`,
    )
    .all() as LeadRow[];

  const byEventType: Record<string, number> = {};
  let synthesized = 0;
  let skipped_existing = 0;
  let skipped_no_company = 0;

  const insert = sqlite.prepare(
    `INSERT INTO activity_feed
       (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
     VALUES (?, ?, 'sales', 'company', ?, ?, NULL, ?)`,
  );
  const txn = sqlite.transaction(() => {
    for (const lead of leads) {
      if (!lead.company_id) {
        skipped_no_company++;
        continue;
      }
      const impliedStatuses = STATUS_IMPLIED[lead.status] ?? [lead.status];
      for (const status of impliedStatuses) {
        const mapping = STATUS_EVENTS.find((s) => s.status === status);
        if (!mapping) continue;
        if (activityFeedDupExists({
          companyId: lead.company_id,
          eventType: mapping.eventType,
          leadId: lead.lead_id,
        })) {
          skipped_existing++;
          continue;
        }
        // Use the explicit timestamp if available; else fall back to
        // campaign_lead.created_at; else now.
        const ts =
          (lead[mapping.tsField] as string | null) ??
          lead.created_at ??
          new Date().toISOString();
        const data: Record<string, unknown> = {
          campaign_id: lead.instantly_campaign_id,
          campaign_name: lead.campaign_name,
          lead_email: lead.email,
          campaign_lead_id: lead.lead_id, // dedup key
          instantly_lead_id: lead.instantly_lead_id,
          backfilled: true,
        };
        if (mapping.eventType === "instantly_reply_received" && lead.reply_text) {
          data.reply_snippet = lead.reply_text.slice(0, 500);
        }
        if (!dryRun) {
          insert.run(
            crypto.randomUUID(),
            mapping.eventType,
            lead.company_id,
            JSON.stringify(data),
            ts,
          );
        }
        synthesized++;
        byEventType[mapping.eventType] = (byEventType[mapping.eventType] ?? 0) + 1;
      }
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    scanned_leads: leads.length,
    synthesized,
    skipped_existing,
    skipped_no_company,
    by_event_type: byEventType,
  });
}
