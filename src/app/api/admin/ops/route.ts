export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";

/**
 * Token-guarded ops index. Hitting this with a valid x-ops-key confirms the
 * OPS_TOKEN is configured and correct, and lists the available operations.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  return NextResponse.json({
    ok: true,
    operations: {
      "GET  /api/admin/ops/geocode?mode=count|diag|failures": "geocoding status / reachability probe / failure breakdown",
      "POST /api/admin/ops/geocode?confirm=1": "run a geocode batch { limit, force, retryFailed, customersOnly }",
      "POST /api/admin/ops/backfill-addresses?confirm=1": "fill blank company addresses from Shopify { stores, maxPages }",
      "GET  /api/admin/ops/order-lookup?number=&accountId=": "where an order actually lives vs. the account",
    },
    auth: "x-ops-key: <OPS_TOKEN>  (mutations also require ?confirm=1)",
  });
}
