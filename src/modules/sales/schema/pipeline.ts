import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "@/modules/core/schema";
import { companies, stores, contacts } from "@/modules/sales/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Pipeline Stage Enum ──
// Kanban only shows leads from "interested" onwards (per Daniel 2026-06-19)
// — prospects and qualified_leads that haven't responded yet don't belong
// on the board. Mirrors the post-interested portion of companies.status:
//
//   companies.status   →   deals.stage
//   interested             interested
//   catalog_sent           catalog_sent
//   revisit_later          interested_later
//   not_interested         not_interested
//   ghosted                ghosted
//   customer               order_placed
//
// Auto-syncing is in src/modules/sales/lib/status-progression.ts —
// when a company progresses, the matching deal row's stage updates.
export const DEAL_STAGES = [
  "interested",
  "catalog_sent",
  "order_placed",
  "interested_later",
  "not_interested",
  "ghosted",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  interested: "Interested",
  catalog_sent: "Catalog Sent",
  order_placed: "Order Placed",
  interested_later: "Revisit Later",
  not_interested: "Not Interested",
  ghosted: "Ghosted",
};

export const DEAL_STAGE_COLORS: Record<DealStage, string> = {
  interested: "bg-green-100 text-green-800",
  catalog_sent: "bg-blue-100 text-blue-800",
  order_placed: "bg-emerald-100 text-emerald-800",
  interested_later: "bg-orange-100 text-orange-800",
  not_interested: "bg-red-100 text-red-800",
  ghosted: "bg-gray-100 text-gray-600",
};

export const DEAL_CHANNELS = ["shopify", "faire", "phone", "direct", "other"] as const;
export type DealChannel = (typeof DEAL_CHANNELS)[number];

export const ACTIVITY_TYPES = [
  "note",
  "email",
  "call",
  "meeting",
  "stage_change",
  "snooze",
  "reorder",
  "enrichment",
  "owner_change",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// ── Deals ──
export const deals = sqliteTable("deals", {
  id: id(),
  companyId: text("company_id").notNull().references(() => companies.id),
  storeId: text("store_id").references(() => stores.id),
  contactId: text("contact_id").references(() => contacts.id),
  title: text("title").notNull(),
  value: real("value"),
  // Default is `interested` — the kanban's leftmost column. Deals are
  // only created when a company progresses to `interested` or later
  // (via syncDealStage in status-progression.ts).
  stage: text("stage", { enum: DEAL_STAGES }).notNull().default("interested"),
  previousStage: text("previous_stage", { enum: DEAL_STAGES }),
  channel: text("channel", { enum: DEAL_CHANNELS }),
  ownerId: text("owner_id").references(() => users.id),
  snoozeUntil: text("snooze_until"),
  snoozeReason: text("snooze_reason"),
  lastActivityAt: timestamp("last_activity_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  closedAt: text("closed_at"),
  reorderDueAt: text("reorder_due_at"),
}, (table) => [
  index("idx_deals_stage").on(table.stage),
  index("idx_deals_owner").on(table.ownerId),
  index("idx_deals_company").on(table.companyId),
  index("idx_deals_snooze").on(table.snoozeUntil),
  index("idx_deals_reorder").on(table.reorderDueAt),
]);

// ── Deal Activities ──
export const dealActivities = sqliteTable("deal_activities", {
  id: id(),
  dealId: text("deal_id").notNull().references(() => deals.id),
  companyId: text("company_id").references(() => companies.id),
  type: text("type", { enum: ACTIVITY_TYPES }).notNull(),
  description: text("description"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  userId: text("user_id").references(() => users.id),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_activities_deal").on(table.dealId),
  index("idx_activities_company").on(table.companyId),
  index("idx_activities_created").on(table.createdAt),
]);
