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

// Enumerate BOTH reps' dial sessions
const PATHS_TO_PROBE = [
  `/dialsession?page=1&page_size=5`,
];

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const accounts = phoneBurnerAccounts();
  const results: Record<string, unknown> = {};

  // Probe with BOTH reps to see per-account visibility
  for (const acct of accounts) {
    for (const path of PATHS_TO_PROBE) {
      const key = `[${acct.rep}] ${path}`;
      try {
        const r = (await acct.client.rawGet(path)) as Record<string, unknown> | null;
        results[key] = { status: "200", sample_body: r };
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e));
        const m = msg.match(/PhoneBurner (\d+)/);
        results[key] = { status: m ? m[1] : "err", error: msg.slice(0, 100) };
      }
    }
  }
  return NextResponse.json({ ok: true, results });

  // (Unreachable — the following is legacy and superseded by the loop above)
  for (const path of PATHS_TO_PROBE) {
    try {
      const r = (await accounts[0].client.rawGet(path)) as Record<string, unknown> | null;
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
