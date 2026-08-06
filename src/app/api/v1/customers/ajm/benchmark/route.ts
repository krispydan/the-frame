export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { READER_CATEGORIES } from "@/modules/sales/lib/ajm/categorize";
import { AJM_DATA_FROM } from "@/modules/sales/lib/ajm/channels";

/**
 * GET /api/v1/customers/ajm/benchmark
 *
 * AJ Morgan as a SEASONAL BENCHMARK, not a live competitor.
 *
 * Context that drives the whole shape of this endpoint (per Daniel, Aug 2026):
 *   - AJM was a 40-year-old business that CEASED TRADING in Dec 2025. Its
 *     accounts are orphaned, and Jaxy employs the person who ran its wholesale
 *     book — so AJM is a target to match and a customer list to capture.
 *   - Sunglasses are seasonal, so any Jaxy-vs-AJM number must compare the SAME
 *     CALENDAR MONTHS. Raw period totals mislead.
 *   - WHOLESALE = Shopify wholesale + Faire for BOTH brands. AJM ran Faire as a
 *     separate channel; Jaxy's Faire orders arrive through the Shopify
 *     wholesale store (tagged on source_name). Comparing the Shopify stores
 *     alone ignores AJM's Faire business and flatters Jaxy badly.
 */
const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");

/** Jaxy channel group — Faire arrives via the wholesale store on source_name. */
const JAXY_GROUP = `CASE
  WHEN o.channel = 'shopify_dtc' THEN 'retail'
  WHEN o.channel = 'amazon' THEN 'amazon'
  ELSE 'wholesale' END`;
/** AJM channel group — Faire folded into wholesale to match Jaxy. */
const AJM_GROUP = `CASE
  WHEN o.source = 'shopify_retail' THEN 'retail'
  ELSE 'wholesale' END`;

