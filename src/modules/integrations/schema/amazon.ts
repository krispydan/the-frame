/**
 * Amazon sales-channel schema (data sourced via Windsor AI, connector `amazon_sp`).
 *
 * These are RAW LANDING tables: rows land here exactly as Windsor returns them,
 * and every downstream artefact (orders, Xero journals, dashboards) is derived
 * from these tables — never re-fetched from Windsor.
 *
 * That indirection is not stylistic. Amazon's settlement report is only
 * retrievable for the **last 90 days**; older settlements are permanently
 * unavailable from Windsor. If we did not archive them on first sight, our
 * accounting history would silently evaporate on a rolling window. Landing
 * first also means a mapping bug can be fixed and the month restated without
 * needing the upstream data to still exist.
 *
 * Money is stored as REAL dollars (repo-wide convention — see
 * `src/modules/finance/schema/index.ts`), not integer cents.
 *
 * Tables:
 * - amazon_order_rows          raw all-orders report (both date variants)
 * - amazon_settlement_rows     raw settlement report — append-only, never updated
 * - amazon_sales_traffic_daily normalised daily sales + traffic metrics
 * - amazon_fba_inventory       daily FBA stock snapshot (units held at Amazon)
 * - amazon_sync_state          per-report watermark + last error, drives the
 *                              sync-health panel and the retry cadence
 */

import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Raw rows from the two all-orders reports:
 *   get_flat_file_all_orders_data_by_order_date_general   (new orders)
 *   get_flat_file_all_orders_data_by_last_update_general  (status changes)
 *
 * Both share a shape; we upsert on (amazon_order_id, sku) so the last-update
 * pull refreshes item_status / last_updated_date on rows the order-date pull
 * created. One row per order line, not per order.
 */
export const amazonOrderRows = sqliteTable("amazon_order_rows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  amazonOrderId: text("amazon_order_id").notNull(),
  sku: text("sku").notNull(),
  asin: text("asin"),
  quantity: integer("quantity").notNull().default(0),
  /** Line total (not unit price) — Amazon's flat file reports item-price per line. */
  itemPrice: real("item_price").notNull().default(0),
  itemTax: real("item_tax").notNull().default(0),
  /** Stored positive; Amazon reports promotion discounts as positive magnitudes. */
  itemPromotionDiscount: real("item_promotion_discount").notNull().default(0),
  shipPromotionDiscount: real("ship_promotion_discount").notNull().default(0),
  shippingPrice: real("shipping_price").notNull().default(0),
  shippingTax: real("shipping_tax").notNull().default(0),
  /** Order-level status: Pending | Shipped | Cancelled | ... */
  orderStatus: text("order_status"),
  /** Line-level status — authoritative for partial shipments. */
  itemStatus: text("item_status"),
  /** "Amazon" (FBA) | "Merchant" (shipped from our warehouse). */
  fulfillmentChannel: text("fulfillment_channel"),
  salesChannel: text("sales_channel"),
  currency: text("currency").notNull().default("USD"),
  purchaseDate: text("purchase_date"),
  lastUpdatedDate: text("last_updated_date"),
  shipCity: text("ship_city"),
  shipState: text("ship_state"),
  shipPostalCode: text("ship_postal_code"),
  shipCountry: text("ship_country"),
  isBusinessOrder: text("is_business_order"),
  /** Full Windsor row, for auditability and for re-deriving if a mapping changes. */
  rawJson: text("raw_json"),
  ingestedAt: text("ingested_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex("idx_amazon_order_rows_key").on(table.amazonOrderId, table.sku),
  index("idx_amazon_order_rows_purchase").on(table.purchaseDate),
  index("idx_amazon_order_rows_updated").on(table.lastUpdatedDate),
  index("idx_amazon_order_rows_status").on(table.itemStatus),
]);

/**
 * Raw settlement rows — the accounting source of truth, and the reason this
 * schema exists. APPEND-ONLY: a settlement row, once posted by Amazon, is
 * immutable, so re-pulls skip duplicates rather than updating. Any apparent
 * change to a settled row is a genuine anomaly worth surfacing, not something
 * to silently overwrite.
 *
 * The uniqueness key is deliberately wide: a single settlement legitimately
 * contains many rows sharing settlement/order/sku (e.g. Principal and Tax on
 * the same line), so the amount type, description and value all participate.
 */
