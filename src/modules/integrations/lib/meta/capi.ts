/**
 * Conversions API outbound: push CRM funnel-stage events back to Meta so ad
 * delivery optimizes toward leads that actually convert (not just form-fillers)
 * — the loop Zapier never closed.
 *
 * Design: events are QUEUED into meta_capi_events (never sent inline on the
 * hot webhook path) and flushed by a cron. Stage events beyond the initial
 * "Lead" are DERIVED from current DB state by syncCapiStageEvents() rather than
 * hooked into every mutation site — the same reliable "reconcile from state"
 * approach the PhoneBurner contact-edit sync uses. UNIQUE(meta_lead_id,
 * event_name) makes every derivation idempotent: each lead sends each stage at
 * most once.
 *
 * Stage → CRM signal:
 *   Lead       queued at ingest
 *   Contacted  a connected PhoneBurner call exists for the lead's company
 *   Qualified  the company reached status interested/catalog_sent (or its
 *              Facebook deal advanced past New Lead)
 *   Converted  the company placed a non-cancelled order after the lead came in
 */

import { sqlite } from "@/lib/db";
import {
  sendCapiEvents,
  hashEmail,
  hashPhone,
  metaCapiConfigured,
  metaTestEventCode,
  type CapiEvent,
} from "./client";

const LEAD_EVENT_SOURCE = "the frame";
const MAX_ATTEMPTS = 5;

export interface QueueCapiInput {
  metaLeadId: string;
  leadgenId: string;
  companyId: string | null;
  eventName: string; // "Lead" | "Contacted" | "Qualified" | "Converted"
  email?: string | null;
  phone?: string | null;
  eventTime?: number; // unix seconds; defaults to now
}

/** Queue a CAPI event (idempotent per lead+event via the UNIQUE constraint). */
export function queueCapiEvent(input: QueueCapiInput): void {
  const eventTime = input.eventTime ?? Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO meta_capi_events
         (id, meta_lead_id, leadgen_id, company_id, event_name, event_time, email, phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      crypto.randomUUID(),
      input.metaLeadId,
      input.leadgenId,
      input.companyId ?? null,
      input.eventName,
      eventTime,
      input.email ?? null,
      input.phone ?? null,
    );
}

/**
 * Derive downstream stage events from current DB state. Idempotent — safe to
 * run every few minutes. Only touches leads that have already been processed
 * (so we have a company + the identifiers to match on).
 */
