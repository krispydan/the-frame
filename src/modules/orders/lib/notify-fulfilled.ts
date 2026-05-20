/**
 * Build + send the "📦 order fulfilled" Slack alert from just an orderId
 * plus tracking info. Shared between the Shopify webhook handler
 * (modules/orders/lib/shopify-webhooks.ts) and the ShipHero shipment-update
 * handler (modules/operations/lib/shiphero/shipment-update.ts) so both
 * channels send the same alert with the same shape.
 *
 * Idempotency: callers must only invoke this on the non-shipped → shipped
 * transition. We don't re-check inside this helper.
 *
 * Never throws — Slack failures are logged and swallowed. The order itself
 * is already updated; we don't want a Slack outage to wedge the webhook.
 */

import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies } from "@/modules/sales/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { and } from "drizzle-orm";

/**
 * Derive the Shopify shop domain from the order's channel. Used when the
 * caller doesn't have shop context handy (e.g. the ShipHero shipment-
 * update path knows only the local order id). Without this, the alert
 * footer was inconsistent: orders where the Shopify webhook won the race
 * got a "Shopify" link; orders where the ShipHero webhook won didn't.
 */
function shopDomainForOrderChannel(channel: string): string | null {
  const shopChannel =
    channel === "shopify_dtc" ? "retail"
    : channel === "shopify_wholesale" ? "wholesale"
    : null;
  if (!shopChannel) return null;
  const row = db
    .select({ shopDomain: shopifyShops.shopDomain })
    .from(shopifyShops)
    .where(and(eq(shopifyShops.channel, shopChannel), eq(shopifyShops.isActive, true)))
    .get();
  return row?.shopDomain ?? null;
}

export async function notifyOrderShippedById(opts: {
  orderId: string;
  /** Tracking info from the webhook payload. */
  trackingNumber?: string | null;
  trackingCarrier?: string | null;
  trackingUrl?: string | null;
  /** Shopify shop domain (e.g. "getjaxy.myshopify.com") for the deep link.
   *  Optional — omit on the ShipHero path where we don't know which Shopify
   *  store the order originated from at this point. */
  shopDomain?: string | null;
  /** ShipHero base64 order id, for a ShipHero deep link. Optional. */
  shipheroOrderId?: string | null;
}): Promise<void> {
  try {
    const order = db.select().from(orders).where(eq(orders.id, opts.orderId)).get();
    if (!order) {
      console.warn(`[notify-fulfilled] order not found: ${opts.orderId}`);
      return;
    }

    // Prefer the recipient captured straight off the order's shipping
    // address. Fall back to the CRM company name only for older orders
    // created before ship_to_name existed.
    const companyName =
      order.shipToName?.trim() ||
      (order.companyId
        ? db
            .select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, order.companyId))
            .get()?.name ?? null
        : null);

    const itemRows = db
      .select({ qty: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .all();
    const itemCount = itemRows.reduce((s, r) => s + (r.qty || 0), 0);

    const {
      notifyOrderFulfilled,
      faireOrderUrlFromName,
      shopifyAdminOrderUrl,
    } = await import("@/modules/integrations/lib/slack/notifications");

    const faireUrl = faireOrderUrlFromName(order.orderNumber);
    // Resolve shopDomain from the caller, else derive from the order's
    // channel so the alert always has a Shopify link regardless of which
    // webhook path (Shopify fulfillments/create vs ShipHero Shipment
    // Update) fired the notification.
    const shopDomain = opts.shopDomain ?? shopDomainForOrderChannel(order.channel);
    const shopifyUrl = shopifyAdminOrderUrl(shopDomain, order.externalId);

    await notifyOrderFulfilled({
      orderNumber: order.orderNumber,
      channel: order.channel,
      total: order.total,
      currency: order.currency || "USD",
      itemCount,
      companyName,
      trackingNumber: opts.trackingNumber ?? order.trackingNumber ?? null,
      trackingCarrier: opts.trackingCarrier ?? order.trackingCarrier ?? null,
      trackingUrl: opts.trackingUrl ?? null,
      shopifyAdminUrl: shopifyUrl,
      faireUrl,
    });
  } catch (e) {
    console.error("[notify-fulfilled] failed:", e);
  }
}
