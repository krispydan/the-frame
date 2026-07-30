export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/customers/analytics
 * Everything the customer analytics dashboard needs, in one call:
 *   - KPIs (customer count, total LTV, avg LTV, at-risk count, new this month)
 *   - Best customers (top by lifetime value)
 *   - At-risk customers (health at_risk/churning, ranked by LTV so we chase
 *     the valuable ones first)
 *   - By-state breakdown (customer count + revenue)
 *   - Geo points (customers with lat/lng, for the map)
 *   - Health + tier distributions
 *   - Geocoding progress (how many customers still need coordinates)
 */
export async function GET() {
  // ── KPIs ──
  const kpi = sqlite.prepare(`
    SELECT
      COUNT(*) AS customerCount,
      COALESCE(SUM(lifetime_value), 0) AS totalLtv,
      COALESCE(AVG(lifetime_value), 0) AS avgLtv,
      COALESCE(SUM(total_orders), 0) AS totalOrders,
      SUM(CASE WHEN health_status IN ('at_risk','churning') THEN 1 ELSE 0 END) AS atRiskCount,
      SUM(CASE WHEN health_status = 'churned' THEN 1 ELSE 0 END) AS churnedCount
    FROM customer_accounts
  `).get() as Record<string, number>;

  const newThisMonth = (sqlite.prepare(`
    SELECT COUNT(*) AS c FROM customer_accounts
    WHERE first_order_at >= date('now', 'start of month')
  `).get() as { c: number }).c;

  // ── Best customers ──
  const bestCustomers = sqlite.prepare(`
    SELECT c.id AS companyId, c.name AS name, COALESCE(s.name, c.segment) AS segment,
           c.state, ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.avg_order_value AS aov, ca.health_status AS health, ca.last_order_at AS lastOrderAt
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    ORDER BY ca.lifetime_value DESC
    LIMIT 15
  `).all();

  // ── At-risk customers (valuable first) ──
  const atRisk = sqlite.prepare(`
    SELECT c.id AS companyId, c.name AS name, COALESCE(s.name, c.segment) AS segment,
           c.state, ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.health_status AS health, ca.last_order_at AS lastOrderAt,
           ca.next_reorder_estimate AS nextReorder,
           CAST(julianday('now') - julianday(ca.last_order_at) AS INTEGER) AS daysSinceLastOrder
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    WHERE ca.health_status IN ('at_risk','churning')
    ORDER BY ca.lifetime_value DESC
    LIMIT 20
  `).all();

  // ── By state ──
  const byState = sqlite.prepare(`
    SELECT COALESCE(c.state, '—') AS state,
           COUNT(*) AS customers,
           COALESCE(SUM(ca.lifetime_value), 0) AS revenue
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    GROUP BY c.state
    ORDER BY revenue DESC
  `).all();

  // ── Geo points (map) ──
  const geoPoints = sqlite.prepare(`
    SELECT c.id AS companyId, c.name AS name, c.city, c.state, c.country,
           c.latitude AS lat, c.longitude AS lng,
           ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.health_status AS health
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
  `).all();

  // ── Distributions ──
  const byHealth = sqlite.prepare(`
    SELECT health_status AS status, COUNT(*) AS count, COALESCE(SUM(lifetime_value),0) AS revenue
    FROM customer_accounts GROUP BY health_status
  `).all();
  const byTier = sqlite.prepare(`
    SELECT tier, COUNT(*) AS count, COALESCE(SUM(lifetime_value),0) AS revenue
    FROM customer_accounts GROUP BY tier
  `).all();

  // ── Geocoding progress ──
  const geocode = sqlite.prepare(`
    SELECT
      SUM(CASE WHEN c.latitude IS NOT NULL THEN 1 ELSE 0 END) AS mapped,
      SUM(CASE WHEN c.geocoded_at IS NULL THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM customer_accounts ca JOIN companies c ON c.id = ca.company_id
  `).get() as Record<string, number>;

  return NextResponse.json({
    kpi: { ...kpi, newThisMonth },
    bestCustomers,
    atRisk,
    byState,
    geoPoints,
    byHealth,
    byTier,
    geocode,
  });
}
