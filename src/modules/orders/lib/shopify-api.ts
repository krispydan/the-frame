/**
 * Shopify Admin API helpers for DTC and Wholesale stores.
 *
 * Credentials are looked up from the shopify_shops table (DB-backed OAuth).
 * The legacy "dtc"/"wholesale" type maps to the multi-shop channel strings
 * "retail"/"wholesale" so callers don't need to change.
 */

import {
  getShopifyClientByChannel,
  ShopifyAuthError,
  type ShopifyClient,
} from "@/modules/integrations/lib/shopify/admin-api";
import { listInstalledShops } from "@/modules/integrations/lib/shopify/admin-api";

export type ShopifyStore = "dtc" | "wholesale";

const STORE_TO_CHANNEL: Record<ShopifyStore, string> = {
  dtc: "retail",
  wholesale: "wholesale",
};

/**
 * Returns true if a connected Shopify shop exists for the given logical
 * store. Async because it hits the DB.
 */
export async function hasShopifyCredentials(store: ShopifyStore): Promise<boolean> {
  const channel = STORE_TO_CHANNEL[store];
  const all = await listInstalledShops();
  return all.some((s) => s.channel === channel && s.isActive);
}

async function getClientForStore(store: ShopifyStore): Promise<ShopifyClient> {
  const channel = STORE_TO_CHANNEL[store];
  return getShopifyClientByChannel(channel);
}

export async function shopifyAdminRequest(
  store: ShopifyStore,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let client: ShopifyClient;
  try {
    client = await getClientForStore(store);
  } catch (e) {
    if (e instanceof ShopifyAuthError) {
      throw new Error(`Shopify ${store} credentials not configured: ${e.message}`);
    }
    throw e;
  }
  return client.rest(method, path, body);
}

// ── Product Create / Update ──

interface ShopifyProductPayload {
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string;
  variants: Array<{
    sku: string;
    price: string;
    compare_at_price?: string;
    option1: string;
    inventory_management?: string;
    barcode?: string;
  }>;
  images?: Array<{ src: string; alt?: string }>;
  options?: Array<{ name: string; values: string[] }>;
}

export async function createShopifyProduct(
  store: ShopifyStore,
  product: ShopifyProductPayload,
) {
  const data = (await shopifyAdminRequest(store, "POST", "/products.json", {
    product,
  })) as { product: { id: number; handle: string; variants: Array<{ id: number; sku: string }> } };
  return data.product;
}

export async function updateShopifyProduct(
  store: ShopifyStore,
  shopifyProductId: string,
  product: Partial<ShopifyProductPayload>,
) {
  const data = (await shopifyAdminRequest(store, "PUT", `/products/${shopifyProductId}.json`, {
    product,
  })) as { product: { id: number; handle: string; variants: Array<{ id: number; sku: string }> } };
  return data.product;
}

export async function findShopifyProductBySku(
  store: ShopifyStore,
  skuPrefix: string,
): Promise<{ id: number; title: string; variants: Array<{ id: number; sku: string }> } | null> {
  // Search by SKU via the product listing endpoint
  const data = (await shopifyAdminRequest(
    store,
    "GET",
    `/products.json?limit=250&fields=id,title,variants`,
  )) as { products: Array<{ id: number; title: string; variants: Array<{ id: number; sku: string }> }> };

  // Match by SKU prefix (any variant SKU starts with the prefix)
  const match = data.products.find((p) =>
    p.variants.some((v) => v.sku?.startsWith(skuPrefix))
  );
  return match || null;
}

// ── Metafields ──

export interface ShopifyMetafield {
  id?: number;
  namespace: string;
  key: string;
  value: string;
  type: string; // e.g. "single_line_text_field", "list.metaobject_reference", "boolean"
  description?: string;
}

export async function shopifyGraphqlRequest<T = unknown>(
  store: ShopifyStore,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const client = await getClientForStore(store);
  return client.graphql<T>(query, variables);
}

export interface ShopifyMetafieldDefinition {
  id: string;
  name: string;
  namespace: string;
  key: string;
  description: string | null;
  type: { name: string };
  ownerType: string;
}

