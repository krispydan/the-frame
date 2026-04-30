export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  fetchShopifyOrders,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { handleOrderCreate, handleOrderUpdated } from "@/modules/orders/lib/shopify-webhooks";
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

// POST /api/v1/orders/shopify-sync — manual sync of recent Shopify orders.
// Calls the order handlers directly (not through the webhook registry) so we
// don't trip HMAC verification on internal sync calls.
//
// Default window: orders created in the past 14 days. Override by passing
// { days: 30 } in the request body, or { createdAtMin: "2026-01-01T00:00:00Z" }
// for an explicit cutoff. Webhooks handle real-time updates for older orders
// that change status (fulfilled, refunded, etc.).
export const DEFAULT_SYNC_WINDOW_DAYS = 14;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const stores: ShopifyStore[] = body.store
    ? [body.store as ShopifyStore]
    : (["dtc", "wholesale"] as ShopifyStore[]);

  const STORE_TO_CHANNEL: Record<ShopifyStore, string> = { dtc: "retail", wholesale: "wholesale" };

  // Compute "created at or after" cutoff
  const days = typeof body.days === "number" && body.days > 0 ? body.days : DEFAULT_SYNC_WINDOW_DAYS;
  const createdAtMin: string =
    typeof body.createdAtMin === "string" && body.createdAtMin
      ? body.createdAtMin
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let totalSynced = 0;
  let totalErrors = 0;
  const storeResults: Array<{ store: string; synced: number; errors: number; shopDomain?: string }> = [];

  for (const store of stores) {
    if (!(await hasShopifyCredentials(store))) {
      storeResults.push({ store, synced: 0, errors: 0 });
      continue;
    }

    // Resolve the actual shop domain so handlers can detect channel correctly
    let shopDomain: string | undefined;
    try {
      const client = await getShopifyClientByChannel(STORE_TO_CHANNEL[store]);
      shopDomain = client.shopDomain;
    } catch (e) {
      console.error(`[Shopify Sync] No active client for ${store}:`, e);
      storeResults.push({ store, synced: 0, errors: 1 });
      totalErrors += 1;
      continue;
    }

    let synced = 0;
    let errors = 0;

    try {
      const orders = (await fetchShopifyOrders(store, {
        status: "any",
        limit: 250,
        createdAtMin,
      })) as Array<Parameters<typeof handleOrderCreate>[0]>;

      for (const order of orders) {
        try {
          // Always run create-or-update path; handleOrderCreate is idempotent (skips if existing)
          await handleOrderCreate(order, shopDomain);
          // For orders that already exist, also run the update path so status changes flow
          await handleOrderUpdated(order, shopDomain);
          synced++;
        } catch (e) {
          console.error(`[Shopify Sync] Error syncing order ${(order as { name?: string }).name}:`, e);
          errors++;
        }
      }
    } catch (e) {
      console.error(`[Shopify Sync] Error fetching ${store} orders:`, e);
      errors++;
    }

    totalSynced += synced;
    totalErrors += errors;
    storeResults.push({ store, synced, errors, shopDomain });
  }

  return NextResponse.json({
    ok: true,
    message: `Synced ${totalSynced} orders (${totalErrors} errors)`,
    stores: storeResults,
  });
}
