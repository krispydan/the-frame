/**
 * Per-ASIN profitability, month over month.
 *
 * The reference report this mirrors carries a footnote admitting its COGS is
 * "a single flat $5.00 applied to every ASIN and every month". That makes its
 * per-line margins indicative. Ours are real FIFO landed cost — product,
 * freight and duties, traceable to a purchase order — so a margin here can be
 * argued with rather than merely eyeballed.
 *
 * Two columns the reference report does not have, both of which change what
 * you conclude from a row:
 *
 *   - **Paid versus seeded units.** An ASIN can look like the strongest
 *     seller on the page and be almost entirely Vine.
 *   - **Sessions and conversion.** Units alone cannot tell a traffic problem
 *     from a conversion problem. A SKU with sessions and no orders is priced
 *     or reviewed wrong; a SKU with neither is invisible. Those need opposite
 *     responses.
 *
 * Fees are apportioned, not per-line: Amazon settles at account level for
 * everything except the referral and FBA fees it attributes to an order, and
 * pretending otherwise would invent precision. `feesAreApportioned` says so.
 */

import { sqlite } from "@/lib/db";
import { recentAmazonMonths, monthBounds } from "./periods";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export interface AsinMonthCell {
  month: string;
  grossSales: number;
  giveaway: number;
  netSales: number;
  units: number;
  freeUnits: number;
  cogs: number;
  /** Apportioned Amazon fees. */
  fees: number;
  /** netSales − fees − cogs. Excludes advertising. */
  contribution: number;
  /** Null rather than zero when there were no paid sales to take a margin of. */
  marginPct: number | null;
  sessions: number;
  /** Units ordered ÷ sessions. Null when no sessions were recorded. */
  conversionPct: number | null;
}

export interface AsinProfitabilityRow {
  sku: string;
  asin: string | null;
  parentAsin: string | null;
  title: string | null;
  months: AsinMonthCell[];
  /** Totals across the window, for sorting and for the row summary. */
  totalNetSales: number;
  totalUnits: number;
  totalFreeUnits: number;
  totalContribution: number;
  totalMarginPct: number | null;
  landedCostPerUnit: number | null;
  /** True when the row lost money over the window — the red rows. */
  lossMaking: boolean;
  /** True when most units shipped for nothing. */
  mostlySeeded: boolean;
}

export interface AsinProfitabilityReport {
  months: string[];
  rows: AsinProfitabilityRow[];
  feesAreApportioned: boolean;
  adSpendAvailable: boolean;
  notes: string[];
}

