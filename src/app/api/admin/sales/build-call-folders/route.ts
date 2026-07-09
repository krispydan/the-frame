export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { buildDailyCallFolders } from "@/modules/sales/lib/pipedrive-call-sync";

/**
 * POST /api/admin/sales/build-call-folders
 *
 * Builds/refreshes each rep's daily PhoneBurner call folder from their
 * open Pipedrive call activities (create PB contact if missing, move into
 * the rep folder, stamp the activity id; remove + restore contacts whose
 * activity is no longer due/open).
 *
 * Body: { dryRun?: boolean, through?: "YYYY-MM-DD" }  (dryRun default true)
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean; through?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  // Default to dryRun unless explicitly false, so a bare call never moves contacts.
  const dryRun = body.dryRun !== false;
  try {
    const result = await buildDailyCallFolders({ dryRun, through: body.through });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
