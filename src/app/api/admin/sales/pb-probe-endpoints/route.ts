export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/pb-probe-endpoints
 *
 * Probe PhoneBurner API paths to find which return 200 vs 404. The
 * documented `/calls` list endpoint has been returning 404 in prod,
 * suggesting PB's URL is elsewhere. This maps out the surface.
 *
 * Body: {} — no params.
 * Auth: x-admin-key: jaxy2026
 */

// Test /contacts search parameter variants
const EM = "info@blackbirdofcalistoga.com";
const PATHS_TO_PROBE = [
  `/contacts?search=${EM}&page_size=5`,
  `/contacts?q=${EM}&page_size=5`,
  `/contacts?email=${EM}&page_size=5`,
  `/contacts?primary_email=${EM}&page_size=5`,
  `/contacts?filter=${EM}&page_size=5`,
  `/contacts?keyword=${EM}&page_size=5`,
];

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const accounts = phoneBurnerAccounts();
  const results: Record<string, unknown> = {};

  // Only probe with sandra to save time (both accounts hit same URL surface)
  const sandra = accounts.find((a) => a.rep === "sandra");
  if (!sandra) return NextResponse.json({ ok: false, error: "no sandra account" }, { status: 500 });

  for (const path of PATHS_TO_PROBE) {
    try {
      // Strip query if any and let rawGet fetch full body — include sample
      const r = (await sandra.client.rawGet(path)) as Record<string, unknown> | null;
      results[path] = {
        status: "200",
        keys: r ? Object.keys(r).slice(0, 15) : [],
        sample_body: r,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e));
      const m = msg.match(/PhoneBurner (\d+)/);
      results[path] = { status: m ? m[1] : "err", error: msg.slice(0, 100) };
    }
  }

  return NextResponse.json({ ok: true, results });
}
