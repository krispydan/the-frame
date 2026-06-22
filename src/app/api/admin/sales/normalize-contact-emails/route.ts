export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/normalize-contact-emails
 *
 * Lowercases every contacts.email that isn't already lowercase. The
 * email integrity audit (2026-06-19) found ~12,698 rows where the
 * existing contact email had different case from companies.email
 * even though they were the same address.
 *
 * New writes are lowercased on the way in (addCompanyEmail helper +
 * backfill SQL), but the original ~81k contacts rows pre-dating the
 * migration may have mixed-case emails. This endpoint mops up the
 * tail.
 *
 * Idempotent — re-running is a no-op (the WHERE filters out rows
 * that are already lowercase).
 *
 * Body: { dryRun?: boolean }   — true reports count without writing
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }

  // Count rows whose email differs from their lowercased version.
  // TRIM here too so "  Info@X.com  " gets caught.
  const wouldUpdate = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM contacts
          WHERE email IS NOT NULL
            AND email != LOWER(TRIM(email))`,
      )
      .get() as { n: number }
  ).n;

  const sample = sqlite
    .prepare(
      `SELECT id, company_id, email, LOWER(TRIM(email)) AS lowercased
         FROM contacts
        WHERE email IS NOT NULL
          AND email != LOWER(TRIM(email))
        LIMIT 10`,
    )
    .all();

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_update: wouldUpdate,
      sample,
    });
  }

  if (wouldUpdate === 0) {
    return NextResponse.json({
      ok: true,
      updated: 0,
      message: "Already normalized — nothing to do.",
    });
  }

  // Single UPDATE pass — much faster than a loop. The cache-refresh
  // trigger on contacts.email is no longer present after the column
  // drop, so each UPDATE is just a write, no cascading.
  const result = sqlite
    .prepare(
      `UPDATE contacts
          SET email = LOWER(TRIM(email)),
              updated_at = datetime('now')
        WHERE email IS NOT NULL
          AND email != LOWER(TRIM(email))`,
    )
    .run();

  return NextResponse.json({
    ok: true,
    updated: result.changes,
    sample_before: sample,
    message: `Lowercased ${result.changes} contacts.email rows.`,
  });
}
