/**
 * Xero integration schema.
 *
 * Tables (mirrors the prior app's pattern):
 * - xero_account_mappings  category -> Xero GL account code, configurable
 * - xero_sync_runs         per-batch observability (running/completed/failed)
 * - xero_journal_log       audit trail of every external posting to Xero
 * - xero_payout_syncs      per-payout idempotency (source_platform + payout id)
 *
 * Tokens themselves still live in the existing `settings` key/value table
 * (Phase 4 will move them to a dedicated `xero_tokens` table with at-rest
 * encryption).
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const xeroAccountMappings = sqliteTable("xero_account_mappings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** "shopify_dtc" | "shopify_wholesale" | "faire" | future platforms. */
  sourcePlatform: text("source_platform").notNull(),
  /** "sales" | "shipping" | "discounts" | "refunds" | "tax" | "fees" | "adjustments" | "bank_clearing" */
  category: text("category").notNull(),
  /** Xero GL account code, e.g. "4000" for Sales. */
  xeroAccountCode: text("xero_account_code").notNull(),
  /** Optional cached account name for the UI. */
  xeroAccountName: text("xero_account_name"),
  notes: text("notes"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const xeroSyncRuns = sqliteTable("xero_sync_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** "shopify_payouts" | "faire_payouts" | "manual" */
  kind: text("kind").notNull(),
  sourcePlatform: text("source_platform"),
  /** "running" | "completed" | "failed" */
  status: text("status").notNull().default("running"),
  dateFrom: text("date_from"),
  dateTo: text("date_to"),
  totalPayouts: integer("total_payouts").default(0),
  successful: integer("successful").default(0),
  failed: integer("failed").default(0),
  errorMessage: text("error_message"),
  startedAt: text("started_at").default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const xeroJournalLog = sqliteTable("xero_journal_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  syncRunId: text("sync_run_id"),
  sourcePlatform: text("source_platform").notNull(),
  sourceId: text("source_id").notNull(),
  /** "manual_journal" | "invoice" | "payment" | "bank_transaction" */
  xeroObjectType: text("xero_object_type").notNull(),
  xeroObjectId: text("xero_object_id"),
  /** "success" | "failed" | "skipped" */
  status: text("status").notNull(),
  amount: real("amount"),
  currency: text("currency"),
  payload: text("payload"),
  response: text("response"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const xeroPayoutSyncs = sqliteTable("xero_payout_syncs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourcePlatform: text("source_platform").notNull(),
  sourcePayoutId: text("source_payout_id").notNull(),
  amount: real("amount"),
  currency: text("currency"),
  paidAt: text("paid_at"),
  xeroObjectType: text("xero_object_type"),
  xeroObjectId: text("xero_object_id"),
  syncRunId: text("sync_run_id"),
  syncedAt: text("synced_at").default(sql`(datetime('now'))`),
});

export type XeroAccountMapping = typeof xeroAccountMappings.$inferSelect;
export type NewXeroAccountMapping = typeof xeroAccountMappings.$inferInsert;
export type XeroSyncRun = typeof xeroSyncRuns.$inferSelect;
export type XeroJournalLogEntry = typeof xeroJournalLog.$inferSelect;
export type XeroPayoutSync = typeof xeroPayoutSyncs.$inferSelect;

/**
 * Default category set the UI seeds when a platform is first configured.
 * Each platform gets its own row per category so the GL account can differ
 * by source (e.g. retail goes to 4000 Sales, wholesale to 4100 Wholesale).
 */
export const DEFAULT_PAYOUT_CATEGORIES = [
  "sales",
  "shipping",
  "discounts",
  "refunds",
  "tax",
  "fees",
  "adjustments",
  "bank_clearing",
] as const;

export type PayoutCategory = (typeof DEFAULT_PAYOUT_CATEGORIES)[number];
