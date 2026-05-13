export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { syncSettlementsAllShops } from "@/modules/finance/lib/shopify-settlements";

/**
 * POST /api/v1/finance/settlements/sync
 *
 * Pulls Shopify Payments payouts from every connected shop (retail +
 * wholesale) and writes new ones into the local `settlements` table.
 * Idempotent — payouts already imported (matched by external_id) are
 * skipped.
 *
 * Triggered by:
 *   - "Sync from Shopify" button on /finance?tab=settlements
 *   - shopify-settlements-sync cron (registry.ts, daily 16:00 UTC)
 */
export async function POST() {
  try {
    const result = await syncSettlementsAllShops();
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (err) {
    console.error("[settlements/sync]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
