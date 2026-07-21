export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { pdRequest } from "@/modules/sales/lib/pipedrive-client";

/**
 * Extract first names for the catalog mail-merge from the emails already sent
 * in Pipedrive (the greeting line, e.g. "Hi Lakecia,").
 *
 * Exploration first:
 *   GET ?debug=threads&limit=5        → raw sent mail threads (see structure)
 *   GET ?debug=messages&threadId=ID   → raw messages of a thread (find the body)
 *   GET                               → cohort first-name coverage audit
 *
 * Auth: x-admin-key: jaxy2026.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug");

  if (debug === "threads") {
    const limit = Math.max(1, parseInt(url.searchParams.get("limit") || "5", 10));
    const raw = await pdRequest<unknown>("GET", `/mailbox/mailThreads?folder=sent&limit=${limit}`);
    return NextResponse.json({ ok: true, raw });
  }
  if (debug === "messages") {
    const threadId = url.searchParams.get("threadId");
    const raw = await pdRequest<unknown>("GET", `/mailbox/mailThreads/${threadId}/mailMessages`);
    return NextResponse.json({ ok: true, raw });
  }

  // Coverage audit over the catalog cohort.
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.pipedrive_person_id AS personId,
              (SELECT TRIM(COALESCE(ct.first_name,'')) FROM contacts ct
                WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS firstName
       FROM companies c
       JOIN pipedrive_deals d ON d.company_id = c.id AND d.pipeline = 'catalog' AND d.is_open = 1
       WHERE c.status != 'customer'
       GROUP BY c.id`,
    )
    .all() as Array<{ id: string; name: string; personId: number | null; firstName: string | null }>;
  const withName = rows.filter((r) => r.firstName && r.firstName.length > 0);
  return NextResponse.json({
    ok: true,
    cohort: rows.length,
    haveFirstName: withName.length,
    missingFirstName: rows.length - withName.length,
    withPipedrivePerson: rows.filter((r) => r.personId).length,
    sampleMissing: rows.filter((r) => !r.firstName).slice(0, 10).map((r) => r.name),
  });
}
