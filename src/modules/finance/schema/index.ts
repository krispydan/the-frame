import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Settlements ──
export const settlements = sqliteTable("settlements", {
  id: id(),
  channel: text("channel", {
    enum: ["shopify_dtc", "shopify_wholesale", "faire", "amazon"],
  }).notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  grossAmount: real("gross_amount").notNull().default(0),
  fees: real("fees").notNull().default(0),
  adjustments: real("adjustments").notNull().default(0),
  netAmount: real("net_amount").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  externalId: text("external_id"), // Shopify payout ID, Faire settlement ID, etc.
  status: text("status", {
    enum: ["pending", "received", "reconciled", "synced_to_xero"],
  }).notNull().default("pending"),
  receivedAt: text("received_at"),
  xeroTransactionId: text("xero_transaction_id"),
  xeroSyncedAt: text("xero_synced_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_settlements_channel").on(table.channel),
  index("idx_settlements_status").on(table.status),
  index("idx_settlements_period").on(table.periodStart, table.periodEnd),
  index("idx_settlements_external_id").on(table.externalId),
]);

// ── Settlement Line Items ──
export const settlementLineItems = sqliteTable("settlement_line_items", {
  id: id(),
  settlementId: text("settlement_id").notNull().references(() => settlements.id, { onDelete: "cascade" }),
  orderId: text("order_id"), // references orders.id when matched
  type: text("type", {
    enum: ["sale", "refund", "fee", "adjustment"],
  }).notNull(),
  description: text("description"),
  amount: real("amount").notNull().default(0),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_sli_settlement_id").on(table.settlementId),
  index("idx_sli_order_id").on(table.orderId),
  index("idx_sli_type").on(table.type),
]);

