export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/customers/ajm — AJ Morgan historical sales for the browse +
 * comparison page.
 *
 * ?view=summary   → per-source stats, revenue by year per source, and Jaxy's
 *                   own revenue by year per channel group (for the side-by-side)
 * ?view=customers → AJM customers grouped by matched company (or raw name),
 *                   with AJM totals and the matched customer's Jaxy LTV.
 *                   Params: q (search), filter=all|matched|unmatched|dormant,
 *                   limit (default 100). "dormant" = bought from AJM, matched
 *                   to a Frame company, but no Jaxy orders — the win-back list.
 */
export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get("view") ?? "summary";

  if (view === "customers") {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const filter = req.nextUrl.searchParams.get("filter") ?? "all";
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 100), 500);

    const rows = sqlite.prepare(`
      SELECT
        COALESCE(o.company_id, 'raw:' || LOWER(COALESCE(o.customer_name, '?'))) AS groupKey,
        o.company_id AS companyId,
        MAX(c.name) AS companyName,
        MAX(o.customer_name) AS rawName,
        MAX(ca.id) AS accountId,
        MAX(ca.lifetime_value) AS jaxyLtv,
        MAX(ca.last_order_at) AS jaxyLastOrder,
        COUNT(*) AS ajmOrders,
        SUM(o.units) AS ajmUnits,
        ROUND(SUM(o.total), 2) AS ajmRevenue,
        MIN(o.order_date) AS firstOrder,
        MAX(o.order_date) AS lastOrder,
        GROUP_CONCAT(DISTINCT o.source) AS sources
      FROM ajm_orders o
      LEFT JOIN companies c ON c.id = o.company_id
      LEFT JOIN customer_accounts ca ON ca.company_id = o.company_id
      WHERE o.cancelled = 0
      GROUP BY groupKey
      ORDER BY ajmRevenue DESC
    `).all() as Array<{
      groupKey: string; companyId: string | null; companyName: string | null; rawName: string | null;
      accountId: string | null; jaxyLtv: number | null; jaxyLastOrder: string | null;
      ajmOrders: number; ajmUnits: number; ajmRevenue: number;
      firstOrder: string | null; lastOrder: string | null; sources: string;
    }>;

    let filtered = rows;
    if (q) {
      filtered = filtered.filter((r) =>
        (r.companyName ?? "").toLowerCase().includes(q) || (r.rawName ?? "").toLowerCase().includes(q));
    }
    if (filter === "matched") filtered = filtered.filter((r) => r.companyId);
    else if (filter === "unmatched") filtered = filtered.filter((r) => !r.companyId);
    else if (filter === "dormant") filtered = filtered.filter((r) => r.companyId && !(r.jaxyLtv && r.jaxyLtv > 0));

    return NextResponse.json({
      total: filtered.length,
      customers: filtered.slice(0, limit),
    });
  }

  // ── summary ──
  const bySource = sqlite.prepare(`
    SELECT source, COUNT(*) AS orders, SUM(units) AS units, ROUND(SUM(total), 2) AS revenue,
           SUM(CASE WHEN company_id IS NOT NULL THEN 1 ELSE 0 END) AS matchedOrders,
           COUNT(DISTINCT COALESCE(company_id, customer_name)) AS customers,
           MIN(order_date) AS firstOrder, MAX(order_date) AS lastOrder
    FROM ajm_orders WHERE cancelled = 0
    GROUP BY source ORDER BY revenue DESC
  `).all();

  const ajmByYear = sqlite.prepare(`
    SELECT substr(order_date, 1, 4) AS year, source, ROUND(SUM(total), 2) AS revenue, COUNT(*) AS orders
    FROM ajm_orders WHERE cancelled = 0 AND order_date IS NOT NULL
    GROUP BY year, source ORDER BY year
  `).all();

  // Jaxy's own numbers, grouped to AJM-comparable channels:
  //   wholesale = shopify_wholesale + faire + direct + phone; retail = shopify_dtc
  const jaxyByYear = sqlite.prepare(`
    SELECT substr(placed_at, 1, 4) AS year,
           CASE WHEN channel = 'shopify_dtc' THEN 'retail'
                WHEN channel = 'faire' THEN 'faire'
                ELSE 'wholesale' END AS grp,
           ROUND(SUM(total), 2) AS revenue, COUNT(*) AS orders
    FROM orders
    WHERE status NOT IN ('cancelled', 'returned') AND placed_at IS NOT NULL
    GROUP BY year, grp ORDER BY year
  `).all();

  const topProducts = sqlite.prepare(`
    SELECT i.product_name AS product, SUM(i.quantity) AS units, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i
    JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0
    GROUP BY i.product_name
    ORDER BY revenue DESC LIMIT 20
  `).all();

  return NextResponse.json({ bySource, ajmByYear, jaxyByYear, topProducts });
}
