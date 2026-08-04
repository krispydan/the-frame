export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { backfillAddressesFromShopify } from "@/modules/customers/lib/address-backfill";
import type { ShopifyStore } from "@/modules/orders/lib/shopify-api";

/**
 * POST /api/v1/customers/backfill-addresses  (session-guarded)
 * Fills blank company addresses from Shopify order shipping addresses.
 * Shared logic lives in address-backfill.ts (also used by the ops surface).
 * Body: { stores?: ("wholesale"|"dtc")[], maxPages?: number }
 */
export async function POST(request: NextRequest) {
  let body: { stores?: ShopifyStore[]; maxPages?: number } = {};
  try { body = await request.json(); } catch { /* empty ok */ }
  const result = await backfillAddressesFromShopify(body);
  return NextResponse.json({ ...result, note: "Now re-run geocoding (Retry failed) to place the newly-addressed companies." });
}
