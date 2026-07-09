export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { syncPbDeeplinks } from "@/modules/sales/lib/pb-pipedrive-deeplinks";

/**
 * POST /api/admin/sales/backfill-pb-deeplinks
 *
 * Writes the PhoneBurner deep links (contact-view + click-to-call) onto
 * the Pipedrive person for every company that has BOTH a PB contact id
 * and a Pipedrive person. Fetches + caches the per-phone id via
 * getContact on first pass.
 *
 * Body: { limit?: number, dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { limit?: number; dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const dryRun = body.dryRun === true;
  const limit = Math.min(5000, Math.max(1, body.limit ?? 800));

  // Companies with a PB contact push AND a linked Pipedrive person.
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT c.id AS company_id, c.name
         FROM companies c
         JOIN phoneburner_folder_pushes pfp
           ON pfp.company_id = c.id
          AND pfp.pb_contact_id IS NOT NULL AND TRIM(pfp.pb_contact_id) <> ''
        WHERE c.pipedrive_person_id IS NOT NULL
        ORDER BY c.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ company_id: string; name: string | null }>;

  const totals = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT company_id) FROM phoneburner_folder_pushes
            WHERE pb_contact_id IS NOT NULL AND TRIM(pb_contact_id) <> '') AS with_pb_contact,
         (SELECT COUNT(*) FROM companies WHERE pipedrive_person_id IS NOT NULL) AS with_pd_person,
         (SELECT COUNT(DISTINCT pfp.company_id) FROM phoneburner_folder_pushes pfp
            JOIN companies c ON c.id = pfp.company_id
           WHERE pfp.pb_contact_id IS NOT NULL AND TRIM(pfp.pb_contact_id) <> ''
             AND c.pipedrive_person_id IS NOT NULL) AS both,
         (SELECT COUNT(DISTINCT pfp.company_id) FROM phoneburner_folder_pushes pfp
            JOIN companies c ON c.id = pfp.company_id
           WHERE pfp.pb_contact_id IS NOT NULL AND TRIM(pfp.pb_contact_id) <> ''
             AND c.pipedrive_person_id IS NOT NULL
             AND (pfp.pb_phone_id IS NULL OR TRIM(pfp.pb_phone_id) = '')) AS both_missing_phoneid`,
    )
    .get() as Record<string, number>;

  if (dryRun) {
    return NextResponse.json({
      ok: true, dry_run: true, cohort: rows.length, totals,
      sample: rows.slice(0, 5).map((r) => r.name),
    });
  }

  let done = 0, updated = 0, skipped = 0, errors = 0;
  let sampleResult: unknown = null;
  for (const r of rows) {
    try {
      const res = await syncPbDeeplinks(r.company_id);
      if (res.ok) updated++; else skipped++;
      if (!sampleResult && res.ok) sampleResult = res;
    } catch {
      errors++;
    }
    done++;
  }

  return NextResponse.json({
    ok: true, processed: done, updated, skipped, errors, totals,
    sample_result: sampleResult,
    note: `Wrote PB deep links to ${updated} Pipedrive persons. Re-run to continue past the limit.`,
  });
}
