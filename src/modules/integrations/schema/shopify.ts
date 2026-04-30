/**
 * Shopify multi-shop schema.
 *
 * Each row in `shopify_shops` is one merchant store the-frame can talk to.
 * Channel ("retail", "wholesale", or future) is a free-form string that the
 * UI uses to surface shops by purpose.
 *
 * Tokens are stored here directly (no separate session store) because each
 * shop has exactly one offline token at a time.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const shopifyShops = sqliteTable("shopify_shops", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  shopDomain: text("shop_domain").notNull().unique(),
  displayName: text("display_name"),
  channel: text("channel").notNull(),
  accessToken: text("access_token").notNull(),
  scope: text("scope"),
  apiVersion: text("api_version").default("2025-07"),
  metadata: text("metadata"),  // JSON blob for per-shop config
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastHealthCheckAt: text("last_health_check_at"),
  lastHealthStatus: text("last_health_status"),  // "ok" | "auth_failed" | "rate_limited" | "error"
  lastHealthError: text("last_health_error"),
  installedAt: text("installed_at").default(sql`(datetime('now'))`),
  uninstalledAt: text("uninstalled_at"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const shopifyOauthStates = sqliteTable("shopify_oauth_states", {
  state: text("state").primaryKey(),
  shopDomain: text("shop_domain").notNull(),
  channel: text("channel"),
  returnTo: text("return_to"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

/** Every Shopify webhook we receive lands here for observability. */
export const shopifyWebhookEvents = sqliteTable("shopify_webhook_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  shopDomain: text("shop_domain"),
  topic: text("topic"),
  webhookId: text("webhook_id"),
  triggeredAt: text("triggered_at"),
  receivedAt: text("received_at").default(sql`(datetime('now'))`),
  hmacValid: integer("hmac_valid", { mode: "boolean" }),
  handlerOk: integer("handler_ok", { mode: "boolean" }),
  handlerMessage: text("handler_message"),
  payloadSize: integer("payload_size"),
  payloadPreview: text("payload_preview"),
});

export type ShopifyShop = typeof shopifyShops.$inferSelect;
export type NewShopifyShop = typeof shopifyShops.$inferInsert;
export type ShopifyWebhookEvent = typeof shopifyWebhookEvents.$inferSelect;
