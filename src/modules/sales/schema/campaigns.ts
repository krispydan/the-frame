/**
 * F3-003: Campaign & Campaign Lead schema
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
// Note: FK references omitted from drizzle schema to avoid circular imports.
// Actual FK constraints exist in the SQLite migration.

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

/**
 * Delivery channels a campaign can ship through. Multi-select per
 * campaign — a single Brand Carriers v1 cohort fans out to Instantly +
 * PhoneBurner + Direct Mail in parallel rather than living as three
 * separate rows with overlapping membership.
 *
 * `type` above is kept as the campaign's INTENT (cold outreach vs
 * A/B test vs re-engagement). `channels` is the orthogonal "how does
 * it ship" axis.
 *
 * Backfill mapping for pre-2026-06-19 rows (done in src/lib/db.ts on
 * boot): email_sequence/re_engagement/ab_test → ["instantly"],
 * calling → ["phoneburner"].
 */
export const CAMPAIGN_CHANNELS = ["instantly", "phoneburner", "direct_mail"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_CHANNEL_LABELS: Record<CampaignChannel, string> = {
  instantly: "Instantly (Email)",
  phoneburner: "PhoneBurner (Calls)",
  direct_mail: "Direct Mail",
};

export const CAMPAIGN_CHANNEL_SHORT_LABELS: Record<CampaignChannel, string> = {
  instantly: "Email",
  phoneburner: "Calls",
  direct_mail: "Mail",
};

/** Whether the push pipeline for this channel is wired up yet. */
export const CAMPAIGN_CHANNEL_IMPLEMENTED: Record<CampaignChannel, boolean> = {
  instantly: true,
  phoneburner: true,
  direct_mail: false, // schema-supported; vendor not picked yet
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
  /**
   * Delivery channels this campaign ships through. JSON-encoded array
   * of CampaignChannel values, e.g. `["instantly","phoneburner"]`.
   * Multi-select per campaign — one Brand Carriers cohort fans out to
   * email + calls + (eventually) direct mail simultaneously.
   * Defaults to ["instantly"] for back-compat with the old single-channel
   * model; backfilled from `type` for pre-existing rows in src/lib/db.ts.
   */
  channels: text("channels").notNull().default('["instantly"]'),
  instantlyCampaignId: text("instantly_campaign_id"),
  /** PhoneBurner folder ID assigned to this campaign. Set on first
   *  push. Mirrors instantlyCampaignId. */
  phoneburnerFolderId: text("phoneburner_folder_id"),
  targetSegment: text("target_segment"),
  targetSmartListId: text("target_smart_list_id"),
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
  campaignId: text("campaign_id").notNull(),
  companyId: text("company_id").notNull(),
  contactId: text("contact_id"),
  instantlyLeadId: text("instantly_lead_id"),
  /** PhoneBurner contact ID stamped after the lead is pushed. Null
   *  until pushed (or for non-calling campaigns). */
  phoneburnerContactId: text("phoneburner_contact_id"),
  email: text("email"),
  status: text("status", { enum: LEAD_STATUSES }).notNull().default("queued"),
  replyText: text("reply_text"),
  replyClassification: text("reply_classification"),
  dismissed: integer("dismissed").default(0),
  sentAt: text("sent_at"),
  openedAt: text("opened_at"),
  repliedAt: text("replied_at"),
  /** Updated by the phoneburner-call-poll cron when a new call lands. */
  lastCalledAt: text("last_called_at"),
  /** Raw PhoneBurner disposition label from the most recent call (no
   *  canonical mapping — see plan 2026-06-19). */
  lastCallDisposition: text("last_call_disposition"),
  /** Total calls logged for this lead — increments on each new
   *  phoneburner_call_log row. */
  callCount: integer("call_count").default(0),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cl_campaign").on(table.campaignId),
  index("idx_cl_company").on(table.companyId),
  index("idx_cl_status").on(table.status),
  index("idx_cl_instantly").on(table.instantlyLeadId),
]);

// PhoneBurner per-call log — one row per call event, dedup PK on PB's
// call_id. Populated by the polling cron (every 5 min). See
// src/modules/sales/lib/phoneburner-sync.ts.
export const phoneburnerCallLog = sqliteTable("phoneburner_call_log", {
  id: text("id").primaryKey(), // PB call_id, not a uuid
  campaignLeadId: text("campaign_lead_id"),
  companyId: text("company_id"),
  phoneburnerContactId: text("phoneburner_contact_id"),
  agentId: text("agent_id"),
  agentEmail: text("agent_email"),
  durationSeconds: integer("duration_seconds"),
  connected: integer("connected"),
  disposition_label: text("disposition_label"),
  disposition_id: text("disposition_id"),
  notes: text("notes"),
  recordingUrl: text("recording_url"),
  calledAt: text("called_at"),
  ingestedAt: timestamp("ingested_at"),
}, (table) => [
  index("idx_phoneburner_call_log_company").on(table.companyId),
  index("idx_phoneburner_call_log_called_at").on(table.calledAt),
  index("idx_phoneburner_call_log_lead").on(table.campaignLeadId),
  index("idx_phoneburner_call_log_pb_contact").on(table.phoneburnerContactId),
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
