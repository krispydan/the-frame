export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { buildAjmRowsFromCsv } from "@/modules/sales/lib/ajm-csv";
import { importAjmRows } from "@/modules/sales/lib/ajm-import";

/**
 * POST /api/v1/sales/import-ajm-csv   (logged-in)
 *
 * Body: { csv: string, dryRun?: boolean }
 *   csv     — a CSV/TSV chunk that INCLUDES the header row. The client uploads
 *             the file and posts it in header+N-line chunks so a large import
 *             can't exceed the edge timeout (importAjmRows is idempotent).
 *   dryRun  — parse + clean + count, no writes.
 *
 * Returns { ok, stats (cleanup counts), summary (importAjmRows result) }.
 */
export async function POST(req: NextRequest) {
  let body: { csv?: string; dryRun?: boolean; pushTag?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body required" }, { status: 400 });
  }
  if (!body.csv || typeof body.csv !== "string") {
    return NextResponse.json({ ok: false, error: "csv (string) required" }, { status: 400 });
  }

  const dryRun = !!body.dryRun;
  try {
    const { rows, stats } = buildAjmRowsFromCsv(body.csv, { pushTag: body.pushTag !== false });
    // recase: clean up existing ALL-CAPS records (names/addresses) + contact
    // names on merge — these AJM rows mostly match existing companies.
    const summary = rows.length ? importAjmRows(rows, { dryRun, recase: true }) : null;
    return NextResponse.json({ ok: true, dryRun, stats, summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
