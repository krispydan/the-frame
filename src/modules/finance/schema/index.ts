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
