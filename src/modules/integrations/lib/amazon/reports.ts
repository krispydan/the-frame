/**
 * Amazon (Windsor `amazon_sp`) report definitions.
 *
 * Every field name here was verified against the live field catalog
 * (`GET https://connectors.windsor.ai/amazon_sp/fields`, 899 fields across 24
 * reports) — they are not guessed from Amazon's own documentation, which uses
 * different names again (`amount-type` upstream vs `amount_type` here).
 *
 * `maxWindowDays` and `timeoutMs` are tuned from measured behaviour against
 * the live account, not from a general rule. Measured over a 7-day window
 * (2026-07-25 → 2026-08-01):
 *
 *   orders by order date     90 rows    1.9s
 *   orders by last update    68 rows   36.4s
 *   settlements               5 rows    0.2s
 *   sales & traffic           8 rows    0.2s
 *   FBA inventory           177 rows    0.5s
 *   returns                   0 rows   50.1s
 *   reimbursements            —        73.5s  (upstream "no data" cancel)
 *   FBA shipments             —        never returned (see NOT_AVAILABLE)
 *
 * The 180s+ timeouts are not padding: two of these routinely take the better
 * part of a minute, and the same report can be near-instant or minute-long
 * depending on whether Amazon has it cached.
 *
 * Note also that an empty period does not come back as an empty result —
 * Amazon cancels the report request outright, which the client classifies as
 * `no_data` and the orchestrator records as a successful empty run.
 */

import type { WindsorReport } from "@/modules/integrations/lib/windsor/client";

export const AMAZON_CONNECTOR = "amazon_sp";

/**
 * Both all-orders variants expose an identical 31-field shape; only the date
 * column they filter on differs. One list serves both.
 */
const ORDER_FIELDS = [
  "amazon_order_id",
  "sku",
  "asin",
  "quantity",
  "item_price",
  "item_tax",
  "item_promotion_discount",
  "ship_promotion_discount",
  "shipping_price",
  "shipping_tax",
  "order_status",
  "item_status",
  "fulfillment_channel",
  "sales_channel",
  "currency",
  "purchase_date",
  "last_updated_date",
  "ship_city",
  "ship_state",
  "ship_postal_code",
  "ship_country",
  "is_business_order",
] as const;

/**
 * New orders, filtered by purchase date. The primary import feed.
 */
export const ORDERS_BY_ORDER_DATE: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_flat_file_all_orders_data_by_order_date_general",
  fields: [...ORDER_FIELDS],
  maxWindowDays: 7,
  timeoutMs: 180_000,
};

/**
 * Same rows, filtered by last-update date. This is what catches ships,
 * cancellations and restatements of orders placed before the current window —
 * and, since the FBA shipments report is unusable, it is also our only source
 * of a shipped timestamp.
 */
export const ORDERS_BY_LAST_UPDATE: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_flat_file_all_orders_data_by_last_update_general",
  fields: [...ORDER_FIELDS],
  maxWindowDays: 7,
  timeoutMs: 180_000,
};

/**
 * The settlement report — the accounting source of truth.
 *
 * Windsor serves this for the last 90 days only; anything older is
 * permanently gone. `clampToSettlementWindow()` below enforces that, and the
 * raw archive exists so we only have to catch each row once.
 */
export const SETTLEMENTS: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_v2_settlement_report_data_flat_file_v2",
  fields: [
    "settlement_id",
    "posted_date",
    "transaction_type",
    "amount_type",
    "amount_description",
    "amount",
    "currency",
    "sku",
    "order_id",
    "quantity_purchased",
    "marketplace_name",
    "settlement_start_date",
    "settlement_end_date",
    "deposit_date",
    "total_amount",
  ],
  // Settlements are low-volume and the endpoint handles wide ranges happily,
  // so a single call per sync is both safe and cheaper than chunking.
  maxWindowDays: 90,
  timeoutMs: 240_000,
};

/**
 * Daily sales + traffic. The only source of sessions, page views, Buy Box
 * share and conversion — none of which exist anywhere else in the business.
 */
