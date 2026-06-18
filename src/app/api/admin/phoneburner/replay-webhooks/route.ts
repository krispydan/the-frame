export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  resolveByCompanyId,
  resolveByCampaignLeadId,
  resolveByPbContactId,
  resolveByPhone,
} from "@/modules/sales/lib/lead-resolution";
import { progressCompanyStatus, type CompanyStatus } from "@/modules/sales/lib/status-progression";

function dispositionToStatus(d: string | null | undefined): CompanyStatus | null {
  if (!d) return null;
  const n = d.trim().toLowerCase().replace(/[\s.\-_]+/g, " ");
  if (n.startsWith("set appointment") || n.startsWith("set appt")) return "interested";
  if (n.startsWith("not interested")) return "not_interested";
  if (n.startsWith("do not call") || n === "dnc") return "not_interested";
  return null;
}

/**
 * POST /api/admin/phoneburner/replay-webhooks
 *
 * Reparse historical phoneburner_webhook_events rows whose downstream
 * effects landed with company_id=null because the original handler
 * didn't understand PB's payload shape. Walks each call_end payload,
 * re-runs the new resolution logic (custom_fields["Company ID"] first),
 * and patches phoneburner_call_log + emits the missing activity_feed
 * entry.
 *
 * Idempotent: skips rows whose call_log already has company_id set.
 *
 * Auth: x-admin-key: jaxy2026
 */
interface PbBody {
  status?: string;
  call_id?: string | number;
  duration?: number;
  connected?: number | string | boolean;
  start_time?: string;
  end_time?: string;
  recording_url?: string;
  call_notes?: Array<string | { note?: string }>;
  notes?: string;
  contact?: {
    user_id?: string;
    phone?: string;
    phones?: Array<{ number?: string }>;
  };
  agent?: { user_id?: string; email?: string };
  custom_fields?: Record<string, string | number | null | undefined>;
}

