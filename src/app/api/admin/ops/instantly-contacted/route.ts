export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { backfillContacted, type ContactedRow } from "@/modules/sales/lib/instantly-contacted-backfill";

/**
 * Record leads already contacted in Instantly, from a CSV export.
 *
 * POST ?confirm=1 { rows: [{email, campaign, leadStatus, interest, verification}], dryRun? }
 *
 * Makes no third-party calls and spends nothing — it only teaches the frame
 * what Instantly already knows, so the cohort builder stops offering these
 * shops up to be mailed twice.
 */
export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json({ error: "add ?confirm=1" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { rows?: ContactedRow[]; dryRun?: boolean } | null;
  if (!Array.isArray(body?.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows[] required" }, { status: 400 });
  }
  return NextResponse.json({
    ok: true, dryRun: body.dryRun === true,
    ...backfillContacted(body.rows, body.dryRun === true),
  });
}
