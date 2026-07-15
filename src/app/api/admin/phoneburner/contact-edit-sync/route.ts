export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { reconcileContactEdits } from "@/modules/sales/lib/phoneburner-contact-sync";

/**
 * POST /api/admin/phoneburner/contact-edit-sync?maxPages=5
 *
 * Manual trigger for the contact-edit reconciliation: polls each PhoneBurner
 * account for recently-updated contacts and syncs any email that differs from
 * the frame back into the frame + Pipedrive. Same logic the cron runs.
 * Auth: x-admin-key: jaxy2026.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const maxPages = Math.max(1, parseInt(url.searchParams.get("maxPages") || "5", 10));
  const resetWatermark = url.searchParams.get("reset") === "true";
  try {
    const result = await reconcileContactEdits({ maxPages, resetWatermark });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
