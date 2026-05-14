/**
 * ShipHero schema — webhook ingestion + attachment idempotency.
 *
 * Tables in production are created by idempotent migrations in src/lib/db.ts
 * (CREATE TABLE IF NOT EXISTS). This file is the Drizzle mirror so
 * the rest of the codebase gets compile-time types.
 *
 * See docs/shiphero-webhooks-and-faire-slips.md for the full integration
 * context.
 */

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Every incoming ShipHero webhook lands here for observability. */
export const shipheroWebhookEvents = sqliteTable("shiphero_webhook_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** "Order Allocated", "Shipment Update", etc. */
  topic: text("topic"),
  /** ShipHero order id (base64 GraphQL id) extracted from payload when present. */
  shipheroId: text("shiphero_id"),
  /** Shopify order_number from the payload — used to match back to local orders. */
  externalId: text("external_id"),
  /** ShipHero's timestamp on the event, if provided. */
  triggeredAt: text("triggered_at"),
  receivedAt: text("received_at").default(sql`(datetime('now'))`),
  hmacValid: integer("hmac_valid", { mode: "boolean" }),
  handlerOk: integer("handler_ok", { mode: "boolean" }),
  handlerMessage: text("handler_message"),
  payloadSize: integer("payload_size"),
  payloadPreview: text("payload_preview"),
}, (t) => [
  index("idx_shiphero_webhook_events_received").on(t.receivedAt),
  index("idx_shiphero_webhook_events_topic").on(t.topic),
  index("idx_shiphero_webhook_events_shiphero_id").on(t.shipheroId),
  index("idx_shiphero_webhook_events_external_id").on(t.externalId),
]);

/** Webhooks we've registered with ShipHero via webhook_create mutation. */
export const shipheroWebhookSubscriptions = sqliteTable("shiphero_webhook_subscriptions", {
  /** The ShipHero-issued subscription id. */
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  url: text("url").notNull(),
  /** Shared secret returned by webhook_create. Used to HMAC-verify incoming events. */
  sharedSecret: text("shared_secret"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  deactivatedAt: text("deactivated_at"),
}, (t) => [
  index("idx_shiphero_webhook_subscriptions_topic").on(t.topic),
]);

/** Audit log + idempotency key for packing-slip attaches. */
export const shipheroAttachmentLogs = sqliteTable("shiphero_attachment_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  shipheroOrderId: text("shiphero_order_id").notNull(),
  externalId: text("external_id"),
  faireOrderId: text("faire_order_id"),
  filename: text("filename").notNull(),
  /** "success" | "error" | "skipped_not_faire" | "skipped_no_slip" */
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  attachedAt: text("attached_at").default(sql`(datetime('now'))`),
}, (t) => [
  // One successful attach per (order, filename). Failed attempts can repeat,
  // so the unique index is partial on status = 'success'.
  uniqueIndex("uq_shiphero_attachment_logs_success")
    .on(t.shipheroOrderId, t.filename)
    .where(sql`status = 'success'`),
  index("idx_shiphero_attachment_logs_order").on(t.shipheroOrderId),
]);

export type ShipheroWebhookEvent = typeof shipheroWebhookEvents.$inferSelect;
export type NewShipheroWebhookEvent = typeof shipheroWebhookEvents.$inferInsert;
export type ShipheroWebhookSubscription = typeof shipheroWebhookSubscriptions.$inferSelect;
export type ShipheroAttachmentLog = typeof shipheroAttachmentLogs.$inferSelect;
