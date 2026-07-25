export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { buildDashboard, type Range } from "@/modules/dashboard/lib/metrics";

/**
 * GET /api/v1/dashboard?range=7d|30d|90d|ytd
 *
 * Role-aware dashboard data bundle. Computes only the widget datasets the
 * caller's role may see (owner sees all) — this is the server-side enforcement
 * that the client sidebar filtering alone doesn't provide.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rangeParam = (req.nextUrl.searchParams.get("range") || "30d") as Range;
  const range: Range = (["7d", "30d", "90d", "ytd"] as string[]).includes(rangeParam) ? rangeParam : "30d";

  try {
    const data = buildDashboard(user.role, range);
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    console.error("[dashboard] build failed:", e);
    return NextResponse.json({ error: "failed to build dashboard" }, { status: 500 });
  }
}
