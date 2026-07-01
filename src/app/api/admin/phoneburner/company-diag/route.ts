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
  try {
    return runDiag(req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 4) : undefined },
      { status: 500 },
    );
  }
}

function runDiag(req: NextRequest) {
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

  // This company's phones (canonical store) — needed to know if a PB
  // call by phone COULD have matched.
  const phones = sqlite
    .prepare(
      `SELECT phone, source, is_primary FROM company_phones WHERE company_id = ?`,
    )
    .all(cid) as Array<{ phone: string; source: string | null; is_primary: number }>;

  // Deep search: find ANY webhook_event whose raw payload mentions this
  // company's email or any of its phone digit-strings. Catches events
  // that arrived but never resolved to this company (e.g. contact added
  // to PB manually, so no Company ID custom field → resolver missed).
  const emails = (campaignLeads as Array<{ email: string | null }>)
    .map((l) => l.email)
    .filter(Boolean) as string[];
  const digitStrings = phones
    .map((p) => p.phone.replace(/\D+/g, ""))
    .filter((d) => d.length >= 10)
    .map((d) => (d.length === 11 && d.startsWith("1") ? d.slice(1) : d));

  const likeTerms = [...emails, ...digitStrings];
  let payloadMatches: unknown[] = [];
  if (likeTerms.length) {
    const clauses = likeTerms.map(() => "payload LIKE ?").join(" OR ");
    payloadMatches = sqlite
      .prepare(
        `SELECT id, event_type, pb_call_id, pb_contact_id, frame_lead_id,
                token_valid, handler_ok, handler_message, received_at,
                substr(payload, 1, 4000) AS payload_preview
           FROM phoneburner_webhook_events
          WHERE ${clauses}
          ORDER BY received_at DESC LIMIT 20`,
      )
      .all(...likeTerms.map((t) => `%${t}%`));
  }

  // ── Pipeline / Pipedrive diagnostics ──
  let deals: unknown[] = [];
  try {
    deals = sqlite
      .prepare("SELECT id, title, stage, channel, created_at FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 10")
      .all(cid);
  } catch { /* deals shape differs */ }

  // Pipedrive linkage on the company
  let pipedriveCompany: unknown = null;
  try {
    pipedriveCompany = sqlite
      .prepare("SELECT pipedrive_org_id, pipedrive_person_id, pipedrive_synced_at FROM companies WHERE id = ?")
      .get(cid) ?? null;
  } catch { pipedriveCompany = "(columns absent)"; }

  let pipedriveDeals: unknown[] = [];
  try {
    pipedriveDeals = sqlite
      .prepare("SELECT pipedrive_deal_id, pipeline, stage, status, is_open, title, updated_at FROM pipedrive_deals WHERE company_id = ? ORDER BY updated_at DESC LIMIT 10")
      .all(cid);
  } catch { /* table/columns differ */ }

  // The status-sync jobs enqueued for this company
  let syncJobs: unknown[] = [];
  try {
    syncJobs = sqlite
      .prepare(
        `SELECT type, status, attempts, error, substr(output,1,200) AS output, created_at
           FROM jobs
          WHERE type LIKE 'sales.sync_status_%'
            AND input LIKE ?
          ORDER BY created_at DESC LIMIT 10`,
      )
      .all(`%${cid}%`);
  } catch { /* jobs shape differs */ }

  // Pipedrive settings
  const pdSettings = sqlite
    .prepare("SELECT key, value FROM settings WHERE key IN ('pipedrive_sync_enabled','pipedrive_access_token','pipedrive_pipeline_config')")
    .all() as Array<{ key: string; value: string | null }>;
  const pdSettingsSummary = pdSettings.map((s) => ({
    key: s.key,
    set: !!s.value,
    value: s.key === "pipedrive_sync_enabled" ? s.value : undefined,
  }));

  return NextResponse.json({
    ok: true,
    company,
    counts: {
      call_log: (callLog as unknown[]).length,
      campaign_leads: (campaignLeads as unknown[]).length,
      webhook_events_by_id: webhookEvents.length,
      webhook_events_by_payload: payloadMatches.length,
      activity_feed: (activityFeed as unknown[]).length,
      phones: phones.length,
      deals: (deals as unknown[]).length,
      pipedrive_deals: (pipedriveDeals as unknown[]).length,
      sync_jobs: (syncJobs as unknown[]).length,
    },
    phones,
    campaignLeads,
    callLog,
    webhookEvents,
    payloadMatches,
    activityFeed,
    deals,
    pipedriveCompany,
    pipedriveDeals,
    syncJobs,
    pipedriveSettings: pdSettingsSummary,
  });
}