export async function GET() {
  // Jaxy's trading window defines the season we compare against.
  const jSpan = sqlite.prepare(
    `SELECT MIN(substr(placed_at,1,10)) AS start, MAX(substr(placed_at,1,10)) AS end
     FROM orders WHERE status NOT IN ('cancelled','returned') AND placed_at IS NOT NULL`,
  ).get() as { start: string; end: string };

  const mmdd = (d: string) => d.slice(5);
  const seasonStart = mmdd(jSpan.start), seasonEnd = mmdd(jSpan.end);

  // ── Season-matched: AJM's same Apr21→Aug6 window, every year it traded ──
  const seasonYears = sqlite.prepare(`
    SELECT substr(order_date,1,4) AS year,
           ROUND(SUM(total),2) AS total,
           ROUND(SUM(CASE WHEN source='shopify_retail' THEN total ELSE 0 END),2) AS retail,
           ROUND(SUM(CASE WHEN source!='shopify_retail' THEN total ELSE 0 END),2) AS wholesale,
           COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, customer_name)) AS customers
    FROM ajm_orders
    WHERE cancelled=0 AND order_date >= '${AJM_DATA_FROM}' AND substr(order_date,6) BETWEEN ? AND ?
    GROUP BY year ORDER BY year
  `).all(seasonStart, seasonEnd) as Array<Record<string, number | string>>;

  const jaxySeason = sqlite.prepare(`
    SELECT ROUND(SUM(total),2) AS total,
           ROUND(SUM(CASE WHEN ${JAXY_GROUP}='retail' THEN total ELSE 0 END),2) AS retail,
           ROUND(SUM(CASE WHEN ${JAXY_GROUP}='wholesale' THEN total ELSE 0 END),2) AS wholesale,
           ROUND(SUM(CASE WHEN ${JAXY_GROUP}='amazon' THEN total ELSE 0 END),2) AS amazon,
           COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, id)) AS customers
    FROM orders o WHERE status NOT IN ('cancelled','returned')
  `).get() as Record<string, number>;

  // ── Seasonality curve: AJM's average revenue per calendar month ──
  const seasonality = sqlite.prepare(`
    SELECT mo, ROUND(AVG(t),0) AS ajmAvg FROM (
      SELECT substr(order_date,6,2) AS mo, substr(order_date,1,7) AS ym, SUM(total) AS t
      FROM ajm_orders WHERE cancelled=0 AND order_date>='${AJM_DATA_FROM}' AND order_date<'2025-12-01'
      GROUP BY ym
    ) GROUP BY mo ORDER BY mo
  `).all() as Array<{ mo: string; ajmAvg: number }>;

  const jaxyMonthly = sqlite.prepare(`
    SELECT strftime('%m', placed_at) AS mo, strftime('%Y-%m', placed_at) AS ym,
           ROUND(SUM(total),2) AS revenue
    FROM orders WHERE status NOT IN ('cancelled','returned') AND placed_at IS NOT NULL
    GROUP BY ym ORDER BY ym
  `).all() as Array<{ mo: string; ym: string; revenue: number }>;

  // ── Same-month YoY: AJM 2024 / AJM 2025 / Jaxy 2026, by calendar month ──
  const byMonthYear = sqlite.prepare(`
    SELECT substr(order_date,6,2) AS mo, substr(order_date,1,4) AS year, ROUND(SUM(total),2) AS revenue
    FROM ajm_orders WHERE cancelled=0 AND order_date>='2024-01-01'
    GROUP BY mo, year ORDER BY mo, year
  `).all() as Array<{ mo: string; year: string; revenue: number }>;

  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  const yoy = months.map((mo) => ({
    mo,
    ajm2024: byMonthYear.find((r) => r.mo === mo && r.year === "2024")?.revenue ?? 0,
    ajm2025: byMonthYear.find((r) => r.mo === mo && r.year === "2025")?.revenue ?? 0,
    jaxy2026: jaxyMonthly.filter((r) => r.mo === mo && r.ym.startsWith("2026")).reduce((s, r) => s + r.revenue, 0),
    ajmAvg: seasonality.find((r) => r.mo === mo)?.ajmAvg ?? 0,
  }));

  // ── Category mix (the readers gap) ──
  const categories = sqlite.prepare(`
    SELECT CASE WHEN i.category='sun' THEN 'sunglasses'
                WHEN i.category IN (${READERS}) THEN 'readers'
                WHEN i.category='accessory' THEN 'accessories'
                ELSE 'unattributed' END AS cat,
           ROUND(SUM(i.line_total),2) AS revenue
    FROM ajm_orders o JOIN ajm_order_items i ON i.order_id=o.id
    WHERE o.cancelled=0 AND o.order_date >= '${AJM_DATA_FROM}' GROUP BY cat
  `).all() as Array<{ cat: string; revenue: number }>;

  // ── Orphaned accounts: AJM's book, and how much Jaxy has converted ──
  const orphans = sqlite.prepare(`
    WITH ord AS (
      SELECT company_id, ROUND(SUM(total),2) AS ajmRevenue, COUNT(*) AS ajmOrders,
             MAX(order_date) AS lastOrder
      FROM ajm_orders WHERE cancelled=0 AND order_date >= '${AJM_DATA_FROM}' AND company_id IS NOT NULL GROUP BY company_id
    ),
    cats AS (
      SELECT o.company_id,
             SUM(CASE WHEN i.category IN (${READERS}) THEN i.line_total ELSE 0 END) AS readerRev,
             SUM(i.line_total) AS lineRev
      FROM ajm_orders o JOIN ajm_order_items i ON i.order_id=o.id
      WHERE o.cancelled=0 AND o.order_date >= '${AJM_DATA_FROM}' AND o.company_id IS NOT NULL GROUP BY o.company_id
    )
    SELECT ord.company_id AS companyId, c.name, ca.id AS accountId,
           ord.ajmRevenue, ord.ajmOrders, ord.lastOrder,
           COALESCE(ca.lifetime_value,0) AS jaxyLtv,
           ROUND(COALESCE(cats.readerRev,0)*100.0/NULLIF(cats.lineRev,0),1) AS readerShare
    FROM ord
    JOIN companies c ON c.id = ord.company_id
    LEFT JOIN customer_accounts ca ON ca.company_id = ord.company_id
    LEFT JOIN cats ON cats.company_id = ord.company_id
    ORDER BY ord.ajmRevenue DESC
  `).all() as Array<{ companyId: string; name: string; accountId: string | null; ajmRevenue: number; ajmOrders: number; lastOrder: string; jaxyLtv: number; readerShare: number | null }>;

  const converted = orphans.filter((o) => o.jaxyLtv > 0);
  const notYet = orphans.filter((o) => o.jaxyLtv <= 0);

  return NextResponse.json({
    context: {
      ajmCeased: "2025-12",
      note: "AJ Morgan (40-year-old business) ceased trading Dec 2025. Treat as a seasonal benchmark and an orphaned customer book, not a live competitor.",
      wholesaleDefinition: "Wholesale = Shopify wholesale + Faire, for both brands.",
    },
    season: { start: jSpan.start, end: jSpan.end, mmddStart: seasonStart, mmddEnd: seasonEnd, ajmYears: seasonYears, jaxy: jaxySeason },
    seasonality,
    yoy,
    categories,
    orphans: {
      total: orphans.length,
      totalAjmRevenue: Math.round(orphans.reduce((s, o) => s + o.ajmRevenue, 0) * 100) / 100,
      convertedCount: converted.length,
      convertedAjmRevenue: Math.round(converted.reduce((s, o) => s + o.ajmRevenue, 0) * 100) / 100,
      notYetCount: notYet.length,
      notYetAjmRevenue: Math.round(notYet.reduce((s, o) => s + o.ajmRevenue, 0) * 100) / 100,
      top: notYet.slice(0, 40),
    },
  });
}
