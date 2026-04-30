/**
 * Shopify public-app OAuth helpers.
 *
 * Implements the standard offline-token flow:
 *   1. Merchant clicks Custom Distribution install link
 *   2. Shopify redirects to /api/auth/shopify?shop=...&hmac=...
 *   3. We verify HMAC, generate state nonce, redirect to Shopify consent
 *   4. Shopify redirects back to /api/auth/shopify/callback?code=...&hmac=...&shop=...
 *   5. We verify HMAC, exchange code for offline access_token, store in DB
 *
 * Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
 */

import crypto from "node:crypto";

/** Shopify's expected query-param hostname suffix. */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/i;

export function isValidShopDomain(shop: string | null | undefined): boolean {
  if (!shop) return false;
  return SHOP_DOMAIN_RE.test(shop.trim());
}

/**
 * Verify Shopify's hmac on an OAuth query string.
 *
 * Shopify computes hmac as HMAC-SHA256 over the query string (sorted, with
 * `hmac` itself removed) using the app's API secret.
 */
export function verifyOauthHmac(query: URLSearchParams, apiSecret: string): boolean {
  const provided = query.get("hmac");
  if (!provided) return false;

  const params: [string, string][] = [];
  query.forEach((value, key) => {
    if (key === "hmac" || key === "signature") return;
    params.push([key, value]);
  });
  params.sort(([a], [b]) => a.localeCompare(b));
  const message = params.map(([k, v]) => `${k}=${v}`).join("&");

  const computed = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
  // Constant-time comparison
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a Shopify webhook HMAC. Webhooks send the signature in the
 * `X-Shopify-Hmac-SHA256` header, base64-encoded over the raw request body.
 */
export function verifyWebhookHmac(rawBody: string | Buffer, headerHmac: string | null | undefined, apiSecret: string): boolean {
  if (!headerHmac) return false;
  const computed = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(headerHmac, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function generateState(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Build the Shopify OAuth authorize URL the merchant is redirected to for
 * scope consent.
 */
export function buildAuthorizeUrl(opts: {
  shopDomain: string;
  apiKey: string;
  scopes: string;
  redirectUri: string;
  state: string;
  /** Set true to request an online-access token (we use offline for server-side). */
  online?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: opts.apiKey,
    scope: opts.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  if (opts.online) {
    params.set("grant_options[]", "per-user");
  }
  return `https://${opts.shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

export type AccessTokenResponse = {
  access_token: string;
  scope: string;
};

/**
 * Exchange the OAuth `code` for a permanent offline access token.
 */
export async function exchangeCodeForToken(opts: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  code: string;
}): Promise<AccessTokenResponse> {
  const res = await fetch(`https://${opts.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: opts.apiKey,
      client_secret: opts.apiSecret,
      code: opts.code,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify access_token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as AccessTokenResponse;
  if (!data.access_token) {
    throw new Error("Shopify access_token response missing access_token field");
  }
  return data;
}

/** Canonical app-config read with sensible errors when env is misconfigured. */
export function getAppConfig() {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;
  const scopes = process.env.SHOPIFY_SCOPES;
  if (!apiKey) throw new Error("SHOPIFY_API_KEY env var is missing");
  if (!apiSecret) throw new Error("SHOPIFY_API_SECRET env var is missing");
  if (!appUrl) throw new Error("SHOPIFY_APP_URL env var is missing (e.g. https://theframe.getjaxy.com)");
  if (!scopes) throw new Error("SHOPIFY_SCOPES env var is missing");
  return {
    apiKey,
    apiSecret,
    appUrl: appUrl.replace(/\/$/, ""),
    scopes,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-07",
  };
}
