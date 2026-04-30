export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";
import { getAppConfig, verifyWebhookHmac } from "@/modules/integrations/lib/shopify/oauth";

/**
 * POST /api/webhooks/shopify/app-uninstalled
 *
 * Fires when a merchant uninstalls the app. Mark the session inactive and
 * clear the access token (it's no longer valid anyway).
 */
export async function POST(request: NextRequest) {
  const config = getAppConfig();
  const headerHmac = request.headers.get("x-shopify-hmac-sha256");
  const shop = request.headers.get("x-shopify-shop-domain");

  // Read raw body for HMAC verification
  const rawBody = await request.text();

  if (!verifyWebhookHmac(rawBody, headerHmac, config.apiSecret)) {
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }
  if (!shop) {
    return NextResponse.json({ error: "Missing X-Shopify-Shop-Domain" }, { status: 400 });
  }

  await db
    .update(shopifyShops)
    .set({
      isActive: false,
      uninstalledAt: new Date().toISOString(),
      lastHealthStatus: "uninstalled",
    })
    .where(eq(shopifyShops.shopDomain, shop));

  return NextResponse.json({ ok: true });
}
