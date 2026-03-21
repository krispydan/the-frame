import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "@/modules/core/schema";
import { companies, stores, contacts } from "@/modules/sales/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Pipeline Stage Enum ──
export const DEAL_STAGES = [
  "outreach",
  "contact_made",
  "interested",
  "order_placed",
  "interested_later",
  "not_interested",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  outreach: "Outreach",
  contact_made: "Contact Made",
  interested: "Interested",
  order_placed: "Order Placed",
  interested_later: "Interested Later",
  not_interested: "Not Interested",
};

export const DEAL_STAGE_COLORS: Record<DealStage, string> = {
  outreach: "bg-blue-100 text-blue-800",
  contact_made: "bg-yellow-100 text-yellow-800",
  interested: "bg-green-100 text-green-800",
  order_placed: "bg-emerald-100 text-emerald-800",
  interested_later: "bg-orange-100 text-orange-800",
  not_interested: "bg-red-100 text-red-800",
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
  stage: text("stage", { enum: DEAL_STAGES }).notNull().default("outreach"),
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
