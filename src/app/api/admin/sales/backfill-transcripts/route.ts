export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { enqueueCallTranscription } from "@/modules/sales/lib/status-sync";

/**
 * POST /api/admin/sales/backfill-transcripts
 *
 * Enqueue transcription for every past Set-Appointment call that has no
 * transcript yet, so we build the transcript archive over the whole
 * history. Each call becomes a `sales.transcribe_call` job (queue
 * concurrency-limited, retried, idempotent via getOrCreateTranscript).
 *
 * Body (optional):
 *   { dryRun?: boolean, limit?: number }
 *     dryRun  — return the cohort size + sample, enqueue nothing.
 *     limit   — cap how many to enqueue this run (default 2000).
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const dryRun = body.dryRun === true;
  const limit = Math.min(5000, Math.max(1, body.limit ?? 2000));

  const rows = sqlite
    .prepare(
      `SELECT id, company_id, recording_url, called_at
         FROM phoneburner_call_log
        WHERE disposition_label LIKE '%Set Appointment%'
          AND (transcript IS NULL OR TRIM(transcript) = '')
        ORDER BY called_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; company_id: string | null; recording_url: string | null; called_at: string | null }>;

  // Also report how many already have transcripts / total Set-Appointment.
  const totals = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN transcript IS NOT NULL AND TRIM(transcript) <> '' THEN 1 ELSE 0 END) AS with_transcript,
         SUM(CASE WHEN recording_url IS NULL OR TRIM(recording_url) = '' THEN 1 ELSE 0 END) AS missing_recording_url
       FROM phoneburner_call_log
      WHERE disposition_label LIKE '%Set Appointment%'`,
    )
    .get() as { total: number; with_transcript: number; missing_recording_url: number };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      cohort_to_enqueue: rows.length,
      totals,
      sample: rows.slice(0, 10).map((r) => ({
        call_id: r.id,
        company_id: r.company_id,
        has_recording_url: !!r.recording_url,
        called_at: r.called_at,
      })),
    });
  }

  let enqueued = 0;
  for (const r of rows) {
    enqueueCallTranscription(r.id, 0); // no delay — historical recordings are ready
    enqueued++;
  }

  return NextResponse.json({
    ok: true,
    enqueued,
    totals,
    note: `Enqueued ${enqueued} transcription jobs. They drain via the worker (concurrency-limited). Re-run to continue past the limit.`,
  });
}
