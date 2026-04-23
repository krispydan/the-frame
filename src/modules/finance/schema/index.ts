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