function cf(body: PbBody, name: string): string | null {
  const v = body.custom_fields?.[name];
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function contactPhone(body: PbBody): string | null {
  if (body.contact?.phone) return String(body.contact.phone);
  const ps = body.contact?.phones;
  if (Array.isArray(ps) && ps[0]?.number) return String(ps[0].number);
  return null;
}
function notesFrom(body: PbBody): string | null {
  if (typeof body.notes === "string" && body.notes.trim()) return body.notes;
  const arr = body.call_notes;
  if (Array.isArray(arr) && arr.length) {
    return (
      arr
        .map((n) => (typeof n === "string" ? n : n?.note ?? ""))
        .filter(Boolean)
        .join("\n") || null
    );
  }
  return null;
}
function connectedFrom(body: PbBody): number {
  const v = body.connected;
  if (v == null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v ? 1 : 0;
  return String(v).trim() === "1" || String(v).trim().toLowerCase() === "true" ? 1 : 0;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = sqlite
    .prepare(
      `SELECT e.id AS event_id, e.payload, e.pb_call_id
         FROM phoneburner_webhook_events e
        WHERE e.event_type = 'call_end'`,
    )
    .all() as Array<{ event_id: string; payload: string; pb_call_id: string | null }>;

  let patched = 0;
  let alreadyComplete = 0;
  let parseFail = 0;
  let stillUnmatched = 0;
  let statusProgressed = 0;

  const updateLog = sqlite.prepare(
    `UPDATE phoneburner_call_log
        SET campaign_lead_id = COALESCE(?, campaign_lead_id),
            company_id = COALESCE(?, company_id),
            phoneburner_contact_id = COALESCE(?, phoneburner_contact_id),
            agent_id = COALESCE(?, agent_id),
            agent_email = COALESCE(?, agent_email),
            disposition_label = COALESCE(?, disposition_label),
            connected = ?,
            duration_seconds = COALESCE(?, duration_seconds),
            notes = COALESCE(?, notes),
            recording_url = COALESCE(?, recording_url)
      WHERE id = ?`,
  );
  const stampLead = sqlite.prepare(
    `UPDATE campaign_leads
        SET last_called_at = COALESCE(?, last_called_at),
            last_call_disposition = COALESCE(?, last_call_disposition),
            call_count = COALESCE(call_count, 0) + 1
      WHERE id = ?`,
  );
  const insertFeed = sqlite.prepare(
    `INSERT INTO activity_feed
       (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
     VALUES (?, 'phoneburner_call_completed', 'sales', 'company', ?, ?, NULL, ?)`,
  );

  for (const r of rows) {
    if (!r.pb_call_id) continue;
    // PB sends call_id as a JSON number; better-sqlite3 normalises it
    // to "3024349467.0" when stored in pb_call_id (TEXT column), but
    // call_log.id was inserted as the integer-stringified "3024349467"
    // from ingestOneCall. Strip the trailing ".0" so the JOIN lands.
    const callLogKey = r.pb_call_id.replace(/\.0$/, "");
    const existing = sqlite
      .prepare("SELECT id, company_id FROM phoneburner_call_log WHERE id = ?")
      .get(callLogKey) as { id: string; company_id: string | null } | undefined;
    if (!existing) continue; // call_log row doesn't exist — webhook hit before sync
    if (existing.company_id) {
      alreadyComplete++;
      continue;
    }

    let body: PbBody;
    try {
      body = JSON.parse(r.payload);
    } catch {
      parseFail++;
      continue;
    }

    // Resolve via the new priority chain
    const companyIdCF = cf(body, "Company ID");
    const frameLeadIdCF = cf(body, "Frame Lead ID");
    const match =
      resolveByCompanyId(companyIdCF) ??
      resolveByCampaignLeadId(frameLeadIdCF) ??
      resolveByPbContactId(body.contact?.user_id ?? null) ??
      resolveByPhone(contactPhone(body));

    if (!match) {
      stillUnmatched++;
      continue;
    }

    const disposition = body.status ?? null;
    const calledAt = body.start_time ?? body.end_time ?? null;

    updateLog.run(
      match.campaignLeadId,
      match.companyId,
      body.contact?.user_id ?? null,
      body.agent?.user_id ?? null,
      body.agent?.email ?? null,
      disposition,
      connectedFrom(body),
      typeof body.duration === "number" ? Math.round(body.duration) : null,
      notesFrom(body),
      body.recording_url ?? null,
      callLogKey,
    );

    if (match.campaignLeadId) {
      stampLead.run(calledAt, disposition, match.campaignLeadId);
    }

    // activity_feed row — only if not already present for this call
    const dupFeed = sqlite
      .prepare(
        `SELECT 1 FROM activity_feed
          WHERE entity_id = ?
            AND event_type = 'phoneburner_call_completed'
            AND data LIKE ?
          LIMIT 1`,
      )
      .get(match.companyId, `%"call_id":"${callLogKey}"%`);
    if (!dupFeed) {
      insertFeed.run(
        crypto.randomUUID(),
        match.companyId,
        JSON.stringify({
          disposition,
          duration_seconds: typeof body.duration === "number" ? body.duration : null,
          recording_url: body.recording_url ?? null,
          agent_id: body.agent?.user_id ?? null,
          agent_email: body.agent?.email ?? null,
          notes: notesFrom(body)?.slice(0, 500) ?? null,
          called_at: calledAt,
          call_id: r.pb_call_id,
        }),
        calledAt ?? new Date().toISOString(),
      );
    }
    // Pipeline progression — Set Appointment / Not Interested / DNC
    // dispositions move companies.status forward and sync the kanban.
    const targetStatus = dispositionToStatus(disposition);
    if (targetStatus) {
      try {
        const r = progressCompanyStatus(match.companyId, targetStatus, { source: "phoneburner" });
        if (r.updated) statusProgressed++;
      } catch (e) {
        console.error("[replay-webhooks] progressCompanyStatus failed:", e);
      }
    }

    patched++;
  }

  return NextResponse.json({
    ok: true,
    patched,
    status_progressed: statusProgressed,
    already_complete: alreadyComplete,
    still_unmatched: stillUnmatched,
    parse_failures: parseFail,
    total_scanned: rows.length,
  });
}
