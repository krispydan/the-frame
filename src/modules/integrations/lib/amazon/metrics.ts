/**
 * Amazon dashboard metrics.
 *
 * Reads exclusively from local tables, never from Windsor. That keeps the
 * page fast, keeps it working when Windsor is down, and means it still
 * renders history that has aged out of Amazon's 90-day settlement window.
 *
 * The framing throughout is contribution, not gross. Gross sales alone are
 * actively misleading for this channel right now — promotions ran at 71% of
 * gross during launch, so a dashboard leading with gross revenue would
 * suggest a healthy business where the settlement nets out to roughly zero.
 */

import { sqlite } from "@/lib/db";

export interface AmazonMetricsRange {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface AmazonHeadline {
  grossSales: number;
  promotions: number;
  promotionsPctOfGross: number | null;
  netSales: number;
  units: number;
  orders: number;
  refunds: number;
  refundRatePct: number | null;
  referralFees: number;
  fbaFees: number;
  otherFees: number;
  totalFees: number;
  feeLoadPct: number | null;
  cogs: number;
  /** Net sales less fees less COGS. The number that actually matters. */
  contributionMargin: number;
  contributionMarginPct: number | null;
  /** False when some sold units have no cost attached, so margin is optimistic. */
  hasFullCostData: boolean;
}

export interface AmazonDailyPoint {
  date: string;
  grossSales: number;
  promotions: number;
  netSales: number;
  unitsOrdered: number;
  unitsShipped: number;
  sessions: number | null;
  pageViews: number | null;
  buyBoxPct: number | null;
  conversionRate: number | null;
}

export interface AmazonSkuRow {
  sku: string;
  internalSku: string | null;
  units: number;
  revenue: number;
  cogs: number;
  contribution: number;
  fbaFulfillable: number | null;
  fbaInbound: number | null;
}

export interface AmazonSettlementRow {
  settlementId: string;
  periodStart: string | null;
  periodEnd: string | null;
  gross: number;
  fees: number;
  adjustments: number;
  net: number;
  status: string;
  receivedAt: string | null;
  xeroTransactionId: string | null;
}

export interface AmazonInventoryRow {
  sku: string;
  internalSku: string | null;
  fbaFulfillable: number;
  fbaInbound: number;
  fbaReserved: number;
  fbaUnsellable: number;
  fbaTotal: number;
  /** ShipHero on-hand, which excludes anything sitting at Amazon. */
  warehouseOnHand: number | null;
  /** ShipHero + everything at or heading to Amazon. */
  totalOwned: number;
}

export interface AmazonSyncHealthRow {
  reportName: string;
  lastStatus: string | null;
  lastSuccessAt: string | null;
  lastSyncedThrough: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number): number | null =>
  den === 0 ? null : round2((num / den) * 100);

/**
 * Headline figures for a date range.
 *
 * Revenue comes from imported orders (which carry promotions per line);
 * fees come from bridged settlements. The two have different natural
 * periods — a settlement spans two weeks and covers orders placed before
 * it — so fees are attributed by settlement period overlap rather than
 * pretending they align day-for-day.
 */
export function getAmazonHeadline(range: AmazonMetricsRange): AmazonHeadline {
  const orderAgg = sqlite.prepare(`
    SELECT
      IFNULL(SUM(o.subtotal), 0) AS grossSales,
      IFNULL(SUM(o.discount), 0) AS promotions,
      COUNT(*) AS orders
    FROM orders o
    WHERE o.channel = 'amazon'
      AND o.status != 'cancelled'
      AND date(o.placed_at) BETWEEN ? AND ?
  `).get(range.from, range.to) as { grossSales: number; promotions: number; orders: number };

  const unitAgg = sqlite.prepare(`
    SELECT IFNULL(SUM(oi.quantity), 0) AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.channel = 'amazon' AND o.status != 'cancelled'
      AND date(o.placed_at) BETWEEN ? AND ?
  `).get(range.from, range.to) as { units: number };

  // Fees and refunds from settlements whose period overlaps the range.
  const feeAgg = sqlite.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN sli.description = 'Referral commission' THEN -sli.amount ELSE 0 END), 0) AS referral,
      IFNULL(SUM(CASE WHEN sli.description IN ('FBA fulfilment fees','FBA storage fees') THEN -sli.amount ELSE 0 END), 0) AS fba,
      IFNULL(SUM(CASE WHEN sli.type = 'fee' AND sli.description NOT IN ('Referral commission','FBA fulfilment fees','FBA storage fees') THEN -sli.amount ELSE 0 END), 0) AS other,
      IFNULL(SUM(CASE WHEN sli.type = 'refund' THEN -sli.amount ELSE 0 END), 0) AS refunds
    FROM settlement_line_items sli
    JOIN settlements s ON s.id = sli.settlement_id
    WHERE s.channel = 'amazon'
      AND IFNULL(s.period_end, s.period_start) >= ?
      AND IFNULL(s.period_start, s.period_end) <= ?
  `).get(range.from, range.to) as { referral: number; fba: number; other: number; refunds: number };

  // COGS from FIFO depletions attributed to Amazon.
  const cogsAgg = sqlite.prepare(`
    SELECT
      IFNULL(SUM(d.quantity * (l.unit_cost + l.freight_per_unit + l.duties_per_unit)), 0) AS cogs,
      IFNULL(SUM(d.quantity), 0) AS costedUnits
    FROM inventory_cost_depletions d
    JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
    WHERE d.channel = 'amazon' AND date(d.depleted_at) BETWEEN ? AND ?
  `).get(range.from, range.to) as { cogs: number; costedUnits: number };

  const grossSales = round2(orderAgg.grossSales);
  const promotions = round2(orderAgg.promotions);
  const netSales = round2(grossSales - promotions);
  const referralFees = round2(feeAgg.referral);
  const fbaFees = round2(feeAgg.fba);
  const otherFees = round2(feeAgg.other);
  const totalFees = round2(referralFees + fbaFees + otherFees);
  const refunds = round2(feeAgg.refunds);
  const cogs = round2(cogsAgg.cogs);
  const contribution = round2(netSales - totalFees - refunds - cogs);

  return {
    grossSales,
    promotions,
    promotionsPctOfGross: pct(promotions, grossSales),
    netSales,
    units: unitAgg.units,
    orders: orderAgg.orders,
    refunds,
    refundRatePct: pct(refunds, netSales),
    referralFees,
    fbaFees,
    otherFees,
    totalFees,
    feeLoadPct: pct(totalFees, grossSales),
    cogs,
    contributionMargin: contribution,
    contributionMarginPct: pct(contribution, netSales),
    // Every sold unit should have a matching depletion. A shortfall means
    // COGS is understated and margin therefore flattering.
    hasFullCostData: unitAgg.units === 0 || cogsAgg.costedUnits >= unitAgg.units,
  };
}

/**
 * Daily series. Sales come from imported orders and traffic from Amazon's
 * own report, joined on date — an outer join so a day with traffic but no
 * sales (or the reverse) still appears rather than silently vanishing from
 * the chart.
 */
export function getAmazonDaily(range: AmazonMetricsRange): AmazonDailyPoint[] {
  return sqlite.prepare(`
    WITH days AS (
      SELECT date(placed_at) AS d,
             IFNULL(SUM(subtotal), 0) AS gross,
             IFNULL(SUM(discount), 0) AS promo
      FROM orders
      WHERE channel = 'amazon' AND status != 'cancelled'
        AND date(placed_at) BETWEEN ? AND ?
      GROUP BY date(placed_at)
    ),
    traffic AS (
      SELECT date, units_ordered, units_shipped, sessions, page_views, buy_box_pct, conversion_rate
      FROM amazon_sales_traffic_daily
      WHERE date BETWEEN ? AND ?
    ),
    allDates AS (
      SELECT d AS date FROM days
      UNION
      SELECT date FROM traffic
    )
    SELECT
      a.date AS date,
      IFNULL(days.gross, 0) AS grossSales,
      IFNULL(days.promo, 0) AS promotions,
      IFNULL(days.gross, 0) - IFNULL(days.promo, 0) AS netSales,
      IFNULL(traffic.units_ordered, 0) AS unitsOrdered,
      IFNULL(traffic.units_shipped, 0) AS unitsShipped,
      traffic.sessions AS sessions,
      traffic.page_views AS pageViews,
      traffic.buy_box_pct AS buyBoxPct,
      traffic.conversion_rate AS conversionRate
    FROM allDates a
    LEFT JOIN days ON days.d = a.date
    LEFT JOIN traffic ON traffic.date = a.date
    ORDER BY a.date ASC
  `).all(range.from, range.to, range.from, range.to) as AmazonDailyPoint[];
}

/** Top SKUs by contribution, with FBA stock alongside so a strong seller running low is obvious. */
export function getAmazonSkus(range: AmazonMetricsRange, limit = 20): AmazonSkuRow[] {
  return sqlite.prepare(`
    SELECT
      oi.sku AS sku,
      MAX(oi.product_name) AS internalSku,
      SUM(oi.quantity) AS units,
      ROUND(SUM(oi.total_price), 2) AS revenue,
      ROUND(IFNULL((
        SELECT SUM(d.quantity * (l.unit_cost + l.freight_per_unit + l.duties_per_unit))
        FROM inventory_cost_depletions d
        JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
        JOIN order_items oi2 ON oi2.id = d.order_item_id
        WHERE oi2.sku = oi.sku AND d.channel = 'amazon'
      ), 0), 2) AS cogs,
      (SELECT fulfillable_qty FROM amazon_fba_inventory f
        WHERE f.sku = oi.sku ORDER BY f.snapshot_date DESC LIMIT 1) AS fbaFulfillable,
      (SELECT inbound_working_qty + inbound_shipped_qty + inbound_receiving_qty
         FROM amazon_fba_inventory f WHERE f.sku = oi.sku
         ORDER BY f.snapshot_date DESC LIMIT 1) AS fbaInbound
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.channel = 'amazon' AND o.status != 'cancelled'
      AND date(o.placed_at) BETWEEN ? AND ?
    GROUP BY oi.sku
    ORDER BY units DESC
    LIMIT ?
  `).all(range.from, range.to, limit).map((r) => {
    const row = r as Record<string, number | string | null>;
    return {
      sku: String(row.sku),
      internalSku: row.internalSku as string | null,
      units: Number(row.units ?? 0),
      revenue: Number(row.revenue ?? 0),
      cogs: Number(row.cogs ?? 0),
      contribution: round2(Number(row.revenue ?? 0) - Number(row.cogs ?? 0)),
      fbaFulfillable: row.fbaFulfillable === null ? null : Number(row.fbaFulfillable),
      fbaInbound: row.fbaInbound === null ? null : Number(row.fbaInbound),
    };
  });
}

export function getAmazonSettlements(limit = 25): AmazonSettlementRow[] {
  return sqlite.prepare(`
    SELECT
      REPLACE(external_id, 'amazon_settlement_', '') AS settlementId,
      period_start AS periodStart, period_end AS periodEnd,
      gross_amount AS gross, fees, adjustments, net_amount AS net,
      status, received_at AS receivedAt, xero_transaction_id AS xeroTransactionId
    FROM settlements
    WHERE channel = 'amazon'
    ORDER BY IFNULL(period_end, period_start) DESC
    LIMIT ?
  `).all(limit) as AmazonSettlementRow[];
}

/**
 * Inventory position: FBA stock plus ShipHero on-hand.
 *
 * This closes a real reporting gap. ShipHero's on-hand drops when units ship
 * to Amazon, so without the FBA side the business appears to own fewer units
 * than it does — and reorder decisions made on that number would be wrong.
 */
export function getAmazonInventory(limit = 100): AmazonInventoryRow[] {
  return sqlite.prepare(`
    WITH latest AS (
      SELECT sku, MAX(snapshot_date) AS d FROM amazon_fba_inventory GROUP BY sku
    )
    SELECT
      f.sku AS sku,
      f.internal_sku AS internalSku,
      f.fulfillable_qty AS fbaFulfillable,
      (f.inbound_working_qty + f.inbound_shipped_qty + f.inbound_receiving_qty) AS fbaInbound,
      f.reserved_qty AS fbaReserved,
      f.unsellable_qty AS fbaUnsellable,
      f.total_qty AS fbaTotal,
      (SELECT SUM(i.quantity) FROM inventory i
        JOIN catalog_skus cs ON cs.id = i.sku_id
        WHERE cs.sku = f.internal_sku AND i.location = 'warehouse') AS warehouseOnHand
    FROM amazon_fba_inventory f
    JOIN latest ON latest.sku = f.sku AND latest.d = f.snapshot_date
    ORDER BY f.fulfillable_qty ASC
    LIMIT ?
  `).all(limit).map((r) => {
    const row = r as Record<string, number | string | null>;
    const warehouse = row.warehouseOnHand === null ? null : Number(row.warehouseOnHand);
    const fbaTotal = Number(row.fbaTotal ?? 0);
    return {
      sku: String(row.sku),
      internalSku: row.internalSku as string | null,
      fbaFulfillable: Number(row.fbaFulfillable ?? 0),
      fbaInbound: Number(row.fbaInbound ?? 0),
      fbaReserved: Number(row.fbaReserved ?? 0),
      fbaUnsellable: Number(row.fbaUnsellable ?? 0),
      fbaTotal,
      warehouseOnHand: warehouse,
      totalOwned: (warehouse ?? 0) + fbaTotal,
    };
  });
}

/** Per-report sync health — surfaced because Windsor's Amazon reports are genuinely flaky. */
export function getAmazonSyncHealth(): AmazonSyncHealthRow[] {
  return sqlite.prepare(`
    SELECT report_name AS reportName, last_status AS lastStatus,
           last_success_at AS lastSuccessAt, last_synced_through AS lastSyncedThrough,
           consecutive_failures AS consecutiveFailures, last_error AS lastError
    FROM amazon_sync_state ORDER BY report_name
  `).all() as AmazonSyncHealthRow[];
}

/** SKUs sold on Amazon that do not resolve to a catalog SKU, so cannot be costed. */
export function getAmazonUnmappedSkus(): Array<{ sku: string; units: number }> {
  return sqlite.prepare(`
    SELECT oi.sku AS sku, SUM(oi.quantity) AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.channel = 'amazon' AND oi.sku_id IS NULL
    GROUP BY oi.sku ORDER BY units DESC
  `).all() as Array<{ sku: string; units: number }>;
}
