export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops, shopifyOauthStates } from "@/modules/integrations/schema/shopify";
import { eq, sql } from "drizzle-orm";
import {
  exchangeCodeForToken,
  getAppConfig,
  isValidShopDomain,
  verifyOauthHmac,
} from "@/modules/integrations/lib/shopify/oauth";

/**
 * GET /api/auth/shopify/callback
 *
 * OAuth callback — Shopify redirects here with `code`, `hmac`, `shop`, `state`.
 *
 * Steps:
 *   1. Verify HMAC (anti-tamper)
 *   2. Look up state — must match a recent shopify_oauth_states row
 *   3. Exchange code for offline access token
 *   4. Upsert into shopify_shops (re-installs update existing row)
 *   5. Delete the state nonce
 *   6. Redirect to settings page (or return_to if it was passed in)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!shop || !isValidShopDomain(shop)) {
    return errorRedirect(request, "invalid_shop", "Invalid shop parameter");
  }
  if (!code) {
    return errorRedirect(request, "missing_code", "Missing OAuth code");
  }
  if (!state) {
    return errorRedirect(request, "missing_state", "Missing OAuth state");
  }

  const config = getAppConfig();
  if (!verifyOauthHmac(searchParams, config.apiSecret)) {
    return errorRedirect(request, "invalid_hmac", "OAuth HMAC failed");
  }

  // Look up state nonce
  const [stateRow] = await db
    .select()
    .from(shopifyOauthStates)
    .where(eq(shopifyOauthStates.state, state));
  if (!stateRow) {
    return errorRedirect(request, "unknown_state", "OAuth state not recognized — try connecting again");
  }
  if (stateRow.shopDomain !== shop) {
    return errorRedirect(request, "shop_mismatch", "OAuth state shop mismatch");
  }

  // Exchange code for offline token
  let token;
  try {
    token = await exchangeCodeForToken({
      shopDomain: shop,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      code,
    });
  } catch (e) {
    console.error("[shopify/callback] exchange failed:", e);
    return errorRedirect(request, "exchange_failed", e instanceof Error ? e.message : "Token exchange failed");
  }

  const channel = stateRow.channel || "retail";
  const now = new Date().toISOString();

  // Upsert: if shop already exists, refresh token + scope; else insert
  const [existing] = await db
    .select()
    .from(shopifyShops)
    .where(eq(shopifyShops.shopDomain, shop));

  if (existing) {
    await db
      .update(shopifyShops)
      .set({
        accessToken: token.access_token,
        scope: token.scope,
        channel,
        isActive: true,
        uninstalledAt: null,
        updatedAt: now,
        lastHealthStatus: "ok",
        lastHealthError: null,
        lastHealthCheckAt: now,
      })
      .where(eq(shopifyShops.id, existing.id));
  } else {
    await db.insert(shopifyShops).values({
      shopDomain: shop,
      displayName: shop.replace(/\.myshopify\.com$/, ""),
      channel,
      accessToken: token.access_token,
      scope: token.scope,
      apiVersion: config.apiVersion,
      isActive: true,
      installedAt: now,
      updatedAt: now,
      lastHealthStatus: "ok",
      lastHealthCheckAt: now,
    });
  }

  // Clean up the state nonce + any other expired ones for this shop
  await db.delete(shopifyOauthStates).where(eq(shopifyOauthStates.state, state));
  // Best-effort: prune states older than 1 hour
  try {
    await db.run(sql`DELETE FROM shopify_oauth_states WHERE created_at < datetime('now', '-1 hour')`);
  } catch { /* ignore */ }

  // Redirect to settings (or where the caller asked)
  const target = stateRow.returnTo || "/settings/integrations/shopify?connected=" + encodeURIComponent(shop);
  return NextResponse.redirect(new URL(target, request.url));
}

function errorRedirect(request: NextRequest, code: string, message: string) {
  const url = new URL("/settings/integrations/shopify", request.url);
  url.searchParams.set("error", code);
  url.searchParams.set("error_message", message);
  return NextResponse.redirect(url);
}
