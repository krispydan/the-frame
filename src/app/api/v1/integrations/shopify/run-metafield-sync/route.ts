export const dynamic = "force-dynamic";
// 39 products × 2 stores × ~1-2s each Shopify call = ~2-3 min wall clock.
// Set generously above that ceiling.
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { runShopifyMetafieldSync } from "@/modules/catalog/lib/shopify-metafields/bulk-sync-job";

/**
 * POST /api/v1/integrations/shopify/run-metafield-sync
 *
 * Trigger the Shopify metafield sync immediately, regardless of the
 * nightly cron schedule (which fires at 03:00 UTC). Wraps the same
 * runShopifyMetafieldSync() the cron handler uses — including the
 * Phase 4 extended-metafields payload (deterministic SEO, Custom
 * Labels 0-4, style_era, collection_batch) on every product on both
 * stores.
 *
 * No body params. Returns the same BulkSyncResult shape the cron
 * persists, so the caller can inspect per-store ok/partial/failed
 * counts.
 */
export async function POST(_req: NextRequest) {
  try {
    const result = await runShopifyMetafieldSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 8).join("\n") : undefined,
      },
      { status: 500 },
    );
  }
}
