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
      "classification",
    ].join(",");
    const all = [...result.wins, ...result.openAppointments];
    const body = all.map((d) => [
      d.companyName, d.status, d.firstCallAt, d.lastCallAt, d.calls, d.connects,
      d.setAppointment, d.ordersAfter, d.revenueAfter, d.firstOrderAfterAt,
      d.daysCallToOrder ?? "", d.hadPriorOrders ? "yes" : "no", d.revenueBefore,
      d.ordersAfter === 0 ? "appointment, no order yet" : d.hadPriorOrders ? "reactivation" : "new customer",
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
