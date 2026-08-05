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

// From PB docs at https://www.phoneburner.com/developer/route_list
// Real endpoints, verified against the published route list.
const PATHS_TO_PROBE = [
  "/dialsession",              // list dial sessions with pagination — the real call history root
  "/dialsession/settings",     // config
  "/dialsession/usage",        // stats per date range
  "/contacts/1296839589/activities", // per-contact activities (Waterloo TX)
  "/contacts/1296839589/auditlog",   // change log
  "/tags",                     // global tags
  "/members",                  // team members incl. user_id 1294137966 lookup
  "/voicemails",
  "/customfields",
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
      const r = (await sandra.client.rawGet(path, { page_size: 1 })) as Record<string, unknown> | null;
      results[path] = {
        status: "200",
        keys: r ? Object.keys(r).slice(0, 15) : [],
        sample_data_len: r
          ? (Array.isArray(r) ? r.length : ((r.data as unknown[])?.length ?? (r.calls as unknown[])?.length ?? "?"))
          : 0,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e));
      const m = msg.match(/PhoneBurner (\d+)/);
      results[path] = { status: m ? m[1] : "err", error: msg.slice(0, 100) };
    }
  }

  return NextResponse.json({ ok: true, results });
}
