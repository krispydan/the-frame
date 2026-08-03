/**
 * Cold-call ROI — is a rep's outreach actually producing revenue?
 *
 * Attribution here is deliberately conservative and stated, because the honest
 * answer to "did the call cause the sale" is unknowable and an over-generous
 * model would just tell you what you want to hear:
 *
 *   - A company counts as the rep's ONLY if they called it. Calls are the
 *     evidence; nothing is credited on proximity or territory.
 *   - Revenue counts only from orders placed AFTER the first call to that
 *     company. Anything earlier is pre-existing business the rep inherited,
 *     not something they created, and including it is the single easiest way
 *     to make cold calling look profitable when it isn't.
 *   - A company that had ALREADY ordered before the rep's first call is
 *     reported separately as "reactivation", not new business. Both are real
 *     value; conflating them hides which one the rep is actually good at.
 *
 * Every figure is derived from call logs and orders — nothing is self-reported.
 */

import { sqlite } from "@/lib/db";

export interface RepRoiRow {
  companyId: string;
  companyName: string | null;
  firstCallAt: string | null;
  lastCallAt: string | null;
  calls: number;
  connects: number;
  setAppointment: number;
  status: string;
  /** Orders placed after the first call. */
  ordersAfter: number;
  revenueAfter: number;
  firstOrderAfterAt: string | null;
  daysCallToOrder: number | null;
  /** Had they ordered BEFORE the rep ever called? Then this is reactivation. */
  hadPriorOrders: boolean;
  revenueBefore: number;
}

export interface RepRoiResult {
  rep: string;
  agentEmails: string[];
  windowStart: string;
  windowEnd: string;
  months: number;
  monthlyCost: number;
  totalCost: number;

  activity: {
    calls: number;
    connects: number;
    connectRatePct: number;
    talkMinutes: number;
    companiesTouched: number;
    setAppointments: number;
    appointmentRatePct: number;
    /** Distinct companies with at least one Set Appointment. */
    companiesWithAppointment: number;
  };

  outcome: {
    /** New business: first-time buyers who ordered after their first call. */
    newCustomers: number;
    newRevenue: number;
    /** Reactivation: prior buyers who ordered again after a call. */
    reactivatedCustomers: number;
    reactivatedRevenue: number;
    totalAttributedRevenue: number;
    orders: number;
    avgOrderValue: number;
    /** Of companies with an appointment set, how many went on to order. */
    appointmentToOrderPct: number;
    /** Every called company, whether or not an appointment was set. */
    callToOrderPct: number;
  };

  economics: {
    /** Attributed revenue ÷ cost. 1.0 = breaking even on revenue, NOT profit. */
    revenueRoi: number;
    /** The honest one: gross profit ÷ cost, using the catalog margin. */
    grossProfitRoi: number;
    assumedGrossMarginPct: number;
    grossProfit: number;
    costPerConnect: number;
    costPerAppointment: number;
    costPerNewCustomer: number | null;
    /** Revenue needed to cover the cost at the assumed margin. */
    breakEvenRevenue: number;
    revenueVsBreakEven: number;
  };

  byMonth: Array<{
    month: string;
    calls: number;
    connects: number;
    appointments: number;
    orders: number;
    revenue: number;
    cost: number;
  }>;

  /** Every company they called that has since ordered. */
  wins: RepRoiRow[];
  /** Appointments set that never converted — the follow-up backlog. */
  openAppointments: RepRoiRow[];
}

/** Agents are identified by the email PhoneBurner stamps on each call. */
export const REP_AGENTS: Record<string, string[]> = {
  sandra: ["sandra"],
  christina: ["christina"],
};

/**
 * Gross margin used to turn revenue into profit.
 *
 * Wholesale eyewear at Jaxy runs roughly 80-90% gross on catalog cost (see the
 * product performance report). 80 is the conservative end — a report meant to
 * justify or end a $2,500/month spend should not flatter itself.
 */
const DEFAULT_GROSS_MARGIN_PCT = 80;

function agentClause(patterns: string[]): { sql: string; args: string[] } {
  const sql = patterns.map(() => "LOWER(COALESCE(pb.agent_email,'')) LIKE ?").join(" OR ");
  return { sql: `(${sql})`, args: patterns.map((p) => `%${p.toLowerCase()}%`) };
}

