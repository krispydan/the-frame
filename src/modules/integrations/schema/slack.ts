/**
 * Slack notification schema.
 *
 * - slack_channel_routing: one row per notification topic, mapping to a
 *   Slack channel. The UI on /settings/integrations/slack manages these.
 * - slack_message_log: audit row per outbound Slack message. Lets us show
 *   recent activity on the integrations page and surface delivery failures.
 *
 * Bot token lives in SLACK_BOT_TOKEN env (Railway) — never in DB.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const slackChannelRouting = sqliteTable("slack_channel_routing", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** Stable identifier for the kind of notification, e.g. "orders.wholesale". */
  topic: text("topic").notNull().unique(),
  /** Slack channel ID (preferred). e.g. "C0123ABC" — survives renames. */
  channelId: text("channel_id"),
  /** Cached channel name with leading # for display. */
  channelName: text("channel_name"),
  /** Allow disabling a topic without deleting the row. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const slackMessageLog = sqliteTable("slack_message_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  topic: text("topic"),
  channelId: text("channel_id"),
  channelName: text("channel_name"),
  textPreview: text("text_preview"),
  ok: integer("ok", { mode: "boolean" }),
  error: text("error"),
  sentAt: text("sent_at").default(sql`(datetime('now'))`),
});

export type SlackChannelRouting = typeof slackChannelRouting.$inferSelect;
export type SlackMessageLog = typeof slackMessageLog.$inferSelect;

/**
 * The full set of notification topics the app emits. Each one ends up as a
 * row in slack_channel_routing the user can edit. The UI shows them grouped
 * by area for sanity.
 */
export type SlackTopic =
  // Real-time alerts
  | "orders.wholesale"
  | "stock.out_of_stock"
  | "stock.critical_low"
  | "orders.payment_failed"
  | "orders.chargeback"
  | "ops.integration_failure"
  | "ops.connected_store"
  | "ops.webhook_flood"
  | "orders.stuck"
  // Digests
  | "digest.daily"
  | "digest.weekly"
  // Finance/ops
  | "finance.payout_received"
  | "finance.cogs_posted"
  | "finance.xero_sync_failed";

export const SLACK_TOPICS: { topic: SlackTopic; label: string; defaultChannel: string; group: string; description: string }[] = [
  // Orders
  { topic: "orders.wholesale",        label: "Wholesale order placed",       defaultChannel: "jaxy-orders-live",   group: "Orders",       description: "Pings the moment a wholesale order lands. Faire orders too." },
  { topic: "orders.payment_failed",   label: "Payment failed",                defaultChannel: "jaxy-ops-alerts",    group: "Orders",       description: "An order's payment was declined or voided." },
  { topic: "orders.chargeback",       label: "Chargeback / dispute",          defaultChannel: "jaxy-ops-alerts",    group: "Orders",       description: "Customer disputed a charge through their bank." },
  { topic: "orders.stuck",            label: "Order stuck > 48h",             defaultChannel: "jaxy-ops-alerts",    group: "Orders",       description: "Confirmed but not shipped after 48 hours." },

  // Stock
  { topic: "stock.out_of_stock",      label: "SKU out of stock",              defaultChannel: "jaxy-ops-alerts",    group: "Stock",        description: "A SKU just hit zero on hand." },
  { topic: "stock.critical_low",      label: "SKU critically low",            defaultChannel: "jaxy-ops-alerts",    group: "Stock",        description: "A SKU dropped below 25% of its reorder point." },

  // Ops
  { topic: "ops.integration_failure", label: "Integration broken",            defaultChannel: "jaxy-ops-alerts",    group: "Ops",          description: "Shopify token revoked, Xero auth expired, ShipHero down, etc." },
  { topic: "ops.connected_store",     label: "New store connected",           defaultChannel: "jaxy-ops-alerts",    group: "Ops",          description: "Someone connected a new Shopify or Xero account." },
  { topic: "ops.webhook_flood",       label: "Webhook flood detected",        defaultChannel: "jaxy-ops-alerts",    group: "Ops",          description: "Receiving more than 100 webhooks/min — Shopify replay or weirdness." },

  // Finance
  { topic: "finance.payout_received", label: "Shopify payout synced",         defaultChannel: "jaxy-finance-bot",   group: "Finance",      description: "A new payout was synced to Xero as a manual journal." },
  { topic: "finance.cogs_posted",     label: "COGS journal posted",           defaultChannel: "jaxy-finance-bot",   group: "Finance",      description: "Companion COGS journal posted with per-SKU breakdown." },
  { topic: "finance.xero_sync_failed",label: "Xero sync failed",              defaultChannel: "jaxy-finance-bot",   group: "Finance",      description: "A Xero sync errored — token issue, mapping missing, etc." },

  // Digests
  { topic: "digest.daily",            label: "Daily morning digest",          defaultChannel: "jaxy-daily-digest",  group: "Digests",      description: "Yesterday's orders, fulfillment, inventory at 7am PT." },
  { topic: "digest.weekly",           label: "Weekly Monday digest",          defaultChannel: "jaxy-weekly-review", group: "Digests",      description: "Last week's revenue, top SKUs, slow movers, margin." },
];
