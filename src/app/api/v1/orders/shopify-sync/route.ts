export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  fetchShopifyOrders,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { webhookRegistry } from "@/modules/core/lib/webhooks";

// Ensure the shopify handler is registered
import "@/modules/orders/lib/shopify-webhooks";

// POST /api/v1/orders/shopify-sync — manual full sync of Shopify orders
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const stores: ShopifyStore[] = body.store
    ? [body.store as ShopifyStore]
    : (["dtc", "wholesale"] as ShopifyStore[]);

  const handler = webhookRegistry.getHandler("shopify");
  if (!handler) {
    return NextResponse.json({ error: "Shopify handler not registered" }, { status: 500 });
  }

  let totalSynced = 0;
  let totalErrors = 0;
  const storeResults: Array<{ store: string; synced: number; errors: number }> = [];

  for (const store of stores) {
    if (!hasShopifyCredentials(store)) {
      storeResults.push({ store, synced: 0, errors: 0 });
      continue;
    }

    let synced = 0;
    let errors = 0;

    try {
      const orders = await fetchShopifyOrders(store, { status: "any", limit: 250 });

      for (const order of orders) {
        try {
          await handler({
            provider: "shopify",
            headers: { "x-shopify-topic": "orders/create" },
            body: JSON.stringify(order),
            parsedBody: order,
          });
          synced++;
        } catch (e) {
          console.error(`[Shopify Sync] Error syncing order:`, e);
          errors++;
        }
      }
    } catch (e) {
      console.error(`[Shopify Sync] Error fetching ${store} orders:`, e);
      errors++;
    }

    totalSynced += synced;
    totalErrors += errors;
    storeResults.push({ store, synced, errors });
  }

  return NextResponse.json({
    ok: true,
    message: `Synced ${totalSynced} orders (${totalErrors} errors)`,
    stores: storeResults,
  });
}
