export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { getRepRoi } from "@/modules/sales/lib/rep-roi";

/**
 * GET /api/v1/sales/rep-roi
 *   ?agent=hello@getjaxy.com   PhoneBurner agent_email to attribute
 *   &cost=2500                 monthly cost of the rep
 *   &since=YYYY-MM-DD          window start (default: first logged call)
 *   &margin=80                 assumed gross margin %
 *
 * Also returns the roster (every agent_email seen) and the AJM
 * called-vs-uncalled control, because both are needed to read the number
 * honestly: the roster proves we attributed the right person, and the control
 * answers whether warm customers would have ordered anyway.
 *
 * Cost data is sensitive — owner and finance only.
 */

const ALLOWED_ROLES = ["owner", "finance"];

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "not permitted for your role" }, { status: 403 });
  }

  const p = req.nextUrl.searchParams;
  const agent = (p.get("agent") || "").trim();
  const since = p.get("since") || undefined;

  const roster = sqlite.prepare(
    `SELECT COALESCE(agent_email,'(unattributed)') agent, COUNT(*) calls,
            MIN(called_at) firstCall, MAX(called_at) lastCall
       FROM phoneburner_call_log GROUP BY agent ORDER BY calls DESC`,
  ).all() as Array<{ agent: string; calls: number; firstCall: string; lastCall: string }>;

  // Default to the busiest agent so the page shows something useful on load
  // rather than an empty state that looks like a broken report.
  const chosen = agent || roster[0]?.agent || "";

  const result = getRepRoi({
    rep: p.get("rep") || chosen.split("@")[0] || "rep",
    agentPatterns: chosen ? [chosen] : undefined,
    monthlyCost: p.get("cost") ? Number(p.get("cost")) : undefined,
    since,
    grossMarginPct: p.get("margin") ? Number(p.get("margin")) : undefined,
  });

  // ── AJM control group ──
  const windowStart = since || result.windowStart;
  const isAjm = `(LOWER(COALESCE(c.tags,'')) LIKE '%ajm%' OR LOWER(COALESCE(c.source,'')) LIKE '%ajm%'
                  OR COALESCE(c.ajm_total_spend,0) > 0 OR COALESCE(c.ajm_total_orders,0) > 0)`;
  const calledSql = `EXISTS (SELECT 1 FROM phoneburner_call_log pb
                              WHERE pb.company_id = c.id AND pb.called_at >= ?
                                AND LOWER(COALESCE(pb.agent_email,'')) LIKE ?)`;
  const orderedSql = `EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id
                               AND o.status NOT IN ('cancelled','returned')
                               AND COALESCE(o.placed_at, o.created_at) >= ?)`;
  const group = (called: boolean) =>
    sqlite.prepare(
      `SELECT COUNT(*) companies,
              SUM(CASE WHEN ${orderedSql} THEN 1 ELSE 0 END) buyers,
              COALESCE(SUM((SELECT COALESCE(SUM(o.total),0) FROM orders o
                             WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned')
                               AND COALESCE(o.placed_at, o.created_at) >= ?)),0) revenue,
              AVG(COALESCE(c.ajm_total_spend,0)) avgPriorSpend
         FROM companies c
        WHERE ${isAjm} AND ${called ? "" : "NOT "}${calledSql}`,
    ).get(windowStart, windowStart, windowStart, `%${chosen.toLowerCase()}%`) as {
      companies: number; buyers: number; revenue: number; avgPriorSpend: number;
    };

  const called = group(true);
  const notCalled = group(false);
  const rate = (g: { companies: number; buyers: number }) =>
    g.companies > 0 ? Math.round((g.buyers / g.companies) * 1000) / 10 : 0;

  return NextResponse.json({
    ok: true,
    roster,
    chosenAgent: chosen,
    ...result,
    control: {
      called: {
        ...called,
        orderRatePct: rate(called),
        revenuePerCompany: called.companies ? Math.round((called.revenue / called.companies) * 100) / 100 : 0,
      },
      notCalled: {
        ...notCalled,
        orderRatePct: rate(notCalled),
        revenuePerCompany: notCalled.companies ? Math.round((notCalled.revenue / notCalled.companies) * 100) / 100 : 0,
      },
      liftPct: Math.round((rate(called) - rate(notCalled)) * 10) / 10,
    },
  });
}