export function getRepRoi(opts: {
  rep?: string;
  agentPatterns?: string[];
  monthlyCost?: number;
  since?: string;
  grossMarginPct?: number;
} = {}): RepRoiResult {
  const rep = (opts.rep || "sandra").toLowerCase();
  const patterns = opts.agentPatterns?.length ? opts.agentPatterns : (REP_AGENTS[rep] ?? [rep]);
  const monthlyCost = opts.monthlyCost ?? 2500;
  const marginPct = opts.grossMarginPct ?? DEFAULT_GROSS_MARGIN_PCT;
  const { sql: agentSql, args: agentArgs } = agentClause(patterns);

  // Window starts at their first logged call unless overridden — paying from
  // before they started calling would understate the return.
  const bounds = sqlite
    .prepare(`SELECT MIN(called_at) a, MAX(called_at) b FROM phoneburner_call_log pb WHERE ${agentSql}`)
    .get(...agentArgs) as { a: string | null; b: string | null };
  const windowStart = opts.since || bounds.a || new Date().toISOString();
  const windowEnd = bounds.b || new Date().toISOString();

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  const months = Math.max(1, (endMs - startMs) / (30.44 * 86400000));
  const totalCost = Math.round(monthlyCost * months * 100) / 100;

  // ── Activity ──
  const act = sqlite
    .prepare(
      `SELECT COUNT(*) calls,
              SUM(CASE WHEN pb.connected = 1 THEN 1 ELSE 0 END) connects,
              SUM(COALESCE(pb.duration_seconds,0)) secs,
              COUNT(DISTINCT pb.company_id) companies,
              SUM(CASE WHEN REPLACE(LOWER(COALESCE(pb.disposition_label,'')),'.','') LIKE 'set app%' THEN 1 ELSE 0 END) appts
         FROM phoneburner_call_log pb
        WHERE ${agentSql} AND pb.called_at >= ?`,
    )
    .get(...agentArgs, windowStart) as { calls: number; connects: number; secs: number; companies: number; appts: number };

  const companiesWithAppt = (sqlite
    .prepare(
      `SELECT COUNT(DISTINCT pb.company_id) n FROM phoneburner_call_log pb
        WHERE ${agentSql} AND pb.called_at >= ? AND pb.company_id IS NOT NULL
          AND REPLACE(LOWER(COALESCE(pb.disposition_label,'')),'.','') LIKE 'set app%'`,
    )
    .get(...agentArgs, windowStart) as { n: number }).n;

  // ── Per-company outcome ──
  // One row per company they called, with revenue split around the first call.
  const rows = sqlite
    .prepare(
      `SELECT c.id AS companyId, c.name AS companyName, c.status,
              MIN(pb.called_at) AS firstCallAt,
              MAX(pb.called_at) AS lastCallAt,
              COUNT(*) AS calls,
              SUM(CASE WHEN pb.connected = 1 THEN 1 ELSE 0 END) AS connects,
              SUM(CASE WHEN REPLACE(LOWER(COALESCE(pb.disposition_label,'')),'.','') LIKE 'set app%' THEN 1 ELSE 0 END) AS setAppointment
         FROM phoneburner_call_log pb
         JOIN companies c ON c.id = pb.company_id
        WHERE ${agentSql} AND pb.called_at >= ?
        GROUP BY c.id`,
    )
    .all(...agentArgs, windowStart) as Array<{
    companyId: string; companyName: string | null; status: string;
    firstCallAt: string; lastCallAt: string; calls: number; connects: number; setAppointment: number;
  }>;

  const afterStmt = sqlite.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(o.total),0) rev, MIN(COALESCE(o.placed_at, o.created_at)) firstAt
       FROM orders o
      WHERE o.company_id = ? AND o.status NOT IN ('cancelled','returned')
        AND COALESCE(o.placed_at, o.created_at) >= ?`,
  );
  const beforeStmt = sqlite.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(o.total),0) rev
       FROM orders o
      WHERE o.company_id = ? AND o.status NOT IN ('cancelled','returned')
        AND COALESCE(o.placed_at, o.created_at) < ?`,
  );

  const detail: RepRoiRow[] = rows.map((r) => {
    const after = afterStmt.get(r.companyId, r.firstCallAt) as { n: number; rev: number; firstAt: string | null };
    const before = beforeStmt.get(r.companyId, r.firstCallAt) as { n: number; rev: number };
    const days = after.firstAt
      ? Math.max(0, Math.round((Date.parse(after.firstAt) - Date.parse(r.firstCallAt)) / 86400000))
      : null;
    return {
      companyId: r.companyId,
      companyName: r.companyName,
      firstCallAt: r.firstCallAt,
      lastCallAt: r.lastCallAt,
      calls: r.calls,
      connects: r.connects,
      setAppointment: r.setAppointment,
      status: r.status,
      ordersAfter: after.n,
      revenueAfter: Math.round(after.rev * 100) / 100,
      firstOrderAfterAt: after.firstAt,
      daysCallToOrder: days,
      hadPriorOrders: before.n > 0,
      revenueBefore: Math.round(before.rev * 100) / 100,
    };
  });

  const buyers = detail.filter((d) => d.ordersAfter > 0);
  const newBiz = buyers.filter((d) => !d.hadPriorOrders);
  const reactivated = buyers.filter((d) => d.hadPriorOrders);

  const newRevenue = Math.round(newBiz.reduce((t, d) => t + d.revenueAfter, 0) * 100) / 100;
  const reactivatedRevenue = Math.round(reactivated.reduce((t, d) => t + d.revenueAfter, 0) * 100) / 100;
  const totalRevenue = Math.round((newRevenue + reactivatedRevenue) * 100) / 100;
  const orders = buyers.reduce((t, d) => t + d.ordersAfter, 0);

  const grossProfit = Math.round(totalRevenue * (marginPct / 100) * 100) / 100;
  const breakEvenRevenue = Math.round((totalCost / (marginPct / 100)) * 100) / 100;

  // ── Monthly series ──
  const monthlyCalls = sqlite
    .prepare(
      `SELECT substr(pb.called_at,1,7) m, COUNT(*) calls,
              SUM(CASE WHEN pb.connected = 1 THEN 1 ELSE 0 END) connects,
              SUM(CASE WHEN REPLACE(LOWER(COALESCE(pb.disposition_label,'')),'.','') LIKE 'set app%' THEN 1 ELSE 0 END) appts
         FROM phoneburner_call_log pb
        WHERE ${agentSql} AND pb.called_at >= ?
        GROUP BY m ORDER BY m`,
    )
    .all(...agentArgs, windowStart) as Array<{ m: string; calls: number; connects: number; appts: number }>;

  // Revenue by month, counted only for orders after that company's first call.
  const revByMonth = new Map<string, { orders: number; revenue: number }>();
  for (const d of buyers) {
    const os = sqlite
      .prepare(
        `SELECT substr(COALESCE(o.placed_at, o.created_at),1,7) m, COUNT(*) n, COALESCE(SUM(o.total),0) rev
           FROM orders o
          WHERE o.company_id = ? AND o.status NOT IN ('cancelled','returned')
            AND COALESCE(o.placed_at, o.created_at) >= ?
          GROUP BY m`,
      )
      .all(d.companyId, d.firstCallAt) as Array<{ m: string; n: number; rev: number }>;
    for (const o of os) {
      const cur = revByMonth.get(o.m) ?? { orders: 0, revenue: 0 };
      cur.orders += o.n;
      cur.revenue += o.rev;
      revByMonth.set(o.m, cur);
    }
  }

  const allMonths = [...new Set([...monthlyCalls.map((m) => m.m), ...revByMonth.keys()])].sort();
  const byMonth = allMonths.map((m) => {
    const c = monthlyCalls.find((x) => x.m === m);
    const r = revByMonth.get(m);
    return {
      month: m,
      calls: c?.calls ?? 0,
      connects: c?.connects ?? 0,
      appointments: c?.appts ?? 0,
      orders: r?.orders ?? 0,
      revenue: Math.round((r?.revenue ?? 0) * 100) / 100,
      // Cost only lands in months they actually worked.
      cost: c?.calls ? monthlyCost : 0,
    };
  });

  const connectRate = act.calls > 0 ? (act.connects / act.calls) * 100 : 0;

  return {
    rep,
    agentEmails: patterns,
    windowStart,
    windowEnd,
    months: Math.round(months * 10) / 10,
    monthlyCost,
    totalCost,
    activity: {
      calls: act.calls,
      connects: act.connects,
      connectRatePct: Math.round(connectRate * 10) / 10,
      talkMinutes: Math.round(act.secs / 60),
      companiesTouched: act.companies,
      setAppointments: act.appts,
      appointmentRatePct: act.connects > 0 ? Math.round((act.appts / act.connects) * 1000) / 10 : 0,
      companiesWithAppointment: companiesWithAppt,
    },
    outcome: {
      newCustomers: newBiz.length,
      newRevenue,
      reactivatedCustomers: reactivated.length,
      reactivatedRevenue,
      totalAttributedRevenue: totalRevenue,
      orders,
      avgOrderValue: orders > 0 ? Math.round((totalRevenue / orders) * 100) / 100 : 0,
      appointmentToOrderPct: companiesWithAppt > 0
        ? Math.round((detail.filter((d) => d.setAppointment > 0 && d.ordersAfter > 0).length / companiesWithAppt) * 1000) / 10
        : 0,
      callToOrderPct: detail.length > 0 ? Math.round((buyers.length / detail.length) * 1000) / 10 : 0,
    },
    economics: {
      revenueRoi: totalCost > 0 ? Math.round((totalRevenue / totalCost) * 100) / 100 : 0,
      grossProfitRoi: totalCost > 0 ? Math.round((grossProfit / totalCost) * 100) / 100 : 0,
      assumedGrossMarginPct: marginPct,
      grossProfit,
      costPerConnect: act.connects > 0 ? Math.round((totalCost / act.connects) * 100) / 100 : 0,
      costPerAppointment: act.appts > 0 ? Math.round((totalCost / act.appts) * 100) / 100 : 0,
      costPerNewCustomer: newBiz.length > 0 ? Math.round((totalCost / newBiz.length) * 100) / 100 : null,
      breakEvenRevenue,
      revenueVsBreakEven: Math.round((totalRevenue - breakEvenRevenue) * 100) / 100,
    },
    byMonth,
    wins: buyers.sort((a, b) => b.revenueAfter - a.revenueAfter),
    openAppointments: detail
      .filter((d) => d.setAppointment > 0 && d.ordersAfter === 0)
      .sort((a, b) => (b.lastCallAt || "").localeCompare(a.lastCallAt || "")),
  };
}
