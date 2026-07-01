export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { ingestOneCall } from "@/modules/sales/lib/phoneburner-sync";
import {
  resolveByCompanyId,
  resolveByCampaignLeadId,
  resolveByPbContactId,
  resolveByPhone,
  type ResolveResult,
} from "@/modules/sales/lib/lead-resolution";
import { progressCompanyStatus, type CompanyStatus } from "@/modules/sales/lib/status-progression";

/**
 * POST /api/admin/phoneburner/reprocess-failed
 *
 * Re-runs the call_end ingestion pipeline on every
 * phoneburner_webhook_events row where handler_ok != 1. Fixes the
 * backlog created while resolveByPhone was throwing "no such column:
 * phone" (see commit 9f3f262) — those events were stored but their
 * downstream effects (call_log, campaign_leads, activity_feed, status
 * progression) never ran.
 *
 * Idempotent: ingestOneCall PKs on call_id, progressCompanyStatus is
 * forward-only. Safe to run repeatedly. Does NOT re-fire Slack alerts
 * (historical replay shouldn't spam #sales-leads).
 *
 * Body (optional): { dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */
interface PbBody {
  status?: string;
  call_id?: string | number;
  duration?: number;
  connected?: number | string | boolean;
  start_time?: string;
  end_time?: string;
  timestamp?: string;
  recording_url?: string;
  call_notes?: Array<string | { note?: string }>;
  notes?: string;
  contact?: { user_id?: string; phone?: string; phones?: Array<{ number?: string }> };
  agent?: { user_id?: string; email?: string };
  custom_fields?: Record<string, string | number | null | undefined>;
}

function cf(b: PbBody, name: string): string | null {
  const v = b.custom_fields?.[name];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
function contactPhone(b: PbBody): string | null {
  if (b.contact?.phone) return String(b.contact.phone);
  const ps = b.contact?.phones;
  if (Array.isArray(ps) && ps[0]?.number) return String(ps[0].number);
  return null;
}
function connectedNum(b: PbBody): boolean {
  const v = b.connected;
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return String(v).trim() === "1" || String(v).trim().toLowerCase() === "true";
}
function notesFrom(b: PbBody): string | null {
  if (typeof b.notes === "string" && b.notes.trim()) return b.notes;
  const arr = b.call_notes;
  if (Array.isArray(arr) && arr.length) {
    return arr.map((n) => (typeof n === "string" ? n : n?.note ?? "")).filter(Boolean).join("\n") || null;
  }
  return null;
}
function dispositionToStatus(d: string | null | undefined): CompanyStatus | null {
  if (!d) return null;
  const n = d.trim().toLowerCase().replace(/[\s.\-_]+/g, " ");
  if (n.startsWith("set appointment") || n.startsWith("set appt")) return "interested";
  if (n.startsWith("not interested")) return "not_interested";
  if (n.startsWith("do not call") || n === "dnc") return "not_interested";
  return null;
}
function resolveEvent(b: PbBody): ResolveResult | null {
  return (
    resolveByCompanyId(cf(b, "Company ID")) ??
    resolveByCampaignLeadId(cf(b, "Frame Lead ID")) ??
    resolveByPbContactId(b.contact?.user_id ?? null) ??
    resolveByPhone(contactPhone(b))
  );
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty OK */ }
  const dryRun = body.dryRun === true;

  const rows = sqlite
    .prepare(
      `SELECT id, payload FROM phoneburner_webhook_events
        WHERE event_type = 'call_end'
          AND (handler_ok IS NULL OR handler_ok = 0)`,
    )
    .all() as Array<{ id: string; payload: string }>;

  const summary = {
    ok: true,
    dry_run: dryRun,
    scanned: rows.length,
    ingested: 0,
    already_present: 0,
    unmatched: 0,
    status_progressed: 0,
    parse_failures: 0,
    interested_progressed: 0,
  };

  const markOk = sqlite.prepare(
    "UPDATE phoneburner_webhook_events SET handler_ok = 1, handler_message = ? WHERE id = ?",
  );

  for (const r of rows) {
    let b: PbBody;
    try { b = JSON.parse(r.payload); } catch { summary.parse_failures++; continue; }

    const disposition = b.status ?? null;
    const callId = b.call_id != null ? String(b.call_id) : "";
    if (!callId) { summary.parse_failures++; continue; }

    const match = resolveEvent(b);
    if (!match) { summary.unmatched++; continue; }

    if (dryRun) {
      summary.ingested++;
      const t = dispositionToStatus(disposition);
      if (t === "interested") summary.interested_progressed++;
      continue;
    }

    const outcome = ingestOneCall(
      {
        id: callId,
        call_id: callId,
        contact_id: b.contact?.user_id ?? undefined,
        user_id: match.campaignLeadId ?? cf(b, "Frame Lead ID") ?? undefined,
        agent_id: b.agent?.user_id ?? undefined,
        agent_email: b.agent?.email ?? undefined,
        duration: typeof b.duration === "number" ? b.duration : undefined,
        connected: connectedNum(b),
        disposition: disposition ?? undefined,
        disposition_label: disposition ?? undefined,
        notes: notesFrom(b) ?? undefined,
        recording_url: b.recording_url ?? undefined,
        phone: contactPhone(b) ?? undefined,
        called_at: b.start_time ?? b.end_time ?? b.timestamp ?? undefined,
      },
      { preResolved: match },
    );
    if (outcome === "ingested") summary.ingested++;
    else if (outcome === "skipped_existing") summary.already_present++;
    else summary.unmatched++;

    // Status progression (Set Appointment → interested, etc.)
    const target = dispositionToStatus(disposition);
    if (target && match.companyId) {
      try {
        const res = progressCompanyStatus(match.companyId, target, { source: "phoneburner" });
        if (res.updated) {
          summary.status_progressed++;
          if (res.to === "interested") summary.interested_progressed++;
        }
      } catch (e) {
        console.error("[reprocess-failed] progressCompanyStatus:", e);
      }
    }

    markOk.run(`reprocessed: ${outcome} disposition=${disposition ?? "(none)"}`, r.id);
  }

  // Stamp-backfill pass: link every campaign_lead that's missing a
  // phoneburner_contact_id to the PB contact id we already have in
  // phoneburner_call_log for the same company. Catches the leads that
  // were reprocessed BEFORE the self-heal shipped (their call_log rows
  // carry the contact id but campaign_leads was never stamped).
  let contactLinksStamped = 0;
  if (!dryRun) {
    const res = sqlite
      .prepare(
        `UPDATE campaign_leads
            SET phoneburner_contact_id = (
              SELECT pcl.phoneburner_contact_id
                FROM phoneburner_call_log pcl
               WHERE pcl.company_id = campaign_leads.company_id
                 AND pcl.phoneburner_contact_id IS NOT NULL
                 AND pcl.phoneburner_contact_id != ''
               ORDER BY pcl.called_at DESC LIMIT 1
            )
          WHERE (phoneburner_contact_id IS NULL OR phoneburner_contact_id = '')
            AND EXISTS (
              SELECT 1 FROM phoneburner_call_log pcl2
               WHERE pcl2.company_id = campaign_leads.company_id
                 AND pcl2.phoneburner_contact_id IS NOT NULL
                 AND pcl2.phoneburner_contact_id != ''
            )`,
      )
      .run();
    contactLinksStamped = res.changes;
  }

  return NextResponse.json({ ...summary, contactLinksStamped });
}
