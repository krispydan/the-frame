export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/phoneburner/company-diag?companyId=...  (or ?email=...)
 *
 * Traces the full PhoneBurner → Frame chain for one company so we can
 * see exactly where a call/disposition failed to surface on the
 * prospect page. Curl-able (SSH + MCP system_query both unavailable).
 *
 * Returns for the resolved company:
 *   - company row (id, name, status, phone)
 *   - matching phoneburner_call_log rows (by company_id)
 *   - matching phoneburner_webhook_events (by pb_contact_id via
 *     campaign_leads, or frame_lead_id)
 *   - activity_feed rows for the company (phoneburner_* + all)
 *   - campaign_leads rows (phoneburner_contact_id, last_call_disposition)
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const email = url.searchParams.get("email");
  const name = url.searchParams.get("name");

  let company: { id: string; name: string; status: string; phone: string | null } | undefined;
  if (companyId) {
    company = sqlite
      .prepare("SELECT id, name, status FROM companies WHERE id = ?")
      .get(companyId) as typeof company;
  } else if (email) {
    company = sqlite
      .prepare("SELECT id, name, status FROM companies WHERE lower(email) = lower(?) LIMIT 1")
      .get(email) as typeof company;
  } else if (name) {
    company = sqlite
      .prepare("SELECT id, name, status FROM companies WHERE name LIKE ? LIMIT 1")
      .get(`%${name}%`) as typeof company;
  }

  if (!company) {
    return NextResponse.json(
      { error: "company not found — pass ?companyId= or ?email= or ?name=" },
      { status: 404 },
    );
  }

  const cid = company.id;

  const callLog = sqlite
    .prepare(
      `SELECT id, campaign_lead_id, phoneburner_contact_id, disposition_label,
              connected, duration_seconds, agent_email, called_at, ingested_at
         FROM phoneburner_call_log
        WHERE company_id = ?
        ORDER BY called_at DESC LIMIT 20`,
    )
    .all(cid);

  const campaignLeads = sqlite
    .prepare(
      `SELECT id, campaign_id, phoneburner_contact_id, last_called_at,
              last_call_disposition, call_count, email
         FROM campaign_leads
        WHERE company_id = ?`,
    )
    .all(cid);

  // Webhook events matching this company's PB contact ids or campaign_lead ids.
  const pbContactIds = (campaignLeads as Array<{ phoneburner_contact_id: string | null }>)
    .map((l) => l.phoneburner_contact_id)
    .filter(Boolean) as string[];
  const leadIds = (campaignLeads as Array<{ id: string }>).map((l) => l.id);

  let webhookEvents: unknown[] = [];
  if (pbContactIds.length || leadIds.length) {
    const placeholders = [...pbContactIds, ...leadIds].map(() => "?").join(",");
    webhookEvents = sqlite
      .prepare(
        `SELECT id, event_type, pb_call_id, pb_contact_id, frame_lead_id,
                token_valid, handler_ok, handler_message, received_at,
                substr(payload, 1, 400) AS payload_preview
           FROM phoneburner_webhook_events
          WHERE pb_contact_id IN (${placeholders})
             OR frame_lead_id IN (${placeholders})
          ORDER BY received_at DESC LIMIT 20`,
      )
      .all(...pbContactIds, ...leadIds, ...pbContactIds, ...leadIds);
  }

  const activityFeed = sqlite
    .prepare(
      `SELECT event_type, module, substr(data, 1, 300) AS data_preview, created_at
         FROM activity_feed
        WHERE entity_id = ?
        ORDER BY created_at DESC LIMIT 20`,
    )
    .all(cid);

  return NextResponse.json({
    ok: true,
    company,
    counts: {
      call_log: (callLog as unknown[]).length,
      campaign_leads: (campaignLeads as unknown[]).length,
      webhook_events: webhookEvents.length,
      activity_feed: (activityFeed as unknown[]).length,
    },
    campaignLeads,
    callLog,
    webhookEvents,
    activityFeed,
  });
}