export const amazonSettlementRows = sqliteTable("amazon_settlement_rows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  settlementId: text("settlement_id").notNull(),
  postedDate: text("posted_date"),
  /** Order | Refund | FBAFees | other-transaction | Transfers | ... */
  transactionType: text("transaction_type"),
  /** ItemPrice | ItemFees | Promotion | ItemWithheldTax | other-transaction | ... */
  amountType: text("amount_type"),
  /** Principal | Tax | Commission | FBAPerUnitFulfillmentFee | Subscription Fee | ... */
  amountDescription: text("amount_description"),
  amount: real("amount").notNull().default(0),
  /** Frequently empty in Windsor's output — defaulted to USD at ingest. */
  currency: text("currency").notNull().default("USD"),
  sku: text("sku"),
  orderId: text("order_id"),
  quantityPurchased: integer("quantity_purchased"),
  marketplaceName: text("marketplace_name"),
  settlementStartDate: text("settlement_start_date"),
  settlementEndDate: text("settlement_end_date"),
  depositDate: text("deposit_date"),
  /** Settlement header total — present only on the header row. */
  totalAmount: real("total_amount"),
  rawJson: text("raw_json"),
  ingestedAt: text("ingested_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_amazon_settlement_rows_settlement").on(table.settlementId),
  index("idx_amazon_settlement_rows_posted").on(table.postedDate),
  index("idx_amazon_settlement_rows_order").on(table.orderId),
  index("idx_amazon_settlement_rows_sku").on(table.sku),
]);

/**
 * Daily sales + traffic metrics from get_sales_and_traffic_report_by_date.
 * Upserted on date because Amazon restates recent days — the trailing window
 * re-pull is expected to overwrite, not duplicate.
 *
 * This is the only source for session/conversion/buy-box data; it exists
 * nowhere else in the business.
 */
export const amazonSalesTrafficDaily = sqliteTable("amazon_sales_traffic_daily", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  date: text("date").notNull(),
  grossSales: real("gross_sales").notNull().default(0),
  unitsOrdered: integer("units_ordered").notNull().default(0),
  unitsShipped: integer("units_shipped").notNull().default(0),
  totalOrderItems: integer("total_order_items").notNull().default(0),
  refundRate: real("refund_rate"),
  sessions: integer("sessions"),
  pageViews: integer("page_views"),
  buyBoxPct: real("buy_box_pct"),
  /** Amazon's unitSessionPercentage — units per session, i.e. conversion. */
  conversionRate: real("conversion_rate"),
  avgSellingPrice: real("avg_selling_price"),
  ingestedAt: text("ingested_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex("idx_amazon_sales_traffic_date").on(table.date),
]);

/**
 * Daily FBA inventory snapshot.
 *
 * This closes a real reporting gap: ShipHero's on-hand drops when units ship
 * to Amazon, so without this the business appears to own fewer units than it
 * does. True owned inventory =
 *   ShipHero on-hand + fulfillable + inbound (working/shipped/receiving) + reserved.
 *
 * Deliberately NOT written into the `inventory` table, whose `warehouse`
 * quantity is authoritatively ShipHero's and is overwritten hourly.
 */
export const amazonFbaInventory = sqliteTable("amazon_fba_inventory", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  snapshotDate: text("snapshot_date").notNull(),
  /** Amazon SKU, e.g. "JX1010-TOR-FBA". */
  sku: text("sku").notNull(),
  /** Our SKU after stripping the -FBA suffix, e.g. "JX1010-TOR". */
  internalSku: text("internal_sku"),
  asin: text("asin"),
  fulfillableQty: integer("fulfillable_qty").notNull().default(0),
  inboundWorkingQty: integer("inbound_working_qty").notNull().default(0),
  inboundShippedQty: integer("inbound_shipped_qty").notNull().default(0),
  inboundReceivingQty: integer("inbound_receiving_qty").notNull().default(0),
  reservedQty: integer("reserved_qty").notNull().default(0),
  unsellableQty: integer("unsellable_qty").notNull().default(0),
  totalQty: integer("total_qty").notNull().default(0),
  ingestedAt: text("ingested_at").default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex("idx_amazon_fba_inventory_key").on(table.snapshotDate, table.sku),
  index("idx_amazon_fba_inventory_sku").on(table.sku),
]);

/**
 * Per-report sync watermark and health.
 *
 * Windsor's Amazon reports are genuinely flaky — some report types time out
 * repeatedly while others respond in under two seconds — so "when did this
 * specific report last succeed" is operational information, not debug noise.
 * It drives the dashboard's sync-health panel and the alert-after-N-failures
 * rule that stops a slow report from paging us every night.
 */
export const amazonSyncState = sqliteTable("amazon_sync_state", {
  /** Logical report key, e.g. "orders_by_order_date". */
  reportName: text("report_name").primaryKey(),
  /** Date (YYYY-MM-DD) through which data is known-good. */
  lastSyncedThrough: text("last_synced_through"),
  lastRunAt: text("last_run_at"),
  lastSuccessAt: text("last_success_at"),
  /** "ok" | "failed" | "running" */
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  /** Consecutive failures — alerts fire only once this crosses the threshold. */
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  rowsIngested: integer("rows_ingested").notNull().default(0),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});
