export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getRepRoi } from "@/modules/sales/lib/rep-roi";

/**
 * GET /api/admin/sales/rep-roi
 *   ?rep=sandra            which rep (matches on PhoneBurner agent_email)
 *   &agent=sandra,s.smith  override the email match patterns
 *   &cost=2500             monthly cost
 *   &since=2026-01-01      window start (default: their first logged call)
 *   &margin=80             assumed gross margin %
 *   &format=csv            per-company detail
 *   &agents=1              list every agent_email seen, to check the match
 *
 * Auth: x-admin-key: jaxy2026.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const p = new URL(req.url).searchParams;

  // Coverage of Google Maps data across the CUSTOMER base — the input to any
  // "find more stores like our customers" exercise. Reported before proposing
  // a scrape so the plan is sized against the real gap, not a guess.
  if (p.get("gmapsCoverage") === "1") {
    const n = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
    const CUSTOMER = `EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned'))`;
    return NextResponse.json({
      ok: true,
      customers: {
        total: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER}`),
        withPlaceId: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER} AND c.google_place_id IS NOT NULL`),
        withRating: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER} AND c.google_rating IS NOT NULL`),
        withSubtypes: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER} AND TRIM(COALESCE(c.gmaps_subtypes,'')) <> ''`),
        withAddress: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER} AND TRIM(COALESCE(c.city,'')) <> ''`),
        attemptedNoMatch: n(`SELECT COUNT(*) n FROM companies c WHERE ${CUSTOMER} AND c.gmaps_enrichment_attempted_at IS NOT NULL AND c.google_place_id IS NULL`),
      },
      allCompanies: {
        total: n(`SELECT COUNT(*) n FROM companies c`),
        withPlaceId: n(`SELECT COUNT(*) n FROM companies c WHERE c.google_place_id IS NOT NULL`),
        withSubtypes: n(`SELECT COUNT(*) n FROM companies c WHERE TRIM(COALESCE(c.gmaps_subtypes,'')) <> ''`),
      },
      // What we already know about how customers describe themselves.
      topSubtypesAmongCustomers: sqlite.prepare(
        `SELECT c.gmaps_subtypes, COUNT(*) n FROM companies c
          WHERE ${CUSTOMER} AND TRIM(COALESCE(c.gmaps_subtypes,'')) <> ''
          GROUP BY c.gmaps_subtypes ORDER BY n DESC LIMIT 15`,
      ).all(),
      ratingBands: sqlite.prepare(
        `SELECT CASE
                  WHEN c.google_review_count IS NULL THEN 'unknown'
                  WHEN c.google_review_count < 25 THEN '0-24'
                  WHEN c.google_review_count < 100 THEN '25-99'
                  WHEN c.google_review_count < 500 THEN '100-499'
                  ELSE '500+' END band,
                COUNT(*) n, ROUND(AVG(c.google_rating),2) avgRating
           FROM companies c WHERE ${CUSTOMER} GROUP BY band ORDER BY n DESC`,
      ).all(),
    });
  }

  // Attribution hinges entirely on matching the right agent, so make the
  // roster inspectable rather than assuming the name pattern is right.
  if (p.get("agents") === "1") {
    return NextResponse.json({
      ok: true,
      agents: sqlite.prepare(
        `SELECT COALESCE(agent_email,'(none)') agent, COUNT(*) calls,
                MIN(called_at) first_call, MAX(called_at) last_call
           FROM phoneburner_call_log GROUP BY agent ORDER BY calls DESC`,
      ).all(),
    });
  }

  /**
   * The control group. "They'd have ordered anyway" is testable: compare AJM
   * companies the rep CALLED against AJM companies she never called, over the
   * same window. If both order at the same rate, the calls added nothing; if
   * called ones order more, the lift is the rep's real contribution.
   *
   * Not a randomised trial — the called list was chosen, likely favouring
   * better prospects — so read the lift as an upper bound, not a causal fact.
   */
  if (p.get("control") === "1") {
    const since = p.get("since") || "2026-06-18";
    const patterns = (p.get("agent") || "hello@getjaxy.com").split(",").map((x) => x.trim());
    const agentSql = patterns.map(() => "LOWER(COALESCE(pb.agent_email,'')) LIKE ?").join(" OR ");
    const agentArgs = patterns.map((x) => `%${x.toLowerCase()}%`);

    const isAjm = `(LOWER(COALESCE(c.tags,'')) LIKE '%ajm%' OR LOWER(COALESCE(c.source,'')) LIKE '%ajm%'
                    OR COALESCE(c.ajm_total_spend,0) > 0 OR COALESCE(c.ajm_total_orders,0) > 0)`;
    const calledSql = `EXISTS (SELECT 1 FROM phoneburner_call_log pb
                                WHERE pb.company_id = c.id AND pb.called_at >= ? AND (${agentSql}))`;
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
      ).get(since, since, since, ...agentArgs) as { companies: number; buyers: number; revenue: number; avgPriorSpend: number };

    const called = group(true);
    const notCalled = group(false);
    const rate = (g: { companies: number; buyers: number }) =>
      g.companies > 0 ? Math.round((g.buyers / g.companies) * 1000) / 10 : 0;

    return NextResponse.json({
      ok: true,
      note: "AJM companies called vs never called, same window. Not randomised — the called list was chosen, so treat the lift as an upper bound.",
      since,
      called: { ...called, orderRatePct: rate(called), revenuePerCompany: called.companies ? Math.round(called.revenue / called.companies * 100) / 100 : 0 },
      notCalled: { ...notCalled, orderRatePct: rate(notCalled), revenuePerCompany: notCalled.companies ? Math.round(notCalled.revenue / notCalled.companies * 100) / 100 : 0 },
      liftPct: Math.round((rate(called) - rate(notCalled)) * 10) / 10,
    });
  }

  const result = getRepRoi({
    rep: p.get("rep") || "sandra",
    agentPatterns: p.get("agent")?.split(",").map((s) => s.trim()).filter(Boolean),
    monthlyCost: p.get("cost") ? Number(p.get("cost")) : undefined,
    since: p.get("since") || undefined,
    grossMarginPct: p.get("margin") ? Number(p.get("margin")) : undefined,
  });

  if (p.get("format") === "csv") {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "company", "status", "first_call", "last_call", "calls", "connects",
      "appointments_set", "orders_after_first_call", "revenue_after_first_call",
      "first_order_after", "days_call_to_order", "had_prior_orders", "revenue_before",
      "lead_source", "is_ajm", "ajm_total_spend", "ajm_total_orders", "ajm_last_order",
      "classification",
    ].join(",");
    const all = [...result.wins, ...result.openAppointments];
    const body = all.map((d) => [
      d.companyName, d.status, d.firstCallAt, d.lastCallAt, d.calls, d.connects,
      d.setAppointment, d.ordersAfter, d.revenueAfter, d.firstOrderAfterAt,
      d.daysCallToOrder ?? "", d.hadPriorOrders ? "yes" : "no", d.revenueBefore,
      d.leadSource, d.isAjm ? "yes" : "no", d.ajmTotalSpend ?? "", d.ajmTotalOrders ?? "", d.ajmLastOrder ?? "",
      d.ordersAfter === 0
        ? "appointment, no order yet"
        : d.isAjm ? "AJM prior relationship" : d.hadPriorOrders ? "reactivation" : "new cold customer",
    ].map(esc).join(","));
    return new NextResponse([header, ...body].join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="rep-roi-${result.rep}-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  }

  return NextResponse.json({ ok: true, ...result });
}
