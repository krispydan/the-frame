export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { jobQueue } from "@/modules/core/lib/job-queue";

/**
 * POST /api/admin/sales/backfill-enrichment
 *
 * Runs AI enrichment across every past Set-Appointment call that hasn't
 * been enriched yet — creating the Pipedrive deal if needed, writing the
 * call note + activity + the 3 email openers to the deal, and updating
 * the contact. Slack is SKIPPED (these are historical, we don't want to
 * spam the channel).
 *
 * Each lead becomes a `sales.enrich_interested_lead` job
 * ({ skipSlack:true, ensureDeal:true }), drained by the worker
 * (concurrency-limited). Idempotent: already-enriched leads are skipped
 * (guarded by the activity_feed marker inside the job) and are excluded
 * from the cohort here too, so re-running won't duplicate notes.
 *
 * Body (optional): { dryRun?: boolean, limit?: number }
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

  // Companies with a Set-Appointment call that have NOT been enriched yet
  // (no sales_interested_enriched marker for any of their calls).
  const rows = sqlite
    .prepare(
      `SELECT cl.company_id AS company_id,
              MAX(cl.called_at) AS last_call,
              co.name AS name
         FROM phoneburner_call_log cl
         JOIN companies co ON co.id = cl.company_id
        WHERE cl.disposition_label LIKE '%Set Appointment%'
          AND cl.company_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM activity_feed af
             WHERE af.entity_id = cl.company_id
               AND af.event_type = 'sales_interested_enriched'
          )
        GROUP BY cl.company_id
        ORDER BY last_call DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ company_id: string; last_call: string; name: string | null }>;

  const totals = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT company_id) AS total_appt_companies,
              (SELECT COUNT(*) FROM activity_feed WHERE event_type = 'sales_interested_enriched') AS already_enriched
         FROM phoneburner_call_log
        WHERE disposition_label LIKE '%Set Appointment%' AND company_id IS NOT NULL`,
    )
    .get() as { total_appt_companies: number; already_enriched: number };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      cohort_to_enqueue: rows.length,
      totals,
      sample: rows.slice(0, 10).map((r) => ({ company_id: r.company_id, name: r.name, last_call: r.last_call })),
    });
  }

  let enqueued = 0;
  for (const r of rows) {
    jobQueue.enqueue(
      "sales.enrich_interested_lead",
      "sales",
      { companyId: r.company_id, skipSlack: true, ensureDeal: true },
      { priority: 3 },
    );
    enqueued++;
  }

  return NextResponse.json({
    ok: true,
    enqueued,
    totals,
    note: `Enqueued ${enqueued} enrichment jobs (Slack skipped, deals ensured). They drain via the worker; re-run to continue past the limit.`,
  });
}