// ── Order Revenue Recognitions ──
//
// One row per (order, payout) — written by the shipment-revenue-recognition
// cron when a previously-deferred order actually ships. Lets us:
//   - know exactly which orders have had revenue + COGS recognized
//   - run the recognition job idempotently (existing rows = already done)
//   - audit / reverse a single order if needed (cancellation, refund)
//
// The accrual flow under-pinning this:
//   payout arrives → revenue parks in 2200 Deferred Revenue (liability)
//   order ships    → moves from 2200 → 4030/4000 (Sales Revenue) + COGS
//
// `recognizedAt` is the shipment date (when control transferred to the
// customer = the accrual-correct revenue recognition trigger under ASC 606).
export const orderRevenueRecognitions = sqliteTable("order_revenue_recognitions", {
  id: id(),
  orderId: text("order_id").notNull(),               // local orders.id
  externalOrderId: text("external_order_id"),        // shopify order id
  payoutExternalId: text("payout_external_id"),      // "shopify_payout_XXX" — for trace
  channel: text("channel").notNull(),                // shopify_dtc, shopify_wholesale, etc.
  recognizedAt: text("recognized_at").notNull(),     // shipped_at, ISO date
  revenueAmount: real("revenue_amount").notNull(),   // gross revenue moved out of deferral
  cogsAmount: real("cogs_amount").default(0),        // COGS at recognition time (FIFO)
  currency: text("currency").default("USD"),
  xeroManualJournalId: text("xero_manual_journal_id"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_orr_order_id").on(table.orderId),
  index("idx_orr_channel").on(table.channel),
  index("idx_orr_recognized_at").on(table.recognizedAt),
  index("idx_orr_payout_external_id").on(table.payoutExternalId),
]);

// ── Expense Categories ──
export const expenseCategories = sqliteTable("expense_categories", {
  id: id(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  budgetMonthly: real("budget_monthly"),
  createdAt: timestamp("created_at"),
});

// ── FIFO Cost Layers (one entry per PO line item receipt) ──
export const costLayers = sqliteTable("inventory_cost_layers", {
  id: id(),
  skuId: text("sku_id").notNull(),
  poLineItemId: text("po_line_item_id"),
  poId: text("po_id"),
  poNumber: text("po_number"),
  quantity: integer("quantity").notNull(),
  remainingQuantity: integer("remaining_quantity").notNull(),
  unitCost: real("unit_cost").notNull().default(0),
  freightPerUnit: real("freight_per_unit").notNull().default(0),
  dutiesPerUnit: real("duties_per_unit").notNull().default(0),
  landedCostPerUnit: real("landed_cost_per_unit").notNull().default(0),
  shippingMethod: text("shipping_method"), // air or ocean
  receivedAt: text("received_at").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cost_layers_sku").on(table.skuId),
  index("idx_cost_layers_po").on(table.poId),
  index("idx_cost_layers_received").on(table.receivedAt),
]);

// ── Cost Depletions (FIFO consumption records) ──
export const costDepletions = sqliteTable("inventory_cost_depletions", {
  id: id(),
  costLayerId: text("cost_layer_id").notNull().references(() => costLayers.id),
  orderItemId: text("order_item_id"),
  orderId: text("order_id"),
  channel: text("channel"),
  quantity: integer("quantity").notNull(),
  unitCost: real("unit_cost").notNull(),
  landedCostPerUnit: real("landed_cost_per_unit").notNull(),
  depletedAt: text("depleted_at").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_depletions_layer").on(table.costLayerId),
  index("idx_depletions_order").on(table.orderId),
  index("idx_depletions_depleted").on(table.depletedAt),
]);

// ── COGS Journals (weekly Xero postings) ──
export const cogsJournals = sqliteTable("cogs_journals", {
  id: id(),
  weekStart: text("week_start").notNull(),
  weekEnd: text("week_end").notNull(),
  productCost: real("product_cost").notNull().default(0),
  freightCost: real("freight_cost").notNull().default(0),
  dutiesCost: real("duties_cost").notNull().default(0),
  totalCogs: real("total_cogs").notNull().default(0),
  unitCount: integer("unit_count").notNull().default(0),
  channelBreakdown: text("channel_breakdown"), // JSON
  status: text("status", { enum: ["draft", "posted", "reconciled"] }).notNull().default("draft"),
  xeroJournalId: text("xero_journal_id"),
  xeroPostedAt: text("xero_posted_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cogs_journals_week").on(table.weekStart, table.weekEnd),
  index("idx_cogs_journals_status").on(table.status),
]);

// ── COGS Run Log (one row per daily-COGS job invocation) ──
// Observability: every run — live, dry-run, backfill, correction — leaves a
// trace so months later we can answer "what did the COGS job do on X day".
export const cogsRunLog = sqliteTable("cogs_run_log", {
  id: id(),
  runDate: text("run_date").notNull(),       // the COGS day being processed (YYYY-MM-DD)
  mode: text("mode", { enum: ["live", "dry_run", "backfill", "correction"] }).notNull().default("live"),
  ordersProcessed: integer("orders_processed").notNull().default(0),
  unitsCosted: integer("units_costed").notNull().default(0),
  totalCogs: real("total_cogs").notNull().default(0),
  exceptionsOpened: integer("exceptions_opened").notNull().default(0),
  cogsJournalId: text("cogs_journal_id"),     // → cogs_journals.id
  xeroJournalId: text("xero_journal_id"),
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cogs_run_log_date").on(table.runDate),
  index("idx_cogs_run_log_created").on(table.createdAt),
]);

// ── COGS Exceptions (per-order/SKU failures that block clean costing) ──
// The worklist + audit trail. Nothing is ever silently swallowed: shortfalls,
// zero/implausible cost, and unmapped SKUs each land here and on Slack. An
// exception auto-resolves when a later run successfully costs the same order
// item (e.g. after a layer is seeded or a cost is corrected).
export const cogsExceptions = sqliteTable("cogs_exceptions", {
  id: id(),
  type: text("type", {
    enum: ["shortfall", "zero_cost", "implausible_cost", "unmapped_sku"],
  }).notNull(),
  orderId: text("order_id"),
  orderItemId: text("order_item_id"),
  orderNumber: text("order_number"),
  sku: text("sku"),
  skuId: text("sku_id"),
  units: integer("units"),                    // units affected
  channel: text("channel"),
  detail: text("detail"),                     // JSON: amounts, layer info, message
  runId: text("run_id"),                      // → cogs_run_log.id that raised it
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at"),
  resolvedAt: text("resolved_at"),
}, (table) => [
  index("idx_cogs_exceptions_status").on(table.status),
  index("idx_cogs_exceptions_type").on(table.type),
  index("idx_cogs_exceptions_order").on(table.orderId),
  index("idx_cogs_exceptions_order_item").on(table.orderItemId),
]);

// ── Expenses ──
export const expenses = sqliteTable("expenses", {
  id: id(),
  categoryId: text("category_id").references(() => expenseCategories.id),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  vendor: text("vendor"),
  date: text("date").notNull(), // YYYY-MM-DD
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(false),
  frequency: text("frequency", {
    enum: ["weekly", "monthly", "quarterly", "annually"],
  }),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_expenses_category").on(table.categoryId),
  index("idx_expenses_date").on(table.date),
  index("idx_expenses_vendor").on(table.vendor),
  index("idx_expenses_recurring").on(table.recurring),
]);
