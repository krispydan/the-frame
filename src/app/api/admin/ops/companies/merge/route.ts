export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { findDuplicateCompanies, mergeCompanies } from "@/modules/sales/lib/company-merge";

/**
 * Duplicate-company detection and merge (x-ops-key: OPS_TOKEN).
 *
 * GET  ?minRevenue=&limit=      list duplicate groups, biggest hidden revenue
 *                               first. Read-only.
 * POST ?confirm=1               DRY RUN by default — reports what would move.
 *      &apply=1                 actually merge (repoint refs, drop losers,
 *                               recompute customer accounts)
 *      &keys=a,b                restrict to specific group keys
 *      &minRevenue=100          only groups hiding at least this much
 *
 * Merging is destructive (loser company rows are deleted), so `apply=1` is
 * deliberately separate from `confirm=1`: a confirmed call still dry-runs
 * unless apply is set too.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  const minRevenue = Number(req.nextUrl.searchParams.get("minRevenue") ?? 0);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  let groups = findDuplicateCompanies();
  const totalGroups = groups.length;
  if (minRevenue > 0) {
    groups = groups.filter((g) => g.splitJaxyRevenue + g.splitAjmRevenue >= minRevenue);
  }
  return NextResponse.json({
    totalGroups,
    matchingGroups: groups.length,
    hiddenJaxyRevenue: Math.round(groups.reduce((s, g) => s + g.splitJaxyRevenue, 0) * 100) / 100,
    hiddenAjmRevenue: Math.round(groups.reduce((s, g) => s + g.splitAjmRevenue, 0) * 100) / 100,
    groups: groups.slice(0, Math.min(limit, 500)),
  });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  const p = req.nextUrl.searchParams;
  const result = mergeCompanies({
    apply: p.get("apply") === "1",
    keys: p.get("keys")?.split(",").filter(Boolean),
    minRevenue: Number(p.get("minRevenue") ?? 0) || undefined,
    limit: Number(p.get("limit") ?? 500),
  });
  return NextResponse.json(result);
}
