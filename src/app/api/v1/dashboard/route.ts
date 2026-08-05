export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { buildDashboard, type Range, type Part } from "@/modules/dashboard/lib/metrics";
import { cached } from "@/modules/dashboard/lib/cache";

/**
 * GET /api/v1/dashboard?range=7d|30d|90d|ytd&part=core|heavy|all&fresh=1
 *
 * Role-aware dashboard data. Only the widget datasets the caller's role may
 * see are computed (owner sees all) — the server-side enforcement the client
 * sidebar filtering alone doesn't provide.
 *
 * Performance: the bundle is cached per (role, range, part) with
 * stale-while-revalidate, so a warm dashboard is a memory read. `part=core`
 * returns the cheap widgets for first paint; `part=heavy` returns the
 * whole-table-scan ones (product performance, FIFO P&L, business health) and
 * is cached for longer since those move slowly. `fresh=1` bypasses the cache.
 */

/**
 * 5-hour freshness across the board (per Daniel, Aug 2026 — the dashboard
 * doesn't need to be more current than that). The huge stale window means a
 * visitor virtually always gets an instant cached answer while a refresh runs
 * behind the request; the dashboard-warm cron force-rebuilds every 5h anyway,
 * and the Refresh button (fresh=1) recomputes on demand.
 */
const FIVE_H = 5 * 60 * 60_000;
const TTL: Record<Part, { ttlMs: number; staleMs: number }> = {
  core: { ttlMs: FIVE_H, staleMs: 7 * 24 * 60 * 60_000 },
  heavy: { ttlMs: FIVE_H, staleMs: 7 * 24 * 60 * 60_000 },
  all: { ttlMs: FIVE_H, staleMs: 7 * 24 * 60 * 60_000 },
};

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const rangeParam = (params.get("range") || "30d") as Range;
  const range: Range = (["7d", "30d", "90d", "ytd"] as string[]).includes(rangeParam) ? rangeParam : "30d";
  const partParam = (params.get("part") || "all") as Part;
  const part: Part = (["core", "heavy", "all"] as string[]).includes(partParam) ? partParam : "all";
  const force = params.get("fresh") === "1";

  try {
    const { ttlMs, staleMs } = TTL[part];
    const { value, cached: fromCache, builtAt } = await cached(
      `dashboard:${user.role}:${range}:${part}`,
      () => buildDashboard(user.role, range, part),
      { ttlMs, staleMs, force },
    );
    return NextResponse.json({ ok: true, ...value, cached: fromCache, builtAt });
  } catch (e) {
    console.error("[dashboard] build failed:", e);
    return NextResponse.json({ error: "failed to build dashboard" }, { status: 500 });
  }
}
