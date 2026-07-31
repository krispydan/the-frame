export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/customers/analytics?segment=all|retail|wholesale
 * Everything the customer analytics dashboard needs, in one call:
 *   - KPIs (customer count, total LTV, avg LTV, at-risk count, new this month)
 *   - Best customers (top by lifetime value)
 *   - At-risk customers (health at_risk/churning, ranked by LTV so we chase
 *     the valuable ones first)
 *   - By-state breakdown (customer count + revenue)
 *   - Geo points (customers with lat/lng, for the map)
 *   - Health + tier distributions
 *   - Geocoding progress (how many customers still need coordinates)
 *   - segmentCounts (retail vs wholesale headline numbers for the toggle)
 *
 * ── Retail vs wholesale ──────────────────────────────────────────────
 * Retail and wholesale are run as different strategies, so the whole view
 * can be scoped to one segment. A customer has no channel column of its
 * own — the signal lives on its ORDERS (`orders.channel`):
 *   • retail    → shopify_dtc  (the getjaxy consumer store)
 *   • wholesale → shopify_wholesale, faire, direct, phone  (B2B)
 * We classify each company by the channel that drove the MAJORITY of its
 * (non-cancelled) revenue. Companies with no classifiable orders default
 * to wholesale, since the account/CRM population is B2B-first.
 */

// Shared CTE: company_id → 'retail' | 'wholesale', by dominant revenue.
const SEGMENT_CTE = `
  WITH company_segment AS (
    SELECT
      company_id,
      CASE WHEN
        SUM(CASE WHEN channel = 'shopify_dtc' THEN total ELSE 0 END) >
        SUM(CASE WHEN channel IN ('shopify_wholesale','faire','direct','phone') THEN total ELSE 0 END)
      THEN 'retail' ELSE 'wholesale' END AS segment
    FROM orders
    WHERE company_id IS NOT NULL AND status NOT IN ('cancelled','returned')
    GROUP BY company_id
  )
`;

type Segment = "all" | "retail" | "wholesale";

// WHERE fragment scoping to a segment. `cs` is the company_segment join;
// unclassified companies (no orders) fall back to 'wholesale'.
function segmentFilter(segment: Segment): string {
  if (segment === "retail") return "AND COALESCE(cs.segment, 'wholesale') = 'retail'";
  if (segment === "wholesale") return "AND COALESCE(cs.segment, 'wholesale') = 'wholesale'";
  return "";
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("segment");
  const segment: Segment = raw === "retail" || raw === "wholesale" ? raw : "all";
  const seg = segmentFilter(segment);

  // ── KPIs ──
  const kpi = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT
      COUNT(*) AS customerCount,
      COALESCE(SUM(ca.lifetime_value), 0) AS totalLtv,
      COALESCE(AVG(ca.lifetime_value), 0) AS avgLtv,
      COALESCE(SUM(ca.total_orders), 0) AS totalOrders,
      SUM(CASE WHEN ca.health_status IN ('at_risk','churning') THEN 1 ELSE 0 END) AS atRiskCount,
      SUM(CASE WHEN ca.health_status = 'churned' THEN 1 ELSE 0 END) AS churnedCount
    FROM customer_accounts ca
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
  `).get() as Record<string, number>;

  const newThisMonth = (sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT COUNT(*) AS c FROM customer_accounts ca
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE ca.first_order_at >= date('now', 'start of month') ${seg}
  `).get() as { c: number }).c;

  // ── Best customers ──
  const bestCustomers = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT c.id AS companyId, c.name AS name, COALESCE(s.name, c.segment) AS segment,
           c.state, ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.avg_order_value AS aov, ca.health_status AS health, ca.last_order_at AS lastOrderAt
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
    ORDER BY ca.lifetime_value DESC
    LIMIT 15
  `).all();

  // ── At-risk customers (valuable first) ──
  const atRisk = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT c.id AS companyId, c.name AS name, COALESCE(s.name, c.segment) AS segment,
           c.state, ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.health_status AS health, ca.last_order_at AS lastOrderAt,
           ca.next_reorder_estimate AS nextReorder,
           CAST(julianday('now') - julianday(ca.last_order_at) AS INTEGER) AS daysSinceLastOrder
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE ca.health_status IN ('at_risk','churning') ${seg}
    ORDER BY ca.lifetime_value DESC
    LIMIT 20
  `).all();

  // ── By state ──
  const byState = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT COALESCE(c.state, '—') AS state,
           COUNT(*) AS customers,
           COALESCE(SUM(ca.lifetime_value), 0) AS revenue
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
    GROUP BY c.state
    ORDER BY revenue DESC
  `).all();

  // ── Geo points (map) ──
  const geoPoints = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT c.id AS companyId, c.name AS name, c.city, c.state, c.country,
           c.latitude AS lat, c.longitude AS lng,
           ca.tier, ca.lifetime_value AS ltv, ca.total_orders AS orders,
           ca.health_status AS health
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL ${seg}
  `).all();

  // ── Distributions ──
  const byHealth = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT ca.health_status AS status, COUNT(*) AS count, COALESCE(SUM(ca.lifetime_value),0) AS revenue
    FROM customer_accounts ca
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
    GROUP BY ca.health_status
  `).all();
  const byTier = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT ca.tier, COUNT(*) AS count, COALESCE(SUM(ca.lifetime_value),0) AS revenue
    FROM customer_accounts ca
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
    GROUP BY ca.tier
  `).all();

  // ── Geocoding progress ──
  const geocode = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT
      SUM(CASE WHEN c.latitude IS NOT NULL THEN 1 ELSE 0 END) AS mapped,
      SUM(CASE WHEN c.geocoded_at IS NULL THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    WHERE 1=1 ${seg}
  `).get() as Record<string, number>;

  // ── Segment headline counts (both, always — drives the toggle labels) ──
  const segmentRows = sqlite.prepare(`
    ${SEGMENT_CTE}
    SELECT COALESCE(cs.segment, 'wholesale') AS segment,
           COUNT(*) AS customers,
           COALESCE(SUM(ca.lifetime_value), 0) AS revenue
    FROM customer_accounts ca
    LEFT JOIN company_segment cs ON cs.company_id = ca.company_id
    GROUP BY COALESCE(cs.segment, 'wholesale')
  `).all() as Array<{ segment: string; customers: number; revenue: number }>;
  const segmentCounts = {
    retail: segmentRows.find((r) => r.segment === "retail") ?? { segment: "retail", customers: 0, revenue: 0 },
    wholesale: segmentRows.find((r) => r.segment === "wholesale") ?? { segment: "wholesale", customers: 0, revenue: 0 },
  };

  return NextResponse.json({
    segment,
    segmentCounts,
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
