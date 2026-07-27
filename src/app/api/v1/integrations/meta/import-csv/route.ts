export const dynamic = "force-dynamic";
// A day's export is tens of rows, but each processed lead makes a Pipedrive
// call and a Slack post. A large backfill can take minutes.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { importMetaLeadCsv } from "@/modules/integrations/lib/meta/csv-import";

/**
 * POST /api/v1/integrations/meta/import-csv
 *
 * multipart/form-data:
 *   file    — Meta's "Download leads" export (Ads Manager → Forms Library).
 *             UTF-16 tab-delimited despite the .csv name; handled.
 *   dryRun  — "1" to report what the file contains without ingesting.
 *
 * Manual stand-in for the leadgen webhook while `leads_retrieval` is pending
 * App Review. Rows run through the identical pipeline (company dedupe →
 * Pipedrive deal → Slack alert → CAPI Lead event), keyed on Meta's real lead
 * id, so re-uploading an overlapping export only picks up genuinely new rows
 * and CAPI still matches on lead_id.
 */

const WRITE_ROLES = ["owner", "marketing", "sales_manager"];

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "not permitted for your role" }, { status: 403 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

    const dryRun = String(form.get("dryRun") || "") === "1";
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await importMetaLeadCsv(buf, { dryRun });

    if (result.rows === 0) {
      return NextResponse.json({
        ok: false,
        error:
          "No rows found. Use the file exactly as Meta downloads it (Ads Manager → All tools → Instant Forms → Download leads) — don't open and re-save it in Excel.",
        result,
      }, { status: 400 });
    }

    return NextResponse.json({ ok: true, fileName: file.name, dryRun, result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
