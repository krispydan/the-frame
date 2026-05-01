/**
 * Shopify shop health probe + notification on status flip.
 *
 * Run periodically from a scheduler (cron, GitHub Action, Railway cron job,
 * etc.) by hitting POST /api/v1/integrations/shopify/health-all.
 */

import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { notifications } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import { getShopifyClient, ShopifyAuthError } from "./admin-api";

export type ProbeResult = {
  shopId: string;
  shopDomain: string;
  channel: string;
  previousStatus: string | null;
  status: "ok" | "auth_failed" | "error";
  error?: string;
  flipped: boolean;
};

async function probeOne(shopId: string): Promise<ProbeResult | null> {
  const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, shopId));
  if (!shop || !shop.isActive) return null;

  const previousStatus = shop.lastHealthStatus;
  const now = new Date().toISOString();
  let status: ProbeResult["status"];
  let errorMessage: string | undefined;

  try {
    const client = await getShopifyClient(shop.shopDomain);
    await client.graphql<{ shop: { name: string } }>(`{ shop { name } }`);
    status = "ok";
  } catch (e) {
    status = e instanceof ShopifyAuthError ? "auth_failed" : "error";
    errorMessage = e instanceof Error ? e.message : "Unknown error";
  }

  await db.update(shopifyShops).set({
    lastHealthCheckAt: now,
    lastHealthStatus: status,
    lastHealthError: errorMessage ?? null,
  }).where(eq(shopifyShops.id, shop.id));

  // Notification on transition: ok -> non-ok creates a critical alert.
  // non-ok -> ok creates a low-severity recovery message.
  let flipped = false;
  if (previousStatus === "ok" && status !== "ok") {
    flipped = true;
    await db.insert(notifications).values({
      type: "agent",
      module: "integrations.shopify",
      severity: "critical",
      title: `Shopify connection failed: ${shop.shopDomain}`,
      message: `Health probe for ${shop.shopDomain} (${shop.channel}) returned "${status}". ${errorMessage ?? ""}\nReconnect from Settings → Integrations → Shopify.`,
      entityId: shop.id,
      entityType: "shopify_shop",
    });
    void notifyShopifyDown(shop.shopDomain, status, errorMessage).catch(() => {});
  } else if (previousStatus && previousStatus !== "ok" && status === "ok") {
    flipped = true;
    await db.insert(notifications).values({
      type: "agent",
      module: "integrations.shopify",
      severity: "low",
      title: `Shopify connection recovered: ${shop.shopDomain}`,
      message: `${shop.shopDomain} (${shop.channel}) is healthy again.`,
      entityId: shop.id,
      entityType: "shopify_shop",
    });
  }

  return {
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    channel: shop.channel,
    previousStatus,
    status,
    error: errorMessage,
    flipped,
  };
}

/** Probe every active shop. Returns one ProbeResult per shop. */
export async function probeAllShops(): Promise<ProbeResult[]> {
  const shops = await db.select().from(shopifyShops).where(eq(shopifyShops.isActive, true));
  const results: ProbeResult[] = [];
  for (const s of shops) {
    const r = await probeOne(s.id);
    if (r) results.push(r);
  }
  return results;
}

/** Slack alert when Shopify connection flips ok -> non-ok. */
async function notifyShopifyDown(shopDomain: string, status: string, errorMessage?: string): Promise<void> {
  const { notifyIntegrationFailure } = await import("@/modules/integrations/lib/slack/notifications");
  await notifyIntegrationFailure({
    service: `Shopify (${shopDomain})`,
    detail: `Health probe returned "${status}".${errorMessage ? ` ${errorMessage}` : ""} Reconnect to refresh the token.`,
    fixUrl: "https://theframe.getjaxy.com/settings/integrations/shopify",
  });
}