export function syncCapiStageEvents(): { queued: number } {
  const leads = sqlite
    .prepare(
      `SELECT id, leadgen_id, company_id, email, phone, created_time, created_at
         FROM meta_leads
        WHERE status = 'processed' AND company_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    leadgen_id: string;
    company_id: string;
    email: string | null;
    phone: string | null;
    created_time: string | null;
    created_at: string;
  }>;

  let queued = 0;
  for (const lead of leads) {
    const since = lead.created_time || lead.created_at;
    const base = { metaLeadId: lead.id, leadgenId: lead.leadgen_id, companyId: lead.company_id, email: lead.email, phone: lead.phone };

    // Contacted — a connected PhoneBurner call for this company.
    const connectedCall = sqlite
      .prepare("SELECT called_at FROM phoneburner_call_log WHERE company_id = ? AND connected = 1 ORDER BY called_at ASC LIMIT 1")
      .get(lead.company_id) as { called_at: string | null } | undefined;
    if (connectedCall && !hasEvent(lead.id, "Contacted")) {
      queueCapiEvent({ ...base, eventName: "Contacted", eventTime: toUnix(connectedCall.called_at) });
      queued++;
    }

    // Qualified — company reached interested/catalog_sent, or its FB deal advanced.
    const company = sqlite.prepare("SELECT status FROM companies WHERE id = ?").get(lead.company_id) as { status: string | null } | undefined;
    const advancedDeal = sqlite
      .prepare("SELECT 1 FROM pipedrive_deals WHERE company_id = ? AND pipeline = 'facebook' AND stage NOT IN ('New Lead') LIMIT 1")
      .get(lead.company_id);
    if ((["interested", "catalog_sent", "customer"].includes(company?.status || "") || advancedDeal) && !hasEvent(lead.id, "Qualified")) {
      queueCapiEvent({ ...base, eventName: "Qualified" });
      queued++;
    }

    // Converted — a non-cancelled order placed after the lead arrived.
    const order = sqlite
      .prepare(
        `SELECT placed_at FROM orders
          WHERE company_id = ? AND status != 'cancelled' AND COALESCE(placed_at, created_at) >= ?
          ORDER BY COALESCE(placed_at, created_at) ASC LIMIT 1`,
      )
      .get(lead.company_id, since) as { placed_at: string | null } | undefined;
    if (order && !hasEvent(lead.id, "Converted")) {
      queueCapiEvent({ ...base, eventName: "Converted", eventTime: toUnix(order.placed_at) });
      queued++;
    }
  }
  return { queued };
}

function hasEvent(metaLeadId: string, eventName: string): boolean {
  return !!sqlite
    .prepare("SELECT 1 FROM meta_capi_events WHERE meta_lead_id = ? AND event_name = ? LIMIT 1")
    .get(metaLeadId, eventName);
}

function toUnix(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

function buildEvent(row: {
  leadgen_id: string | null;
  event_name: string;
  event_time: number | null;
  email: string | null;
  phone: string | null;
}): CapiEvent {
  const user_data: CapiEvent["user_data"] = {};
  // lead_id is Meta's own 15-17 digit id — the leadgen_id. Highest-priority match.
  const leadIdNum = row.leadgen_id ? Number(row.leadgen_id) : NaN;
  if (Number.isFinite(leadIdNum)) user_data.lead_id = leadIdNum;
  const em = hashEmail(row.email);
  if (em) user_data.em = [em];
  const ph = hashPhone(row.phone);
  if (ph) user_data.ph = [ph];

  return {
    event_name: row.event_name,
    event_time: row.event_time ?? Math.floor(Date.now() / 1000),
    action_source: "system_generated",
    custom_data: { event_source: "crm", lead_event_source: LEAD_EVENT_SOURCE },
    user_data,
  };
}

/**
 * Cron: flush pending CAPI events to Meta. Sends in small batches; marks each
 * row sent/error with attempt count. Rows that exhaust MAX_ATTEMPTS stay
 * "error" and are surfaced in the admin status.
 */
export async function drainCapiEvents(limit = 100, testCode?: string | null): Promise<{ sent: number; failed: number; skipped: number }> {
  if (!metaCapiConfigured()) return { sent: 0, failed: 0, skipped: 0 };
  const rows = sqlite
    .prepare(
      `SELECT id, leadgen_id, event_name, event_time, email, phone, attempts
         FROM meta_capi_events
        WHERE status = 'pending' AND attempts < ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, limit) as Array<{
    id: string;
    leadgen_id: string | null;
    event_name: string;
    event_time: number | null;
    email: string | null;
    phone: string | null;
    attempts: number;
  }>;
  if (rows.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  // Batch the API call but track per-row outcome; Meta accepts many events in
  // one POST. On a batch failure, bump attempts on all rows (they retry next run).
  const events = rows.map(buildEvent);
  const result = await sendCapiEvents(events, testCode ?? metaTestEventCode());

  const now = "datetime('now')";
  if (result.ok) {
    const markSent = sqlite.prepare(
      `UPDATE meta_capi_events SET status = 'sent', attempts = attempts + 1, error = NULL, fbtrace_id = ?, sent_at = ${now} WHERE id = ?`,
    );
    const txn = sqlite.transaction(() => {
      for (const r of rows) markSent.run(result.fbtraceId ?? null, r.id);
    });
    txn();
    return { sent: rows.length, failed: 0, skipped: 0 };
  } else {
    const markErr = sqlite.prepare(
      "UPDATE meta_capi_events SET attempts = attempts + 1, error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'error' ELSE 'pending' END WHERE id = ?",
    );
    const txn = sqlite.transaction(() => {
      for (const r of rows) markErr.run((result.error ?? "send failed").slice(0, 500), MAX_ATTEMPTS, r.id);
    });
    txn();
    return { sent: 0, failed: rows.length, skipped: 0 };
  }
}

/** Cron entry: derive new stage events from state, then flush the queue. */
export async function runCapiSyncAndDrain(): Promise<{ queued: number; sent: number; failed: number }> {
  const { queued } = syncCapiStageEvents();
  const { sent, failed } = await drainCapiEvents();
  return { queued, sent, failed };
}
