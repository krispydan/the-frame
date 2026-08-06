export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { findDuplicateCompanies, mergeCompanies, getNeedsReview } from "@/modules/sales/lib/company-merge";

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
  // Comma-separated name search across BOTH lists. Without it the response is
  // capped at the top groups by hidden revenue, so a small-dollar duplicate
  // ("Alter", hiding $1,109) is invisible and easy to mistake for "not found".
  const q = (req.nextUrl.searchParams.get("q") ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const matchesQ = (names: string[]) =>
    !q.length || names.some((n) => q.some((t) => n.toLowerCase().includes(t)));

  let groups = findDuplicateCompanies();
  const totalGroups = groups.length;
  const review = getNeedsReview();
  if (minRevenue > 0) {
    groups = groups.filter((g) => g.splitJaxyRevenue + g.splitAjmRevenue >= minRevenue);
  }
  if (q.length) groups = groups.filter((g) => matchesQ(g.companies.map((c) => c.name)));
  const matchedReview = q.length
    ? review.filter((r) => matchesQ(r.companies.map((c) => c.name)))
    : review;

  // ?format=csv exports the WHOLE plan, one row per company, so the merge can
  // be reviewed in a spreadsheet before anything is deleted. The JSON response
  // is capped at 500 groups and is no basis for approving 6,000 merges.
  if (req.nextUrl.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      "group_key,reason,role,company_id,name,city,state,zip,email,jaxy_orders,jaxy_revenue,ajm_orders,ajm_revenue",
    ];
    for (const g of groups) {
      for (const c of g.companies) {
        lines.push([
          esc(g.key), g.reason, c.id === g.keepId ? "KEEP" : "merge-into-keeper",
          esc(c.id), esc(c.name), esc(c.city), esc(c.state), esc(c.zip), esc(c.email),
          c.jaxyOrders, c.jaxyRevenue, c.ajmOrders, c.ajmRevenue,
        ].join(","));
      }
    }
    for (const r of matchedReview) {
      for (const c of r.companies) {
        lines.push([
          esc(r.key), "NEEDS REVIEW", esc(r.reason),
          esc(c.id), esc(c.name), esc(c.city), esc(c.state), esc(c.zip), esc(c.email),
          c.jaxyOrders, c.jaxyRevenue, c.ajmOrders, c.ajmRevenue,
        ].join(","));
      }
    }
    return new NextResponse(lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="company-merge-plan.csv"' },
    });
  }

  return NextResponse.json({
    totalGroups,
    matchingGroups: groups.length,
    query: q.length ? q : undefined,
    hiddenJaxyRevenue: Math.round(groups.reduce((s, g) => s + g.splitJaxyRevenue, 0) * 100) / 100,
    hiddenAjmRevenue: Math.round(groups.reduce((s, g) => s + g.splitAjmRevenue, 0) * 100) / 100,
    groups: groups.slice(0, Math.min(limit, 500)),
    // Collisions we deliberately refused to merge (no shared location or
    // domain) — e.g. the eleven unrelated "Revival" shops, and addresses
    // shared by too many companies to be an identity signal.
    needsReview: matchedReview.slice(0, q.length ? 200 : 50),
    needsReviewCount: matchedReview.length,
  });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  const p = req.nextUrl.searchParams;
  try {
    const result = mergeCompanies({
      apply: p.get("apply") === "1",
      keys: p.get("keys")?.split(",").filter(Boolean),
      minRevenue: Number(p.get("minRevenue") ?? 0) || undefined,
      limit: Number(p.get("limit") ?? 500),
    });
    return NextResponse.json(result);
  } catch (e) {
    // The merge runs in one transaction, so a throw means nothing was written
    // — but an empty 500 leaves no way to find out WHY. Report it.
    const err = e as Error & { code?: string };
    return NextResponse.json(
      { error: err.message, code: err.code, rolledBack: true },
      { status: 500 },
    );
  }
}
