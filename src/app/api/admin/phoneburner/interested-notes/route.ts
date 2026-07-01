export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/phoneburner/interested-notes?limit=25&days=45
 *
 * Read-only fixture dump: recent "Set Appointment" (interested) calls
 * with their rep notes + company context (name, email on file, website,
 * recording URL). Used to prototype the AI note-analysis + email-opener
 * prompts against REAL call data before wiring anything into the
 * deal-creation flow. No writes.
 *
 * Auth: x-admin-key: jaxy2026
 */
interface Row {
  call_id: string;
  company_id: string | null;
  company_name: string | null;
  status: string | null;
  disposition_label: string | null;
  connected: number | null;
  duration_seconds: number | null;
  notes: string | null;
  transcript: string | null;
  recording_url: string | null;
  called_at: string | null;
  website: string | null;
  domain: string | null;
  email_on_file: string | null;
  city: string | null;
  state: string | null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 60));

  const rows = sqlite
    .prepare(
      `SELECT cl.id                AS call_id,
              cl.company_id         AS company_id,
              co.name               AS company_name,
              co.status             AS status,
              cl.disposition_label  AS disposition_label,
              cl.connected          AS connected,
              cl.duration_seconds   AS duration_seconds,
              cl.notes              AS notes,
              cl.transcript         AS transcript,
              cl.recording_url      AS recording_url,
              cl.called_at          AS called_at,
              co.website            AS website,
              co.domain             AS domain,
              co.city               AS city,
              co.state              AS state,
              (SELECT ct.email FROM contacts ct
                WHERE ct.company_id = co.id
                  AND TRIM(COALESCE(ct.email,'')) <> ''
                ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email_on_file
         FROM phoneburner_call_log cl
         LEFT JOIN companies co ON co.id = cl.company_id
        WHERE cl.disposition_label LIKE '%Set Appointment%'
          AND (TRIM(COALESCE(cl.notes,'')) <> '' OR TRIM(COALESCE(cl.transcript,'')) <> '')
          AND cl.called_at >= datetime('now', ?)
        ORDER BY cl.called_at DESC
        LIMIT ?`,
    )
    .all(`-${days} days`, limit) as Row[];

  return NextResponse.json({ ok: true, count: rows.length, rows });
}
