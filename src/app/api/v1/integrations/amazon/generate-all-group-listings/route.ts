export const dynamic = "force-dynamic";
// 7 groups × ~20s per Claude vision call = ~140s. With a few retries
// or slow groups, can creep up. Set under Cloudflare's 100s edge
// timeout — process one group per call instead. The client loops.
export const maxDuration = 95;

import { NextRequest, NextResponse } from "next/server";
import {
  generateAmazonGroupListing,
  listAmazonGroupKeys,
} from "@/modules/catalog/lib/amazon/ai-generate-amazon";

/**
 * POST /api/v1/integrations/amazon/generate-all-group-listings
 *
 * Phase 3 of ~/.claude/plans/tender-dazzling-sparkle.md. Generates one
 * Amazon parent listing per shape group (round, aviator, square, …)
 * via Claude vision. Chunked at 1 group per call to stay under
 * Cloudflare's 100s edge timeout. Client loops until remaining = 0.
 *
 * Body (all optional):
 *   { offset?: number, limit?: number, dryRun?: boolean }
 *   - offset:  skip this many groups
 *   - limit:   process this many (default 1, since each is ~20s)
 *   - dryRun:  validate but don't persist
 *
 * Returns:
 *   { ok, totalGroups, processed, processedThrough, remaining,
 *     results: [{ groupKey, persisted, errors, warnings }] }
 *
 * Loop pattern:
 *   offset = 0
 *   while true:
 *     r = POST { offset, limit: 1 }
 *     if r.remaining == 0: break
 *     offset = r.processedThrough
 */
export async function POST(req: NextRequest) {
  try {
    let body: { offset?: number; limit?: number; dryRun?: boolean } = {};
    try { body = await req.json(); } catch { /* ok */ }

    const offset = Math.max(0, body.offset ?? 0);
    const limit = Math.max(1, Math.min(7, body.limit ?? 1));
    const dryRun = body.dryRun === true;

    const allGroups = await listAmazonGroupKeys();
    const slice = allGroups.slice(offset, offset + limit);

    const results = [];
    for (const g of slice) {
      const r = await generateAmazonGroupListing(g.groupKey, { dryRun });
      results.push({
        groupKey: r.groupKey,
        shape: r.shape,
        styleCount: r.styleCount,
        persisted: r.persisted,
        titlePreview: r.output?.title.slice(0, 80) ?? null,
        errors: r.errors,
        warnings: r.warnings,
      });
    }

    const processedThrough = offset + slice.length;
    return NextResponse.json({
      ok: true,
      dryRun,
      totalGroups: allGroups.length,
      processed: slice.length,
      processedThrough,
      remaining: Math.max(0, allGroups.length - processedThrough),
      results,
    });
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