export function buildAsinProfitability(opts?: {
  months?: number;
  limit?: number;
}): AsinProfitabilityReport {
  const months = recentAmazonMonths(opts?.months ?? 3);
  const notes: string[] = [];

  if (months.length === 0) {
    return { months: [], rows: [], feesAreApportioned: true, adSpendAvailable: false,
      notes: ["No Amazon orders in the window."] };
  }

  const from = monthBounds(months[0]).start;
  const to = monthBounds(months[months.length - 1]).end;

  // Per SKU per month, from the raw archive.
  const sales = sqlite.prepare(`
    SELECT
      r.sku AS sku,
      MAX(r.asin) AS asin,
      substr(date(r.purchase_date), 1, 7) AS month,
      IFNULL(SUM(r.item_price), 0) AS gross,
      IFNULL(SUM(r.item_promotion_discount + r.ship_promotion_discount), 0) AS giveaway,
      IFNULL(SUM(r.quantity), 0) AS units,
      IFNULL(SUM(CASE WHEN r.item_promotion_discount >= r.item_price - 0.005
                       AND r.item_price > 0.005 THEN r.quantity ELSE 0 END), 0) AS freeUnits
    FROM amazon_order_rows r
    WHERE date(r.purchase_date) BETWEEN ? AND ?
      AND IFNULL(LOWER(r.item_status), '') != 'cancelled'
    GROUP BY r.sku, month
  `).all(from, to) as Array<{
    sku: string; asin: string | null; month: string;
    gross: number; giveaway: number; units: number; freeUnits: number;
  }>;

  // COGS per SKU per month, excluding seeded units — those are marketing.
  const cogs = sqlite.prepare(`
    SELECT oi.sku AS sku, substr(date(d.depleted_at), 1, 7) AS month,
           IFNULL(SUM(CASE WHEN IFNULL(oi.discount, 0) >= oi.total_price - 0.005
                            AND oi.total_price > 0.005 THEN 0
                           ELSE d.quantity * (l.unit_cost + l.freight_per_unit + l.duties_per_unit)
                      END), 0) AS cogs
    FROM inventory_cost_depletions d
    JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
    JOIN order_items oi ON oi.id = d.order_item_id
    WHERE d.channel = 'amazon' AND date(d.depleted_at) BETWEEN ? AND ?
    GROUP BY oi.sku, month
  `).all(from, to) as Array<{ sku: string; month: string; cogs: number }>;

  // Traffic is reported by ASIN; money by SKU. Nothing else bridges them.
  const traffic = sqlite.prepare(`
    SELECT child_asin AS asin, MAX(parent_asin) AS parentAsin,
           substr(date, 1, 7) AS month,
           IFNULL(SUM(sessions), 0) AS sessions,
           IFNULL(SUM(units_ordered), 0) AS unitsOrdered
    FROM amazon_asin_traffic_daily WHERE date BETWEEN ? AND ?
    GROUP BY child_asin, month
  `).all(from, to) as Array<{
    asin: string; parentAsin: string | null; month: string;
    sessions: number; unitsOrdered: number;
  }>;

  // Account-level fees per month, apportioned by each SKU's share of paid
  // sales. Amazon settles most fees at account level, so a per-line figure
  // would be invented precision — but omitting them entirely would overstate
  // every margin on the page, which is worse.
  const feesByMonth = new Map<string, number>();
  for (const r of sqlite.prepare(`
    SELECT substr(IFNULL(s.period_end, s.period_start), 1, 7) AS month,
           IFNULL(SUM(CASE WHEN sli.type = 'fee' THEN -sli.amount ELSE 0 END), 0) AS fees
    FROM settlement_line_items sli JOIN settlements s ON s.id = sli.settlement_id
    WHERE s.channel = 'amazon' GROUP BY month
  `).all() as Array<{ month: string; fees: number }>) {
    feesByMonth.set(r.month, r.fees);
  }

  const netByMonth = new Map<string, number>();
  for (const s of sales) {
    netByMonth.set(s.month, (netByMonth.get(s.month) ?? 0) + (s.gross - s.giveaway));
  }

  const titles = new Map<string, string>();
  for (const t of sqlite.prepare(`
    SELECT sku, title FROM amazon_listings WHERE title IS NOT NULL
  `).all() as Array<{ sku: string; title: string }>) {
    titles.set(t.sku, t.title);
  }

  const landed = new Map<string, number>();
  for (const c of sqlite.prepare(`
    SELECT cs.sku AS sku,
           (SELECT x.landed_cost_per_unit FROM inventory_cost_layers x
             WHERE x.sku_id = cs.id AND x.remaining_quantity > 0
             ORDER BY x.received_at ASC, x.created_at ASC LIMIT 1) AS landed
    FROM catalog_skus cs WHERE cs.sku IS NOT NULL
  `).all() as Array<{ sku: string; landed: number | null }>) {
    if (c.landed != null) landed.set(c.sku, c.landed);
  }

  const cogsKey = new Map(cogs.map((c) => [`${c.sku}|${c.month}`, c.cogs]));
  const trafficByAsin = new Map(traffic.map((t) => [`${t.asin}|${t.month}`, t]));
  const parentByAsin = new Map<string, string>();
  for (const t of traffic) {
    if (t.parentAsin && !parentByAsin.has(t.asin)) parentByAsin.set(t.asin, t.parentAsin);
  }

  // Group by SKU, since that is what money is reported against.
  const bySku = new Map<string, typeof sales>();
  for (const s of sales) {
    const list = bySku.get(s.sku) ?? [];
    list.push(s);
    bySku.set(s.sku, list);
  }

  const rows: AsinProfitabilityRow[] = [];
  for (const [sku, skuSales] of bySku) {
    const asin = skuSales.find((s) => s.asin)?.asin ?? null;
    const internal = sku.replace(/-FBA$/i, "");

    const cells: AsinMonthCell[] = months.map((month) => {
      const s = skuSales.find((x) => x.month === month);
      const gross = round2(s?.gross ?? 0);
      const giveaway = round2(s?.giveaway ?? 0);
      const netSales = round2(gross - giveaway);
      const c = round2(cogsKey.get(`${sku}|${month}`) ?? 0);

      const monthFees = feesByMonth.get(month) ?? 0;
      const monthNet = netByMonth.get(month) ?? 0;
      const fees = monthNet > 0 ? round2(monthFees * (netSales / monthNet)) : 0;

      const t = asin ? trafficByAsin.get(`${asin}|${month}`) : undefined;
      const contribution = round2(netSales - fees - c);

      return {
        month, grossSales: gross, giveaway, netSales,
        units: s?.units ?? 0, freeUnits: s?.freeUnits ?? 0,
        cogs: c, fees, contribution,
        // Null, not zero: a month with no paid sales has no margin, and 0%
        // would sort and colour as though it were a break-even month.
        marginPct: netSales > 0 ? pct(contribution, netSales) : null,
        sessions: t?.sessions ?? 0,
        conversionPct: t && t.sessions > 0 ? pct(t.unitsOrdered, t.sessions) : null,
      };
    });

    const totalNetSales = round2(cells.reduce((t, c) => t + c.netSales, 0));
    const totalContribution = round2(cells.reduce((t, c) => t + c.contribution, 0));
    const totalUnits = cells.reduce((t, c) => t + c.units, 0);
    const totalFreeUnits = cells.reduce((t, c) => t + c.freeUnits, 0);

    rows.push({
      sku, asin,
      // Any month's parent, not just the latest. Resolving from the latest
      // month alone left the parent null for every ASIN that had no traffic
      // that month — 51 of 63 rows — which silently breaks any roll-up to
      // the parent level, and Amazon reports Vine enrolment by parent.
      parentAsin: asin ? parentByAsin.get(asin) ?? null : null,
      title: titles.get(sku) ?? titles.get(internal) ?? null,
      months: cells,
      totalNetSales, totalUnits, totalFreeUnits, totalContribution,
      totalMarginPct: totalNetSales > 0 ? pct(totalContribution, totalNetSales) : null,
      landedCostPerUnit: landed.get(internal) ?? null,
      lossMaking: totalContribution < 0,
      mostlySeeded: totalUnits > 0 && totalFreeUnits / totalUnits >= 0.5,
    });
  }

  // Sort by the latest month's paid sales, matching the reference report.
  const latest = months[months.length - 1];
  rows.sort((a, b) => {
    const av = a.months.find((m) => m.month === latest)?.netSales ?? 0;
    const bv = b.months.find((m) => m.month === latest)?.netSales ?? 0;
    if (bv !== av) return bv - av;
    return b.totalNetSales - a.totalNetSales;
  });

  notes.push(
    "Fees are apportioned across SKUs by share of paid sales. Amazon settles most fees at account level, " +
    "so a per-line figure would be invented precision — but omitting them would overstate every margin here.",
  );
  notes.push("COGS is real FIFO landed cost (product + freight + duties), excluding units given away.");
  notes.push("Contribution excludes advertising — no source until the Amazon Ads connector is linked.");

  const noTitles = rows.filter((r) => !r.title).length;
  if (noTitles > 0) {
    notes.push(`${noTitles} SKU(s) have no title — run the listings sync so rows read as product names.`);
  }
  if (traffic.length === 0) {
    notes.push("No per-ASIN traffic held for this window, so sessions and conversion are blank rather than zero.");
  }

  return {
    months, rows: opts?.limit ? rows.slice(0, opts.limit) : rows,
    feesAreApportioned: true, adSpendAvailable: false, notes,
  };
}
