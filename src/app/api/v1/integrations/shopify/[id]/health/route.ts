export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";
import { getShopifyClient, ShopifyAuthError } from "@/modules/integrations/lib/shopify/admin-api";

/**
 * POST /api/v1/integrations/shopify/{id}/health
 *
 * Run a live `{ shop { name } }` GraphQL probe against the stored token and
 * persist the result on the shop row. Used by the settings UI for the
 * "Test connection" button and (optionally) by a cron for periodic checks.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, id));
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  const now = new Date().toISOString();
  try {
    const client = await getShopifyClient(shop.shopDomain);
    const data = await client.graphql<{ shop: { name: string; primaryDomain: { url: string } } }>(`
      query Health { shop { name primaryDomain { url } } }
    `);
    await db.update(shopifyShops).set({
      lastHealthCheckAt: now,
      lastHealthStatus: "ok",
      lastHealthError: null,
      displayName: data.shop.name,
    }).where(eq(shopifyShops.id, id));
    return NextResponse.json({ ok: true, shop: data.shop });
  } catch (e) {
    const isAuth = e instanceof ShopifyAuthError;
    const message = e instanceof Error ? e.message : "Unknown error";
    await db.update(shopifyShops).set({
      lastHealthCheckAt: now,
      lastHealthStatus: isAuth ? "auth_failed" : "error",
      lastHealthError: message,
    }).where(eq(shopifyShops.id, id));
    return NextResponse.json({ ok: false, status: isAuth ? "auth_failed" : "error", error: message }, { status: 200 });
  }
}