export const SALES_TRAFFIC: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_sales_and_traffic_report_by_date",
  fields: [
    "date",
    "salesbydate_orderedproductsales_amount",
    "salesbydate_unitsordered",
    "salesbydate_unitsshipped",
    "salesbydate_totalorderitems",
    "salesbydate_refundrate",
    "salesbydate_averagesellingprice_amount",
    "trafficbydate_sessions",
    "trafficbydate_pageviews",
    "trafficbydate_buyboxpercentage",
    "trafficbydate_unitsessionpercentage",
  ],
  maxWindowDays: 30,
  timeoutMs: 240_000,
};

/**
 * FBA stock on hand. Closes the gap where ShipHero's on-hand drops when units
 * ship to Amazon, making the business look like it owns fewer units than it
 * does. This report is a live snapshot — it carries no date column, so the
 * snapshot date is stamped at ingest.
 */
export const FBA_INVENTORY: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_fba_myi_unsuppressed_inventory_data",
  fields: [
    "sku",
    "asin",
    "product_name",
    "condition",
    "afn_fulfillable_quantity",
    "afn_inbound_working_quantity",
    "afn_inbound_shipped_quantity",
    "afn_inbound_receiving_quantity",
    "afn_reserved_quantity",
    "afn_unsellable_quantity",
    "afn_total_quantity",
  ],
  maxWindowDays: 30,
  timeoutMs: 180_000,
};

/**
 * Daily sales + traffic BY ASIN.
 *
 * Same upstream report as SALES_TRAFFIC, different dimension: passing the
 * `salesByAsin-*` / `trafficByAsin-*` fields makes Amazon return one row per
 * child ASIN per day instead of one row per day.
 *
 * This is the only source of per-product sessions and conversion anywhere in
 * the business, and it is what separates a traffic problem from a conversion
 * problem — a SKU with sessions and no orders is priced or reviewed wrong, a
 * SKU with neither is invisible. Order rows can tell you what sold; only this
 * can tell you what was looked at and not bought.
 *
 * Field names are given in Windsor's wire form (lowercase, underscores), not
 * the catalog's display casing. The catalog advertises `salesByAsin-sessions`
 * but the query parameter only accepts `salesbyasin_sessions`; the client
 * normalises either way, and wire form keeps this file internally consistent
 * — it is also the form the response keys come back in, which is what the
 * ingest reads.
 *
 * Many fields in the catalog carry a literal "(Deprecated)" prefix in their
 * name. Those are excluded — Amazon still lists them but they return empty.
 */
export const SALES_TRAFFIC_BY_ASIN: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_sales_and_traffic_report",
  fields: [
    "date",
    "childasin",
    "parentasin",
    "salesbyasin_unitsordered",
    "salesbyasin_unitsshipped",
    "salesbyasin_totalorderitems",
    "salesbyasin_orderedproductsales_amount",
    "salesbyasin_averagesellingprice_amount",
    "salesbyasin_refundrate",
    "trafficbyasin_sessions",
    "trafficbyasin_pageviews",
    "trafficbyasin_buyboxpercentage",
    "trafficbyasin_unitsessionpercentage",
    "trafficbyasin_sessionpercentage",
  ],
  // One row per ASIN per day multiplies volume by the catalogue size, so the
  // window is tighter than the by-date variant's 30.
  maxWindowDays: 14,
  timeoutMs: 240_000,
};

/**
 * Listing metadata — the source of product titles.
 *
 * Without this every report reads as SKU codes. A row that says
 * "JX3004-S-BLK lost $84" is not actionable to anyone who does not already
 * know the catalogue by heart; "Aviator · Black (Small)" is.
 *
 * Also carries the ASIN↔SKU mapping, which is what lets per-ASIN traffic join
 * to per-SKU cost. Amazon reports traffic by ASIN and money by SKU, and
 * nothing else in the account bridges them.
 */
export const MERCHANT_LISTINGS: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_merchant_listings_all_data",
  fields: [
    "seller_sku",
    "asin1",
    "item_name",
    "item_description",
    "price",
    "quantity",
    "status",
    "fulfillment_channel",
    "open_date",
    "item_is_marketplace",
  ],
  maxWindowDays: 30,
  timeoutMs: 180_000,
};

/**
 * Customer returns by return date. Month-end reporting only.
 */
