/**
 * Shopify Admin API client — DB-backed multi-shop.
 *
 * Always look up tokens from the shopify_shops table. Never read tokens from
 * env vars (those were the legacy single-shop pattern).
 *
 * Patterns:
 *   const client = await getShopifyClient("getjaxy.myshopify.com");
 *   const data = await client.graphql(`{ shop { name } }`);
 *
 *   const client = await getShopifyClientByChannel("retail");
 *   const data = await client.rest("GET", "/products/123.json");
 *
 *   const shops = await listInstalledShops();
 */

import { db } from "@/lib/db";
import { shopifyShops, type ShopifyShop } from "@/modules/integrations/schema/shopify";
import { eq, and } from "drizzle-orm";

export class ShopifyAuthError extends Error {
  constructor(message: string, public shopDomain: string) {
    super(message);
    this.name = "ShopifyAuthError";
  }
}

export class ShopifyApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

export interface ShopifyClient {
  shopDomain: string;
  channel: string;
  apiVersion: string;
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  rest(method: string, path: string, body?: unknown): Promise<unknown>;
}

async function loadShop(shopDomain: string): Promise<ShopifyShop> {
  const rows = await db
    .select()
    .from(shopifyShops)
    .where(and(eq(shopifyShops.shopDomain, shopDomain), eq(shopifyShops.isActive, true)));
  const shop = rows[0];
  if (!shop) {
    throw new ShopifyAuthError(`No active Shopify connection for ${shopDomain}. Connect the store in Settings → Integrations.`, shopDomain);
  }
  if (!shop.accessToken) {
    throw new ShopifyAuthError(`Shopify connection for ${shopDomain} has no access token.`, shopDomain);
  }
  return shop;
}

async function loadShopByChannel(channel: string): Promise<ShopifyShop> {
  const rows = await db
    .select()
    .from(shopifyShops)
    .where(and(eq(shopifyShops.channel, channel), eq(shopifyShops.isActive, true)));
  if (rows.length === 0) {
    throw new ShopifyAuthError(`No active Shopify connection found for channel "${channel}".`, channel);
  }
  if (rows.length > 1) {
    throw new ShopifyAuthError(
      `Multiple active Shopify connections for channel "${channel}" — pass a shop_domain explicitly: ${rows.map(r => r.shopDomain).join(", ")}`,
      channel,
    );
  }
  return rows[0];
}

function buildClient(shop: ShopifyShop): ShopifyClient {
  const apiVersion = shop.apiVersion || "2025-07";
  const baseHeaders = () => ({
    "X-Shopify-Access-Token": shop.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const graphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const url = `https://${shop.shopDomain}/admin/api/${apiVersion}/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) {
      throw new ShopifyAuthError(`Shopify rejected token for ${shop.shopDomain} — reconnect the store.`, shop.shopDomain);
    }
    if (!res.ok) {
      throw new ShopifyApiError(`Shopify GraphQL ${res.status}`, res.status, await res.text());
    }
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors) {
      throw new ShopifyApiError("GraphQL errors", 200, json.errors);
    }
    return json.data as T;
  };

  const rest = async (method: string, path: string, body?: unknown) => {
    const url = `https://${shop.shopDomain}/admin/api/${apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      headers: baseHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      throw new ShopifyAuthError(`Shopify rejected token for ${shop.shopDomain} — reconnect the store.`, shop.shopDomain);
    }
    if (!res.ok) {
      throw new ShopifyApiError(`Shopify REST ${method} ${path} failed (${res.status})`, res.status, await res.text());
    }
    return res.json();
  };

  return {
    shopDomain: shop.shopDomain,
    channel: shop.channel,
    apiVersion,
    graphql,
    rest,
  };
}

/** Get a client for a specific shop domain. */
export async function getShopifyClient(shopDomain: string): Promise<ShopifyClient> {
  const shop = await loadShop(shopDomain);
  return buildClient(shop);
}

/** Convenience: get the single active client for a channel ("retail", "wholesale", etc.). */
export async function getShopifyClientByChannel(channel: string): Promise<ShopifyClient> {
  const shop = await loadShopByChannel(channel);
  return buildClient(shop);
}

/** List all currently-connected shops. */
export async function listInstalledShops(): Promise<ShopifyShop[]> {
  return db.select().from(shopifyShops).where(eq(shopifyShops.isActive, true));
}

/** List all rows including uninstalled — for the settings UI. */
export async function listAllShops(): Promise<ShopifyShop[]> {
  return db.select().from(shopifyShops);
}
