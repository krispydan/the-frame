export const dynamic = "force-dynamic";
// Sync can take many minutes — 30 min ceiling.
export const maxDuration = 1800;

import { NextRequest, NextResponse } from "next/server";
import { handleSyncRequest } from "@/modules/sales/lib/instantly-sync";

/**
 * POST /api/admin/sales/sync-instantly
 *
 * Thin admin-keyed wrapper around handleSyncRequest(). Walks every
 * campaign_leads row with instantly_lead_id IS NULL, POSTs each to
 * Instantly's createLead API, and writes back the resulting Instantly
 * lead id. Naturally resumable — interrupted runs pick up where they
 * left off.
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await handleSyncRequest();
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