export const RETURNS: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_flat_file_returns_data_by_return_date",
  fields: [
    "order_id",
    "order_date",
    "merchant_sku",
    "asin",
    "item_name",
    "return_request_date",
    "return_request_status",
    "return_quantity",
    "order_quantity",
    "return_reason",
    "resolution",
    "refunded_amount",
    "order_amount",
    "in_policy",
    "label_cost",
    "amazon_rma_id",
  ],
  maxWindowDays: 30,
  timeoutMs: 180_000,
};

/**
 * FBA reimbursements — Amazon paying us for inventory it lost or damaged.
 * Real income that is easy to miss at month-end because it never appears as
 * a sale.
 */
export const REIMBURSEMENTS: WindsorReport = {
  connector: AMAZON_CONNECTOR,
  report: "get_fba_reimbursements_data",
  fields: [
    "reimbursement_id",
    "approval_date",
    "case_id",
    "amazon_order_id",
    "reason",
    "sku",
    "asin",
    "product_name",
    "condition",
    "currency_unit",
    "amount_per_unit",
    "amount_total",
    "quantity_reimbursed_cash",
    "quantity_reimbursed_inventory",
    "quantity_reimbursed_total",
  ],
  maxWindowDays: 30,
  timeoutMs: 180_000,
};

/**
 * Reports deliberately not used, with the reason — so a future reader doesn't
 * "helpfully" wire them back in.
 *
 * `get_amazon_fulfilled_shipments_data_general` would be the natural source
 * for ship timestamps and tracking numbers, and it is listed in the catalog
 * with 48 fields. It timed out on every single attempt made against the live
 * account — 9 min, 5 min, 4 min, and even a one-day window at 2 min, across
 * separate sessions. `shipped_at` therefore derives from
 * ORDERS_BY_LAST_UPDATE instead (see `deriveShippedAt`). We lose the tracking
 * number, which we do not need: The Frame never fulfils Amazon orders.
 */
export const NOT_AVAILABLE = {
  shipments: "get_amazon_fulfilled_shipments_data_general",
} as const;

/** Stable keys used by `amazon_sync_state` and the dashboard health panel. */
export const REPORT_KEYS = {
  ordersByOrderDate: "orders_by_order_date",
  ordersByLastUpdate: "orders_by_last_update",
  settlements: "settlements",
  salesTraffic: "sales_traffic",
  salesTrafficByAsin: "sales_traffic_by_asin",
  merchantListings: "merchant_listings",
  fbaInventory: "fba_inventory",
  returns: "returns",
  reimbursements: "reimbursements",
} as const;

export type ReportKey = (typeof REPORT_KEYS)[keyof typeof REPORT_KEYS];

/** Amazon's settlement retention limit, in days. */
export const SETTLEMENT_WINDOW_DAYS = 90;

/**
 * Days of slack left at the far edge of the settlement window.
 *
 * Amazon's cutoff is enforced upstream and we do not know which timezone it
 * is evaluated in, so a request for exactly day 90 can be rejected outright —
 * and a rejection loses the ENTIRE sync, not just the boundary day. Backing
 * off two days costs nothing (the daily cron re-pulls a trailing window, so
 * those days are already archived) and removes a whole class of
 * once-a-day-at-midnight failure.
 */
const SETTLEMENT_WINDOW_SAFETY_DAYS = 2;

/**
 * Clamp a requested start date to Amazon's 90-day settlement retention.
 *
 * Returns the clamped range plus whether clamping occurred, so a backfill can
 * tell the operator "we asked for 1 Jan but Amazon will only serve from
 * 6 May" instead of silently returning a short result that looks like a gap
 * in trading.
 */
export function clampToSettlementWindow(
  dateFrom: string,
  dateTo: string,
  today: string,
): { dateFrom: string; dateTo: string; clamped: boolean; earliestAvailable: string } {
  const earliestMs =
    Date.parse(`${today}T00:00:00Z`) -
    (SETTLEMENT_WINDOW_DAYS - 1 - SETTLEMENT_WINDOW_SAFETY_DAYS) * 86_400_000;
  const earliest = new Date(earliestMs).toISOString().slice(0, 10);
  const clamped = Date.parse(`${dateFrom}T00:00:00Z`) < earliestMs;
  return {
    dateFrom: clamped ? earliest : dateFrom,
    dateTo,
    clamped,
    earliestAvailable: earliest,
  };
}

/**
 * Amazon's SP-API does not return data for the current day, so T-1 is the
 * newest day that can be trusted.
 */
export function latestAvailableDate(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
