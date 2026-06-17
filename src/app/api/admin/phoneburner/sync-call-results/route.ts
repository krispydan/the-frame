export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { pullPhoneBurnerCallResults } from "@/modules/sales/lib/phoneburner-sync";

/**
 * POST /api/admin/phoneburner/sync-call-results
 *
 * Manual trigger for the call-result polling cron. Same handler the
 * scheduled `phoneburner-call-poll` job runs every 5 minutes, but
 * admin-keyed so it's curl-able for testing.
 *
 * Body (optional): { sinceMinutes?: number }   — default 15
 *
 * Returns the pull summary: { ok, since, ingested, skipped_existing,
 *   unmatched, errors }
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { sinceMinutes?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body OK
  }

  try {
    const result = await pullPhoneBurnerCallResults({
      sinceMinutes: body.sinceMinutes,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
