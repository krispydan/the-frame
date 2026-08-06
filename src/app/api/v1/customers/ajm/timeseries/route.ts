export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { READER_CATEGORIES } from "@/modules/sales/lib/ajm/categorize";

/**
 * GET /api/v1/customers/ajm/timeseries?grain=year|month
 *
 * One aligned series for the AJM-vs-Jaxy charts: for each period, AJM revenue
 * and Jaxy revenue split into comparable channel groups, plus AJM's category
 * split (sun vs readers) so the "category we don't stock" gap is visible.
 *
 * Channel grouping (AJM source → group / Jaxy channel → group):
 *   wholesale  shopify_wholesale, oms  |  shopify_wholesale, direct, phone
 *   faire      faire                   |  faire
 *   retail     shopify_retail          |  shopify_dtc
 * Faire is kept separate from wholesale because it's a marketplace with its
 * own economics — lumping them hides which motion actually differs.
 */
const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");

export async function GET(req: NextRequest) {
  const grain = req.nextUrl.searchParams.get("grain") === "month" ? "month" : "year";
  const fmt = grain === "month" ? "%Y-%m" : "%Y";

  const ajm = sqlite.prepare(`
    SELECT strftime('${fmt}', o.order_date) AS period,
           CASE WHEN o.source = 'faire' THEN 'faire'
                WHEN o.source = 'shopify_retail' THEN 'retail'
                ELSE 'wholesale' END AS grp,
           ROUND(SUM(o.total), 2) AS revenue,
           COUNT(*) AS orders
    FROM ajm_orders o
    WHERE o.cancelled = 0 AND o.order_date IS NOT NULL
    GROUP BY period, grp
  `).all() as Array<{ period: string; grp: string; revenue: number; orders: number }>;

  const jaxy = sqlite.prepare(`
    SELECT strftime('${fmt}', o.placed_at) AS period,
           CASE WHEN o.channel = 'faire' THEN 'faire'
                WHEN o.channel = 'shopify_dtc' THEN 'retail'
                WHEN o.channel = 'amazon' THEN 'amazon'
                ELSE 'wholesale' END AS grp,
           ROUND(SUM(o.total), 2) AS revenue,
           COUNT(*) AS orders
    FROM orders o
    WHERE o.status NOT IN ('cancelled','returned') AND o.placed_at IS NOT NULL
    GROUP BY period, grp
  `).all() as Array<{ period: string; grp: string; revenue: number; orders: number }>;

  // AJM category split per period (sun vs readers vs unknown)
  const cats = sqlite.prepare(`
    SELECT strftime('${fmt}', o.order_date) AS period,
           CASE WHEN i.category = 'sun' THEN 'sun'
                WHEN i.category IN (${READERS}) THEN 'reader'
                WHEN i.category = 'accessory' THEN 'accessory'
                ELSE 'unknown' END AS cat,
           ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
    WHERE o.cancelled = 0 AND o.order_date IS NOT NULL
    GROUP BY period, cat
  `).all() as Array<{ period: string; cat: string; revenue: number }>;

  // Pivot into one row per period
  const periods = [...new Set([...ajm, ...jaxy, ...cats].map((r) => r.period))].filter(Boolean).sort();
  const series = periods.map((period) => {
    const a = (g: string) => ajm.find((r) => r.period === period && r.grp === g)?.revenue ?? 0;
    const j = (g: string) => jaxy.find((r) => r.period === period && r.grp === g)?.revenue ?? 0;
    const c = (k: string) => cats.find((r) => r.period === period && r.cat === k)?.revenue ?? 0;
    const ajmWholesale = a("wholesale"), ajmFaire = a("faire"), ajmRetail = a("retail");
    const jaxyWholesale = j("wholesale"), jaxyFaire = j("faire"), jaxyRetail = j("retail"), jaxyAmazon = j("amazon");
    return {
      period,
      ajmWholesale, ajmFaire, ajmRetail,
      ajmTotal: Math.round((ajmWholesale + ajmFaire + ajmRetail) * 100) / 100,
      jaxyWholesale, jaxyFaire, jaxyRetail, jaxyAmazon,
      jaxyTotal: Math.round((jaxyWholesale + jaxyFaire + jaxyRetail + jaxyAmazon) * 100) / 100,
      ajmSun: c("sun"), ajmReader: c("reader"), ajmUnknown: c("unknown") + c("accessory"),
      ajmOrders: ajm.filter((r) => r.period === period).reduce((s, r) => s + r.orders, 0),
      jaxyOrders: jaxy.filter((r) => r.period === period).reduce((s, r) => s + r.orders, 0),
    };
  });

  return NextResponse.json({ grain, series });
}
