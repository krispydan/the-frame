/**
 * F3-003: Campaign & Campaign Lead schema
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { companies, contacts, smartLists } from "@/modules/sales/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

export const CAMPAIGN_TYPES = ["email_sequence", "calling", "re_engagement", "ab_test"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_TYPE_LABELS: Record<CampaignType, string> = {
  email_sequence: "Email Sequence",
  calling: "Calling",
  re_engagement: "Re-engagement",
  ab_test: "A/B Test",
};

export const CAMPAIGN_STATUS_COLORS: Record<CampaignStatus, string> = {
  draft: "bg-gray-100 text-gray-800",
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  completed: "bg-blue-100 text-blue-800",
};

export const LEAD_STATUSES = ["queued", "sent", "opened", "replied", "bounced", "unsubscribed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const campaigns = sqliteTable("campaigns", {
  id: id(),
  name: text("name").notNull(),
  type: text("type", { enum: CAMPAIGN_TYPES }).notNull().default("email_sequence"),
  status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
  description: text("description"),
  instantlyCampaignId: text("instantly_campaign_id"),
  targetSegment: text("target_segment"),
  targetSmartListId: text("target_smart_list_id").references(() => smartLists.id),
  variantASubject: text("variant_a_subject"),
  variantBSubject: text("variant_b_subject"),
  // Aggregated stats (synced from Instantly)
  sent: integer("sent").default(0),
  delivered: integer("delivered").default(0),
  opened: integer("opened").default(0),
  replied: integer("replied").default(0),
  bounced: integer("bounced").default(0),
  meetingsBooked: integer("meetings_booked").default(0),
  ordersPlaced: integer("orders_placed").default(0),
  // A/B variant stats
  variantASent: integer("variant_a_sent").default(0),
  variantAOpened: integer("variant_a_opened").default(0),
  variantAReplied: integer("variant_a_replied").default(0),
  variantBSent: integer("variant_b_sent").default(0),
  variantBOpened: integer("variant_b_opened").default(0),
  variantBReplied: integer("variant_b_replied").default(0),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_campaigns_status").on(table.status),
  index("idx_campaigns_type").on(table.type),
  index("idx_campaigns_instantly").on(table.instantlyCampaignId),
]);

export const campaignLeads = sqliteTable("campaign_leads", {
  id: id(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  companyId: text("company_id").notNull().references(() => companies.id),
  contactId: text("contact_id").references(() => contacts.id),
  instantlyLeadId: text("instantly_lead_id"),
  email: text("email"),
  status: text("status", { enum: LEAD_STATUSES }).notNull().default("queued"),
  replyText: text("reply_text"),
  replyClassification: text("reply_classification"),
  sentAt: text("sent_at"),
  openedAt: text("opened_at"),
  repliedAt: text("replied_at"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cl_campaign").on(table.campaignId),
  index("idx_cl_company").on(table.companyId),
  index("idx_cl_status").on(table.status),
  index("idx_cl_instantly").on(table.instantlyLeadId),
]);

// Sync state tracking
export const instantlySync = sqliteTable("instantly_sync", {
  id: id(),
  entityType: text("entity_type").notNull(), // "campaign" | "lead"
  entityId: text("entity_id").notNull(),
  instantlyId: text("instantly_id").notNull(),
  lastSyncedAt: timestamp("last_synced_at"),
  syncStatus: text("sync_status", { enum: ["pending", "synced", "error"] }).notNull().default("pending"),
  errorMessage: text("error_message"),
}, (table) => [
  index("idx_sync_entity").on(table.entityType, table.entityId),
  index("idx_sync_instantly").on(table.instantlyId),
]);
