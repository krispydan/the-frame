export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { analyzeCallNote } from "@/modules/sales/lib/ai/call-note-analysis";
import { getOrCreateTranscript, isTranscriptionEnabled } from "@/modules/sales/lib/ai/recording-transcription";

/**
 * POST /api/admin/sales/enrich-preview
 *
 * Dry-run the AI enrichment against a real interested lead WITHOUT
 * writing anything, so we can eyeball the analysis + opener before
 * enabling the live job.
 *
 * Body:
 *   { companyId: string, transcribe?: boolean, live?: boolean }
 *   - transcribe: also attempt recording transcription (gated by the
 *     pb_transcription_enabled setting + OPENAI_API_KEY).
 *   - live: actually RUN enrichInterestedLead (writes to Pipedrive +
 *     Slack + contacts). Use to smoke-test one lead end-to-end.
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { companyId?: string; transcribe?: boolean; live?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const companyId = String(body.companyId || "").trim();
  if (!companyId) {
    return NextResponse.json({ error: "companyId required" }, { status: 400 });
  }

  const company = sqlite
    .prepare("SELECT id, name FROM companies WHERE id = ?")
    .get(companyId) as { id: string; name: string | null } | undefined;
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  if (body.live) {
    const { enrichInterestedLead } = await import("@/modules/sales/lib/interested-enrichment");
    const result = await enrichInterestedLead(companyId);
    return NextResponse.json({ ok: true, mode: "live", result });
  }

  const call = sqlite
    .prepare(
      `SELECT id AS call_id, notes, recording_url, duration_seconds, disposition_label, called_at
         FROM phoneburner_call_log
        WHERE company_id = ? AND disposition_label LIKE '%Set Appointment%'
        ORDER BY called_at DESC LIMIT 1`,
    )
    .get(companyId) as
    | { call_id: string; notes: string | null; recording_url: string | null; duration_seconds: number | null; disposition_label: string | null; called_at: string | null }
    | undefined;
  if (!call) return NextResponse.json({ error: "no interested call found" }, { status: 404 });

  const emailOnFile = (sqlite
    .prepare(
      `SELECT email FROM contacts WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { email: string | null } | undefined)?.email ?? null;

  // Default: fetch (and persist) the transcript, matching live behaviour.
  // Pass transcribe:false to preview notes-only.
  let transcript: string | null = null;
  const transcriptionAttempted = body.transcribe !== false;
  if (transcriptionAttempted) {
    transcript = await getOrCreateTranscript(call.call_id, call.recording_url);
  }

  const ai = await analyzeCallNote({
    companyName: company.name,
    notes: call.notes,
    transcript,
    emailOnFile,
  });

  return NextResponse.json({
    ok: true,
    mode: "dry",
    company: { id: company.id, name: company.name },
    call: {
      call_id: call.call_id,
      disposition: call.disposition_label,
      notes: call.notes,
      has_recording: !!call.recording_url,
      called_at: call.called_at,
    },
    emailOnFile,
    transcription: {
      enabled: isTranscriptionEnabled(),
      attempted: transcriptionAttempted,
      got_transcript: !!transcript,
      transcript,
    },
    ai,
  });
}
