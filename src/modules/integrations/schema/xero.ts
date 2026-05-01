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

/**
 * Maps a source platform (shopify_dtc, etc.) to a Xero tracking option so
 * Phase 2 can attach the right tag to each journal line.
 *
 * Tracking categories in Xero are user-defined (e.g. "Sales Channel" with
 * options "Faire", "Shopify - Retail", "Shopify - Wholesale"), so we store
 * both the IDs (stable, used for posting) and the names (cached for UI).
 */
export const xeroTrackingMappings = sqliteTable("xero_tracking_mappings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourcePlatform: text("source_platform").notNull().unique(),
  trackingCategoryId: text("tracking_category_id").notNull(),
  trackingCategoryName: text("tracking_category_name"),
  trackingOptionId: text("tracking_option_id").notNull(),
  trackingOptionName: text("tracking_option_name"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export type XeroTrackingMapping = typeof xeroTrackingMappings.$inferSelect;
export type NewXeroTrackingMapping = typeof xeroTrackingMappings.$inferInsert;

/**
 * One row per JournalLine on a COGS journal — captures the SKU, qty, and
 * unit_cost we used at sync time so future cost_price changes don't drift
 * the audit trail.
 */
export const xeroJournalLogLines = sqliteTable("xero_journal_log_lines", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  journalLogId: text("journal_log_id").notNull(),
  sku: text("sku"),
  skuId: text("sku_id"),
  productName: text("product_name"),
  colorName: text("color_name"),
  quantity: integer("quantity"),
  unitCostAtSale: real("unit_cost_at_sale"),
  lineTotal: real("line_total"),
  side: text("side"),               // "debit" or "credit"
  accountCode: text("account_code"),
  trackingOptionId: text("tracking_option_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export type XeroJournalLogLine = typeof xeroJournalLogLines.$inferSelect;

export type XeroAccountMapping = typeof xeroAccountMappings.$inferSelect;
export type NewXeroAccountMapping = typeof xeroAccountMappings.$inferInsert;
export type XeroSyncRun = typeof xeroSyncRuns.$inferSelect;
export type XeroJournalLogEntry = typeof xeroJournalLog.$inferSelect;
export type XeroPayoutSync = typeof xeroPayoutSyncs.$inferSelect;

/**
 * Per-platform category catalog. Drives the mapping UI grid and the
 * journal-line builder in Phase 2. Account codes/names below are the
 * suggested defaults from Jaxy's Channel Payout Mapping Guide
 * (April 2026) — used as placeholders the user can accept or override.
 */
export type CategorySuggestion = {
  category: string;
  label: string;
  hint: string;
  /** Suggested Xero account code from the mapping guide. */
  defaultAccountCode?: string;
  /** Suggested Xero account name (cached for display). */
  defaultAccountName?: string;
  /** Whether this line typically posts as a credit or debit. */
  side: "credit" | "debit";
};

export const PLATFORM_CATEGORY_SUGGESTIONS: Record<string, CategorySuggestion[]> = {
  shopify_dtc: [
    { category: "sales",          label: "Sales (gross)",           hint: "Order total before fees", defaultAccountCode: "4000", defaultAccountName: "Sales - Shopify Retail (DTC)", side: "credit" },
    { category: "shipping",       label: "Shipping income",          hint: "Shipping charged to customer", defaultAccountCode: "4060", defaultAccountName: "Shipping Income", side: "credit" },
    { category: "tax",            label: "Sales tax collected",      hint: "Sales tax liability", defaultAccountCode: "2230", defaultAccountName: "Sales Tax", side: "credit" },
    { category: "refunds",        label: "Refunds & returns",        hint: "Refunds issued to customers", defaultAccountCode: "4300", defaultAccountName: "Sales Returns & Allowances", side: "debit" },
    { category: "discounts",      label: "Discounts & promotions",   hint: "Discount totals", defaultAccountCode: "4310", defaultAccountName: "Sales Discounts & Promotions", side: "debit" },
    { category: "fees",           label: "Merchant fees",            hint: "Shopify Payments processing fee", defaultAccountCode: "5400", defaultAccountName: "Merchant Fees - Shopify Payments", side: "debit" },
    { category: "clearing",       label: "Clearing account",         hint: "Net payout debits this account; transfer to BofA on bank deposit", defaultAccountCode: "1010", defaultAccountName: "Shopify Payments Clearing", side: "debit" },
  ],
  shopify_afterpay: [
    { category: "sales",          label: "Sales (gross)",           hint: "Same revenue account as Shopify DTC", defaultAccountCode: "4000", defaultAccountName: "Sales - Shopify Retail (DTC)", side: "credit" },
    { category: "shipping",       label: "Shipping income",          hint: "Shipping charged to customer", defaultAccountCode: "4060", defaultAccountName: "Shipping Income", side: "credit" },
    { category: "tax",            label: "Sales tax collected",      hint: "Sales tax liability", defaultAccountCode: "2230", defaultAccountName: "Sales Tax", side: "credit" },
    { category: "refunds",        label: "Refunds & returns",        hint: "Refunds issued to customers", defaultAccountCode: "4300", defaultAccountName: "Sales Returns & Allowances", side: "debit" },
    { category: "discounts",      label: "Discounts & promotions",   hint: "Discount totals", defaultAccountCode: "4310", defaultAccountName: "Sales Discounts & Promotions", side: "debit" },
    { category: "fees",           label: "Afterpay fee",             hint: "BNPL processing fee, separate from Shopify Payments", defaultAccountCode: "5430", defaultAccountName: "Merchant Fees - Afterpay / BNPL", side: "debit" },
    { category: "clearing",       label: "Afterpay clearing",        hint: "Afterpay settles separately from Shopify Payments", defaultAccountCode: "1050", defaultAccountName: "Afterpay Clearing", side: "debit" },
  ],
  shopify_wholesale: [
    { category: "sales",          label: "Sales (gross)",           hint: "Order total — wholesale typically tax-exempt and non-returnable", defaultAccountCode: "4030", defaultAccountName: "Sales - Shopify Wholesale (B2B)", side: "credit" },
    { category: "shipping",       label: "Shipping income",          hint: "Shipping charged to retailer", defaultAccountCode: "4060", defaultAccountName: "Shipping Income", side: "credit" },
    { category: "fees",           label: "Merchant fees",            hint: "Shopify Payments processing fee", defaultAccountCode: "5400", defaultAccountName: "Merchant Fees - Shopify Payments", side: "debit" },
    { category: "clearing",       label: "Wholesale clearing",       hint: "Net payout debits here; transfer to BofA on deposit", defaultAccountCode: "1015", defaultAccountName: "Shopify Wholesale Clearing", side: "debit" },
  ],
  faire: [
    { category: "sales",          label: "Sales (gross)",           hint: 'CSV column "Order Total"', defaultAccountCode: "4040", defaultAccountName: "Sales - Faire Wholesale", side: "credit" },
    { category: "discounts",      label: "Promotions",               hint: 'CSV column "Promotions"', defaultAccountCode: "4310", defaultAccountName: "Sales Discounts & Promotions", side: "debit" },
    { category: "damaged_missing",label: "Damaged / missing claims", hint: 'CSV column "Damaged Or Missing"', defaultAccountCode: "5900", defaultAccountName: "Inventory Adjustments & Shrinkage", side: "debit" },
    { category: "commission",     label: "Faire commission",         hint: 'CSV column "Total Commission" (% commission + new-customer fee)', defaultAccountCode: "5450", defaultAccountName: "Faire Fees - Commission", side: "debit" },
    { category: "payment_processing", label: "Payment processing",   hint: 'CSV column "Payment Processing Fee"', defaultAccountCode: "5455", defaultAccountName: "Faire Fees - Payment Processing", side: "debit" },
    { category: "shipping_labels",label: "Shipping labels",          hint: "Only when brand pays — see Insider shipping logic", defaultAccountCode: "5460", defaultAccountName: "Faire Fees - Shipping Labels", side: "debit" },
    { category: "clearing",       label: "Faire clearing",           hint: 'CSV column "Payout Amount"', defaultAccountCode: "1020", defaultAccountName: "Faire Payments Clearing", side: "debit" },
  ],
  amazon: [
    { category: "sales",          label: "Sales (gross)",           hint: "Settlement report gross sales", defaultAccountCode: "4010", defaultAccountName: "Sales - Amazon", side: "credit" },
    { category: "tax",            label: "Sales tax collected",      hint: "Settlement report tax column", defaultAccountCode: "2230", defaultAccountName: "Sales Tax", side: "credit" },
    { category: "refunds",        label: "Refunds & returns",        hint: "Settlement report refund rows", defaultAccountCode: "4300", defaultAccountName: "Sales Returns & Allowances", side: "debit" },
    { category: "fees",           label: "Referral + FBA fees",      hint: "All Amazon-side fees combined", defaultAccountCode: "5410", defaultAccountName: "Merchant Fees - Amazon", side: "debit" },
    { category: "outbound_shipping", label: "Outbound shipping (FBA)", hint: "FBA shipping & fulfillment fees", defaultAccountCode: "5300", defaultAccountName: "Outbound Shipping & Postage", side: "debit" },
    { category: "clearing",       label: "Amazon clearing",          hint: "Settlement total", defaultAccountCode: "1030", defaultAccountName: "Amazon Clearing", side: "debit" },
  ],
  tiktok_shop: [
    { category: "sales",          label: "Sales (gross)",           hint: "Settlement report gross sales", defaultAccountCode: "4020", defaultAccountName: "Sales - TikTok Shop", side: "credit" },
    { category: "tax",            label: "Sales tax collected",      hint: "Settlement report tax column", defaultAccountCode: "2230", defaultAccountName: "Sales Tax", side: "credit" },
    { category: "refunds",        label: "Refunds & returns",        hint: "Settlement report refund rows", defaultAccountCode: "4300", defaultAccountName: "Sales Returns & Allowances", side: "debit" },
    { category: "fees",           label: "TikTok commission + fees", hint: "All TikTok-side fees combined", defaultAccountCode: "5420", defaultAccountName: "Merchant Fees - TikTok Shop", side: "debit" },
    { category: "clearing",       label: "TikTok clearing",          hint: "Settlement total", defaultAccountCode: "1040", defaultAccountName: "TikTok Shop Clearing", side: "debit" },
  ],
};

export const SUPPORTED_PAYOUT_PLATFORMS = Object.keys(PLATFORM_CATEGORY_SUGGESTIONS);

/**
 * Special "_shared" pseudo-platform for category mappings that apply
 * across every channel — currently the COGS expense account and the
 * Inventory asset account, which post the same way regardless of source.
 * Stored in xero_account_mappings with source_platform = "_shared" so we
 * don't have to duplicate the mapping per platform.
 */
export const SHARED_PLATFORM_KEY = "_shared";

export const SHARED_CATEGORY_SUGGESTIONS: CategorySuggestion[] = [
  { category: "cogs",      label: "Cost of Goods Sold", hint: "Single expense account; tracking categories split per-channel COGS on the P&L. Typical: 5xxx Cost of Sales.", defaultAccountCode: "5100", defaultAccountName: "Cost of Goods Sold", side: "debit"  },
  { category: "inventory", label: "Inventory",          hint: "Asset account inventory leaves when sold. Typical: 1400 Inventory.", defaultAccountCode: "1400", defaultAccountName: "Inventory", side: "credit" },
];

/** Get the category suggestion list for a platform. Returns [] if unknown. */
export function getCategoriesForPlatform(platform: string): CategorySuggestion[] {
  if (platform === SHARED_PLATFORM_KEY) return SHARED_CATEGORY_SUGGESTIONS;
  return PLATFORM_CATEGORY_SUGGESTIONS[platform] ?? [];
}

/**
 * Legacy export kept for any callers still using the flat list.
 * New code should use PLATFORM_CATEGORY_SUGGESTIONS / getCategoriesForPlatform.
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
