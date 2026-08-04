export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { backfillAddressesFromShopify } from "@/modules/customers/lib/address-backfill";
import type { ShopifyStore } from "@/modules/orders/lib/shopify-api";

/**
 * Token-guarded address backfill (x-ops-key: OPS_TOKEN).
 * POST ?confirm=1  body: { stores?, maxPages? }
 * Fills blank company addresses from Shopify order shipping addresses.
 */
export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  let body: { stores?: ShopifyStore[]; maxPages?: number } = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const result = await backfillAddressesFromShopify(body);
  return NextResponse.json({ ...result, note: "Now run geocode ?mode retry to place the newly-addressed companies." });
}
