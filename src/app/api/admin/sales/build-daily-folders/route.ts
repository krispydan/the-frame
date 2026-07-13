export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { buildDailyCallFolders } from "@/modules/sales/lib/pipedrive-call-sync";

/**
 * POST /api/admin/sales/build-daily-folders
 *
 * Manually run the daily-call-folder builder (Model A): for each rep, pull
 * their open Pipedrive "call" activities due through `through` (default today)
 * and stage the contacts into their PhoneBurner folder. Same job the hourly
 * cron runs — use this to populate the folders now instead of waiting.
 *
 *   commit=false (default): dry-run — reports per-rep what WOULD be staged.
 *   commit=true: actually create/move the PhoneBurner contacts.
 *   through=YYYY-MM-DD: include activities due through this date (default today;
 *     bump it out to pick up future-dated tasks).
 *
 * Auth: x-admin-key: jaxy2026.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const through = url.searchParams.get("through") || undefined;

  const result = await buildDailyCallFolders({ dryRun: !commit, through });
  return NextResponse.json({ commit, ...result });
}
