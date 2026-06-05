export const dynamic = "force-dynamic";
// Hard ceiling for a single slice. With default limit=8 products × 2
// stores × ~3 Shopify calls each at ~1-2s, the typical slice runs
// 30-80s — well under Cloudflare's 100s edge timeout. 95 leaves us
// some headroom but kills a stuck slice rather than returning a 524.
export const maxDuration = 95;

import { NextRequest, NextResponse } from "next/server";
import { runShopifyMetafieldSync } from "@/modules/catalog/lib/shopify-metafields/bulk-sync-job";

/**
 * POST /api/v1/integrations/shopify/run-metafield-sync
 *
 * Trigger the Shopify metafield sync immediately. Chunked to stay
 * under Cloudflare's 100s edge timeout — process a slice of N
 * products per call, return a cursor (`processedThrough`), client
 * loops until `remaining === 0`.
 *
 * Body (all optional):
 *   {
 *     offset?: number   // products to skip from the start (default 0)
 *     limit?: number    // products to process this call (default 8,
 *                       //   max 100 — bigger limits risk a 524 timeout)
 *   }
 *
 * Returns BulkSyncResult: { totalProducts, processed, processedThrough,
 *   remaining, stores: {ok/partial/failed/failures}, durationMs }.
 *
 * Loop pattern:
 *   offset = 0
 *   while true:
 *     r = POST {offset, limit: 8}
 *     if r.remaining == 0: break
 *     offset = r.processedThrough
 */
export async function POST(req: NextRequest) {
  try {
    let body: { offset?: number; limit?: number } = {};
    try { body = await req.json(); } catch { /* ok */ }
    const result = await runShopifyMetafieldSync({
      offset: body.offset,
      limit: body.limit,
    });
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
