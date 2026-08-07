export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";

/**
 * GTM analytics: which signals we hold actually predict a first order.
 *
 * GET /api/admin/ops/gtm  (x-ops-key)
 *
 * Every lead attribute The Frame stores — ICP tier, source, Google rating,
 * Shopify platform, employee count, whether they already carry eyewear,
 * whether they were an A.J. Morgan customer — is cross-tabbed against the one
 * outcome that matters: did they place a Jaxy order.
 *
 * Read-only, and deliberately honest about denominators. A conversion rate
 * quoted without its base is a way of not answering the question, so every
 * row carries `leads` alongside `converted`.
 */

/** A company has converted when it has a real order, not when a field says so. */
const CONVERTED = `EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned'))`;
const REVENUE = `(SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned'))`;

/**
 * Cross-tab one attribute against conversion.
 *
 * `minLeads` guards against the classic false finding: a bucket of three
 * leads with one customer reads as 33% and means nothing.
 */
function breakdown(label: string, expr: string, opts: { minLeads?: number; limit?: number } = {}) {
  const minLeads = opts.minLeads ?? 20;
  const rows = sqlite.prepare(`
    SELECT ${expr} AS bucket,
           COUNT(*) AS leads,
           SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
           ROUND(SUM(${REVENUE}), 2) AS revenue
    FROM companies c
    GROUP BY bucket
    HAVING bucket IS NOT NULL AND TRIM(CAST(bucket AS TEXT)) != ''
    ORDER BY leads DESC
    LIMIT ${opts.limit ?? 40}
  `).all() as Array<{ bucket: string; leads: number; converted: number; revenue: number }>;

  return {
    attribute: label,
    buckets: rows
      .filter((r) => r.leads >= minLeads)
      .map((r) => ({
        ...r,
        conversionPct: Math.round((r.converted / r.leads) * 10000) / 100,
        revenuePerLead: Math.round((r.revenue / r.leads) * 100) / 100,
      }))
      .sort((a, b) => b.conversionPct - a.conversionPct),
    excludedThinBuckets: rows.filter((r) => r.leads < minLeads).length,
  };
}

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const base = sqlite.prepare(`
    SELECT COUNT(*) AS leads,
           SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
           ROUND(SUM(${REVENUE}), 2) AS revenue
    FROM companies c
  `).get() as { leads: number; converted: number; revenue: number };

  const overall = {
    leads: base.leads,
    customers: base.converted,
    conversionPct: Math.round((base.converted / Math.max(base.leads, 1)) * 10000) / 100,
    revenue: base.revenue,
    revenuePerLead: Math.round((base.revenue / Math.max(base.leads, 1)) * 100) / 100,
  };

  // ── Funnel ──
  const byStatus = sqlite.prepare(`
    SELECT COALESCE(NULLIF(status,''),'(none)') AS status, COUNT(*) AS leads,
           SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
    FROM companies c GROUP BY status ORDER BY leads DESC
  `).all();

  // ── The signal Alex Vacca ranks first: former customers of a dead supplier ──
  const ajm = sqlite.prepare(`
    SELECT
      CASE
        WHEN a.revenue IS NULL THEN 'no AJM history'
        WHEN a.revenue >= 20000 THEN 'AJM $20k+'
        WHEN a.revenue >= 5000  THEN 'AJM $5k–20k'
        WHEN a.revenue >= 1000  THEN 'AJM $1k–5k'
        ELSE 'AJM under $1k'
      END AS bucket,
      COUNT(*) AS leads,
      SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
      ROUND(SUM(${REVENUE}), 2) AS revenue
    FROM companies c
    LEFT JOIN (
      SELECT company_id, SUM(total) AS revenue FROM ajm_orders
      WHERE cancelled = 0 AND order_date >= '2022-01-01' AND company_id IS NOT NULL
      GROUP BY company_id
    ) a ON a.company_id = c.id
    GROUP BY bucket ORDER BY leads DESC
  `).all() as Array<{ bucket: string; leads: number; converted: number; revenue: number }>;

  // ── How long from record created to first order (the ones that converted) ──
  const speed = sqlite.prepare(`
    SELECT
      CASE
        WHEN d <= 7 THEN '0–7 days'
        WHEN d <= 30 THEN '8–30 days'
        WHEN d <= 90 THEN '31–90 days'
        WHEN d <= 365 THEN '91–365 days'
        ELSE 'over a year'
      END AS bucket, COUNT(*) AS customers
    FROM (
      SELECT CAST(julianday(MIN(o.placed_at)) - julianday(c.created_at) AS INTEGER) AS d
      FROM companies c JOIN orders o ON o.company_id = c.id
      WHERE o.status NOT IN ('cancelled','returned') AND o.placed_at IS NOT NULL AND c.created_at IS NOT NULL
      GROUP BY c.id
    ) WHERE d >= 0 GROUP BY bucket
  `).all();

  // ── Do the things we spend money on actually correlate? ──
  const attributes = [
    breakdown("ICP tier", "c.icp_tier"),
    breakdown("ICP score band", `CASE WHEN c.icp_score IS NULL THEN NULL
      WHEN c.icp_score >= 80 THEN '80+' WHEN c.icp_score >= 60 THEN '60–79'
      WHEN c.icp_score >= 40 THEN '40–59' ELSE 'under 40' END`),
    breakdown("Lead source", "c.source"),
    breakdown("Source type", "c.source_type"),
    breakdown("Segment", "COALESCE(c.segment, c.category)"),
    breakdown("Country", "c.country"),
    breakdown("US state", "CASE WHEN COALESCE(c.country,'US') IN ('US','USA','United States') THEN c.state END"),
    breakdown("Ecommerce platform", "c.ecom_platform"),
    breakdown("Already carries eyewear", `CASE WHEN TRIM(COALESCE(c.top_brand,'')) != '' THEN 'yes' ELSE 'no' END`, { minLeads: 50 }),
    breakdown("Eyewear SKU count", `CASE WHEN c.eyewear_sku_count IS NULL THEN NULL
      WHEN c.eyewear_sku_count >= 100 THEN '100+' WHEN c.eyewear_sku_count >= 25 THEN '25–99'
      WHEN c.eyewear_sku_count >= 1 THEN '1–24' ELSE 'zero' END`),
    breakdown("Google rating", `CASE WHEN c.google_rating IS NULL OR c.google_rating = 0 THEN NULL
      WHEN c.google_rating >= 4.7 THEN '4.7+' WHEN c.google_rating >= 4.3 THEN '4.3–4.7'
      WHEN c.google_rating >= 3.8 THEN '3.8–4.3' ELSE 'under 3.8' END`),
    breakdown("Google review count", `CASE WHEN c.google_review_count IS NULL THEN NULL
      WHEN c.google_review_count >= 400 THEN '400+' WHEN c.google_review_count >= 100 THEN '100–399'
      WHEN c.google_review_count >= 25 THEN '25–99' ELSE 'under 25' END`),
    breakdown("Employees", `CASE WHEN c.employee_count IS NULL THEN NULL
      WHEN c.employee_count >= 50 THEN '50+' WHEN c.employee_count >= 10 THEN '10–49'
      WHEN c.employee_count >= 3 THEN '3–9' ELSE '1–2' END`),
    breakdown("Est. yearly sales", `CASE WHEN c.estimated_yearly_sales_cents IS NULL THEN NULL
      WHEN c.estimated_yearly_sales_cents >= 500000000 THEN '$5M+'
      WHEN c.estimated_yearly_sales_cents >= 100000000 THEN '$1M–5M'
      WHEN c.estimated_yearly_sales_cents >= 25000000 THEN '$250k–1M'
      ELSE 'under $250k' END`),
    breakdown("Has a contactable email", `CASE WHEN EXISTS (
      SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email,'')) != ''
        AND LOWER(ct.email) NOT LIKE '%@relay.faire.com%') THEN 'yes' ELSE 'no' END`, { minLeads: 50 }),
    breakdown("Has a phone", `CASE WHEN EXISTS (
      SELECT 1 FROM company_phones p WHERE p.company_id = c.id) THEN 'yes' ELSE 'no' END`, { minLeads: 50 }),
    breakdown("Has a Google listing", `CASE WHEN EXISTS (
      SELECT 1 FROM gmaps_listings g WHERE g.company_id = c.id) THEN 'yes' ELSE 'no' END`, { minLeads: 50 }),
  ];

  // ── Outreach: did the campaigns move anything? ──
  let campaigns: unknown = null;
  try {
    campaigns = sqlite.prepare(`
      SELECT cp.name, cp.status,
             COUNT(DISTINCT cl.company_id) AS enrolled,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.company_id = cl.company_id
                   AND o.status NOT IN ('cancelled','returned')) THEN 1 ELSE 0 END) AS converted
      FROM campaign_leads cl JOIN campaigns cp ON cp.id = cl.campaign_id
      GROUP BY cl.campaign_id HAVING enrolled >= 10 ORDER BY enrolled DESC LIMIT 25
    `).all();
  } catch { /* table shape differs */ }

  // ── Coverage: a signal we do not hold cannot be scored on ──
  const coverage = sqlite.prepare(`
    SELECT
      COUNT(*) AS leads,
      SUM(CASE WHEN TRIM(COALESCE(c.domain,'')) != '' OR TRIM(COALESCE(c.website,'')) != '' THEN 1 ELSE 0 END) AS withSite,
      SUM(CASE WHEN c.icp_tier IS NOT NULL THEN 1 ELSE 0 END) AS withIcp,
      SUM(CASE WHEN c.storeleads_id IS NOT NULL THEN 1 ELSE 0 END) AS withStoreleads,
      SUM(CASE WHEN TRIM(COALESCE(c.top_brand,'')) != '' THEN 1 ELSE 0 END) AS withEyewear,
      SUM(CASE WHEN c.google_rating IS NOT NULL THEN 1 ELSE 0 END) AS withGoogle,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id
            AND TRIM(COALESCE(ct.email,'')) != '') THEN 1 ELSE 0 END) AS withEmail,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM company_phones p WHERE p.company_id = c.id) THEN 1 ELSE 0 END) AS withPhone
    FROM companies c
  `).get();

  return NextResponse.json({
    generatedFor: "GTM signal analysis",
    overall,
    byStatus,
    ajmSignal: ajm.map((r) => ({
      ...r,
      conversionPct: Math.round((r.converted / Math.max(r.leads, 1)) * 10000) / 100,
      revenuePerLead: Math.round((r.revenue / Math.max(r.leads, 1)) * 100) / 100,
    })),
    timeToFirstOrder: speed,
    attributes,
    campaigns,
    coverage,
  });
}
