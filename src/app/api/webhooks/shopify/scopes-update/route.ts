export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";
import { getAppConfig, verifyWebhookHmac } from "@/modules/integrations/lib/shopify/oauth";

/**
 * POST /api/webhooks/shopify/scopes-update
 *
 * Fires when the merchant approves an updated set of scopes. Refresh the
 * stored scope string so the settings UI reflects current access.
 */
export async function POST(request: NextRequest) {
  const config = getAppConfig();
  const headerHmac = request.headers.get("x-shopify-hmac-sha256");
  const shop = request.headers.get("x-shopify-shop-domain");

  const rawBody = await request.text();
  if (!verifyWebhookHmac(rawBody, headerHmac, config.apiSecret)) {
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }
  if (!shop) {
    return NextResponse.json({ error: "Missing X-Shopify-Shop-Domain" }, { status: 400 });
  }

  // Body shape: { current: ["read_products","write_products",...], previous: [...] }
  let payload: { current?: string[] } = {};
  try {
    payload = JSON.parse(rawBody);
  } catch { /* ignore */ }

  if (Array.isArray(payload.current)) {
    await db
      .update(shopifyShops)
      .set({
        scope: payload.current.join(","),
        updatedAt: new Date().toISOString(),
        lastHealthStatus: "ok",
        lastHealthError: null,
      })
      .where(eq(shopifyShops.shopDomain, shop));
  }

  return NextResponse.json({ ok: true });
}
