export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { buildFaireExport, faireExportDiagnostics, runWeeklyFaireExport } from "@/modules/sales/lib/faire-customer-export";

/**
 * POST /api/admin/sales/faire-export
 *
 * Manual trigger for the weekly Faire customer-upload export (same handler the
 * Monday cron runs). Use this to run the first export now, or to re-send.
 *
 *   dryRun=true (default): build only — returns count + the CSV text to inspect,
 *     no email, no stamping.
 *   dryRun=false: build, email the CSV to the recipient, and stamp the leads as
 *     exported (so they drop out of next week's run).
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") !== "false"; // default true

  if (dryRun) {
    const { csv, count, withoutEmail } = buildFaireExport();
    // breakdown explains the count: how many interested leads exist, how many
    // were already exported (stamped) by a prior run, how many remain new.
    return NextResponse.json({ ok: true, dryRun: true, count, withoutEmail, breakdown: faireExportDiagnostics(), csv });
  }

  const r = await runWeeklyFaireExport();
  return NextResponse.json(r);
}
