export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/email-drop-column
 *
 * Diagnostic + on-demand executor for the companies.email column
 * drop. The boot-block version wraps the ALTER TABLE in try/catch
 * with console.error — if SQLite refuses the drop for any reason we
 * never see the error in the HTTP response.
 *
 * This endpoint runs the SAME drop logic but lets every error
 * propagate so we can fix the underlying cause.
 *
 * Body (optional):
 *   { dryRun: true }   — report status without dropping
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: Request) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }

  const cols = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string; type: string; notnull: number }>;
  const emailCol = cols.find((c) => c.name === "email");

  if (!emailCol) {
    return NextResponse.json({
      ok: true,
      already_dropped: true,
      message: "companies.email already gone — nothing to do.",
    });
  }

  const orphans = (
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

  // Show every active trigger touching this column so we can see
  // what would be torn down.
  const triggers = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger'
          AND (name LIKE 'trg_contacts_email_%'
            OR name LIKE 'trg_companies_email_%')`,
    )
    .all() as Array<{ name: string }>;

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      column_exists: true,
      column_info: emailCol,
      legacy_only_count: orphans,
      safe_to_drop: orphans === 0,
      triggers_to_drop: triggers.map((t) => t.name),
    });
  }

  if (orphans > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Refusing to drop — ${orphans} companies have a non-empty email with no matching contacts row. Run GET /api/admin/sales/email-integrity-check for samples.`,
      },
      { status: 409 },
    );
  }

  // Drop triggers first so the column drop has nothing referencing it.
  const dropped: string[] = [];
  for (const t of triggers) {
    try {
      sqlite.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
      dropped.push(t.name);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          stage: "drop_trigger",
          trigger: t.name,
          error: e instanceof Error ? e.message : String(e),
          dropped_so_far: dropped,
        },
        { status: 500 },
      );
    }
  }

  // The actual column drop.
  try {
    sqlite.exec(`ALTER TABLE companies DROP COLUMN email`);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        stage: "alter_table",
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        triggers_already_dropped: dropped,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    column_dropped: true,
    triggers_dropped: dropped,
    message:
      "companies.email dropped. Run GET /api/admin/sales/email-integrity-check to confirm phase: 'post_drop'.",
  });
}
