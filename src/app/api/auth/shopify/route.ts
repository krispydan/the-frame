export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyOauthStates } from "@/modules/integrations/schema/shopify";
import {
  buildAuthorizeUrl,
  generateState,
  getAppConfig,
  isValidShopDomain,
  verifyOauthHmac,
} from "@/modules/integrations/lib/shopify/oauth";

/**
 * GET /api/auth/shopify
 *
 * Entry point for Shopify install flow.
 *
 * Two ways this gets called:
 *   1. Merchant clicks Custom Distribution install link
 *      → Shopify hits /api/auth/shopify?shop=...&hmac=...&timestamp=...
 *   2. Settings UI "Connect a Shopify store" button
 *      → /api/auth/shopify?shop=...&channel=retail (no hmac, internal)
 *
 * Query params:
 *   shop      — required, e.g. getjaxy.myshopify.com
 *   channel   — optional, defaults to "retail"; UI-driven for new connections
 *   hmac      — present when initiated by Shopify (validate it)
 *   return_to — optional path to send the user after a successful callback
 *
 * We generate a state nonce, persist it (with shop + channel), and redirect
 * to Shopify's OAuth consent screen.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const shop = searchParams.get("shop");
  const channel = searchParams.get("channel") || "retail";
  const returnTo = searchParams.get("return_to");

  if (!shop || !isValidShopDomain(shop)) {
    return NextResponse.json({ error: "shop query param required (e.g. yourstore.myshopify.com)" }, { status: 400 });
  }

  const config = getAppConfig();

  // If Shopify initiated the flow, hmac will be present — validate it.
  if (searchParams.has("hmac")) {
    if (!verifyOauthHmac(searchParams, config.apiSecret)) {
      return NextResponse.json({ error: "Invalid HMAC" }, { status: 400 });
    }
  }

  const state = generateState();
  await db.insert(shopifyOauthStates).values({
    state,
    shopDomain: shop,
    channel,
    returnTo: returnTo || null,
  });

  const redirectUri = `${config.appUrl}/api/auth/shopify/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    shopDomain: shop,
    apiKey: config.apiKey,
    scopes: config.scopes,
    redirectUri,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}
