/**
 * Shopify Admin API helpers for DTC and Wholesale stores.
 * Credentials come from env vars (.env.local).
 */

export type ShopifyStore = "dtc" | "wholesale";

interface ShopifyConfig {
  domain: string;
  accessToken: string;
}

export function getShopifyConfig(store: ShopifyStore): ShopifyConfig {
  if (store === "wholesale") {
    return {
      domain: process.env.SHOPIFY_WHOLESALE_STORE_DOMAIN || "",
      accessToken: process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN || "",
    };
  }
  return {
    domain: process.env.SHOPIFY_DTC_STORE_DOMAIN || "",
    accessToken: process.env.SHOPIFY_DTC_ACCESS_TOKEN || "",
  };
}

export function hasShopifyCredentials(store: ShopifyStore): boolean {
  const cfg = getShopifyConfig(store);
  return !!(cfg.domain && cfg.accessToken);
}

const API_VERSION = "2024-01";

export async function shopifyAdminRequest(
  store: ShopifyStore,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const cfg = getShopifyConfig(store);
  if (!cfg.domain || !cfg.accessToken) {
    throw new Error(`Shopify ${store} credentials not configured`);
  }

  const url = `https://${cfg.domain}/admin/api/${API_VERSION}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": cfg.accessToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ── Webhook Registration ──

const WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "fulfillments/create",
];

export async function registerWebhooks(store: ShopifyStore, callbackUrl: string) {
  const results: Array<{ topic: string; ok: boolean; error?: string }> = [];

  for (const topic of WEBHOOK_TOPICS) {
    try {
      await shopifyAdminRequest(store, "POST", "/webhooks.json", {
        webhook: {
          topic,
          address: callbackUrl,
          format: "json",
        },
      });
      results.push({ topic, ok: true });
    } catch (e) {
      results.push({ topic, ok: false, error: String(e) });
    }
  }

  return results;
}

export async function listWebhooks(store: ShopifyStore) {
  const data = (await shopifyAdminRequest(store, "GET", "/webhooks.json")) as {
    webhooks: Array<{ id: number; topic: string; address: string; created_at: string }>;
  };
  return data.webhooks || [];
}

// ── Order Fetch (for manual sync) ──

export async function fetchShopifyOrders(
  store: ShopifyStore,
  params: { status?: string; since_id?: string; limit?: number } = {},
) {
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit || 250));
  if (params.status) qs.set("status", params.status);
  if (params.since_id) qs.set("since_id", params.since_id);

  const data = (await shopifyAdminRequest(
    store,
    "GET",
    `/orders.json?${qs}`,
  )) as { orders: unknown[] };
  return data.orders || [];
}

// ── Fulfillment Push ──

export async function createShopifyFulfillment(
  store: ShopifyStore,
  shopifyOrderId: string,
  trackingNumber?: string,
  trackingCompany?: string,
) {
  // Get fulfillment orders first (required for newer API)
  const foData = (await shopifyAdminRequest(
    store,
    "GET",
    `/orders/${shopifyOrderId}/fulfillment_orders.json`,
  )) as { fulfillment_orders: Array<{ id: number; status: string; line_items: Array<{ id: number; quantity: number }> }> };

  const openFOs = (foData.fulfillment_orders || []).filter(
    (fo) => fo.status === "open" || fo.status === "in_progress",
  );

  if (openFOs.length === 0) {
    return { ok: false, message: "No open fulfillment orders" };
  }

  // Create fulfillment for all open fulfillment orders
  const lineItemsByFO = openFOs.map((fo) => ({
    fulfillment_order_id: fo.id,
    fulfillment_order_line_items: fo.line_items.map((li) => ({
      id: li.id,
      quantity: li.quantity,
    })),
  }));

  const fulfillmentPayload: Record<string, unknown> = {
    fulfillment: {
      line_items_by_fulfillment_order: lineItemsByFO,
      notify_customer: true,
      tracking_info: trackingNumber
        ? {
            number: trackingNumber,
            company: trackingCompany || undefined,
          }
        : undefined,
    },
  };

  await shopifyAdminRequest(store, "POST", "/fulfillments.json", fulfillmentPayload);
  return { ok: true, message: "Fulfillment created" };
}
