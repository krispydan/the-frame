export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/email-backfill
 *
 * On-demand companion to the boot-block email backfill. The boot
 * version wraps the INSERT in try/catch with console.warn, so if
 * SQLite rejects the INSERT (NOT NULL violation, FK problem, etc.)
 * we never see the error in the response. This endpoint runs the
 * SAME backfill but lets the error propagate so we can debug.
 *
 * Idempotent — re-running is safe. Uses the same EXISTS-guard so
 * already-backfilled rows are skipped.
 *
 * Body (optional):
 *   { dryRun: true }   — count what WOULD be inserted, no writes
 *
 * Returns:
 *   { ok, inserted, would_insert, sample_before, sample_after, errors }
 *
 * Auth: same admin-key gate as the rest of /api/admin/*.
 */
export async function POST(req: Request) {
  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }

  // Confirm the column still exists before we try to read from it.
  const cols = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "email")) {
    return NextResponse.json({
      ok: false,
      error: "companies.email column already dropped — nothing to backfill",
    });
  }

  // Count what would be inserted
  const wouldInsert = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM companies c
          WHERE TRIM(COALESCE(c.email, '')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM contacts ct
              WHERE ct.company_id = c.id
                AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
            )`,
      )
      .get() as { n: number }
  ).n;

  // Show a 5-row preview of what the INSERT would produce
  const sampleBefore = sqlite
    .prepare(
      `SELECT c.id AS company_id, c.name, LOWER(TRIM(c.email)) AS email_to_insert,
              EXISTS (SELECT 1 FROM contacts cx WHERE cx.company_id = c.id) AS company_has_contacts
         FROM companies c
        WHERE TRIM(COALESCE(c.email, '')) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM contacts ct
            WHERE ct.company_id = c.id
              AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
          )
        LIMIT 5`,
    )
    .all();

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_insert: wouldInsert,
      sample_before: sampleBefore,
    });
  }

  // Run the real backfill — no try/catch wrap, errors propagate.
  const before = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }
  ).n;

  try {
    sqlite.exec(`
      INSERT INTO contacts (
        id, company_id, store_id, first_name, last_name, title,
        email, phone, is_primary, source, created_at, updated_at
      )
      SELECT
        lower(hex(randomblob(16))),
        c.id, NULL, NULL, NULL, NULL,
        LOWER(TRIM(c.email)), NULL,
        CASE
          WHEN EXISTS (SELECT 1 FROM contacts cx WHERE cx.company_id = c.id)
          THEN 0 ELSE 1
        END,
        'legacy_email_backfill',
        datetime('now'),
        datetime('now')
      FROM companies c
      WHERE TRIM(COALESCE(c.email, '')) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM contacts ct
          WHERE ct.company_id = c.id
            AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
        )
    `);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        would_insert: wouldInsert,
        sample_before: sampleBefore,
        contacts_count_before: before,
      },
      { status: 500 },
    );
  }

  const after = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }
  ).n;
  const inserted = after - before;

  return NextResponse.json({
    ok: true,
    dry_run: false,
    inserted,
    contacts_count_before: before,
    contacts_count_after: after,
    would_insert_match: inserted === wouldInsert,
    sample_before: sampleBefore,
  });
}