export async function getMetafieldDefinition(
  store: ShopifyStore,
  definitionId: string, // numeric ID from admin URL
): Promise<ShopifyMetafieldDefinition | null> {
  const gid = `gid://shopify/MetafieldDefinition/${definitionId}`;
  const query = `
    query($id: ID!) {
      metafieldDefinition(id: $id) {
        id
        name
        namespace
        key
        description
        type { name }
        ownerType
      }
    }
  `;
  const data = await shopifyGraphqlRequest<{ metafieldDefinition: ShopifyMetafieldDefinition | null }>(
    store,
    query,
    { id: gid },
  );
  return data.metafieldDefinition;
}

export async function getProductMetafields(
  store: ShopifyStore,
  shopifyProductId: string,
): Promise<ShopifyMetafield[]> {
  const data = (await shopifyAdminRequest(
    store,
    "GET",
    `/products/${shopifyProductId}/metafields.json`,
  )) as { metafields: ShopifyMetafield[] };
  return data.metafields || [];
}

export async function setProductMetafield(
  store: ShopifyStore,
  shopifyProductId: string,
  metafield: ShopifyMetafield,
): Promise<ShopifyMetafield> {
  const data = (await shopifyAdminRequest(
    store,
    "POST",
    `/products/${shopifyProductId}/metafields.json`,
    { metafield },
  )) as { metafield: ShopifyMetafield };
  return data.metafield;
}

export async function deleteProductMetafield(
  store: ShopifyStore,
  metafieldId: number,
): Promise<void> {
  await shopifyAdminRequest(store, "DELETE", `/metafields/${metafieldId}.json`);
}

// ── GraphQL helpers for Shopify category + taxonomy metafields ──
//
// These power the categorizer sync: they set the Shopify taxonomy category on
// a product, resolve taxonomy metaobject handles to per-store GIDs, and write
// a batch of metafields in a single mutation.

/**
 * Set the Shopify taxonomy category on a product.
 * @param productGid e.g. "gid://shopify/Product/9177987711125"
 * @param categoryGid e.g. "gid://shopify/TaxonomyCategory/aa-2-27" (Sunglasses)
 */
export async function setProductCategory(
  store: ShopifyStore,
  productGid: string,
  categoryGid: string,
): Promise<{ ok: boolean; userErrors: Array<{ field: string[] | null; message: string }> }> {
  const mutation = `
    mutation setCategory($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id category { id } }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphqlRequest<{
    productUpdate: {
      product: { id: string; category: { id: string } | null } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(store, mutation, { input: { id: productGid, category: categoryGid } });
  const errs = data.productUpdate.userErrors || [];
  return { ok: errs.length === 0, userErrors: errs };
}

/**
 * Resolve a taxonomy metaobject handle (e.g. "black" in type
 * "shopify--color-pattern") to its per-store GID.
 * Returns null if the handle doesn't exist on this store.
 */
export async function resolveMetaobjectHandle(
  store: ShopifyStore,
  type: string,
  handle: string,
): Promise<string | null> {
  const query = `
    query($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id }
    }
  `;
  try {
    const data = await shopifyGraphqlRequest<{
      metaobjectByHandle: { id: string } | null;
    }>(store, query, { handle: { type, handle } });
    return data.metaobjectByHandle?.id || null;
  } catch (e) {
    // A bad handle or unknown type returns as null rather than throwing so
    // the caller can log and skip the field without crashing the whole sync.
    console.warn(`[shopify] resolveMetaobjectHandle(${type}, ${handle}) failed:`, e);
    return null;
  }
}

export interface MetafieldsSetInput {
  ownerId: string; // product GID
  namespace: string;
  key: string;
  type: string; // e.g. "list.metaobject_reference", "single_line_text_field"
  value: string; // for list.* types this must be a JSON-encoded string, NOT a JSON array literal
}

/**
 * Batch upsert metafields on one or more owner resources in a single call.
 * `metafieldsSet` is always an upsert — safe to re-run.
 */
export async function metafieldsSet(
  store: ShopifyStore,
  metafields: MetafieldsSetInput[],
): Promise<{
  ok: boolean;
  written: Array<{ id: string; namespace: string; key: string }>;
  userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
}> {
  if (metafields.length === 0) return { ok: true, written: [], userErrors: [] };
  const mutation = `
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message code }
      }
    }
  `;
  const data = await shopifyGraphqlRequest<{
    metafieldsSet: {
      metafields: Array<{ id: string; namespace: string; key: string }>;
      userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
    };
  }>(store, mutation, { metafields });
  const errs = data.metafieldsSet.userErrors || [];
  return {
    ok: errs.length === 0,
    written: data.metafieldsSet.metafields || [],
    userErrors: errs,
  };
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
