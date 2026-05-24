export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { composeAmazonRows } from "@/modules/catalog/lib/amazon/compose-rows";
import {
  validateAmazonBatch,
  type ValidateInput,
} from "@/modules/catalog/lib/amazon/validator";

/**
 * POST /api/v1/integrations/amazon/validate
 *
 * Dry-run the spreadsheet generation: compose the rows from current
 * catalog + AI listings + image URLs, then run them through the
 * snapshot-driven validator. Returns one ProductValidationResult per
 * product. The download route calls the same composer + validator and
 * refuses to ship a file if any blocked issue exists, but exposing this
 * separately lets the UI render per-product status before the operator
 * commits to downloading.
 *
 * Body (optional):
 *   { "productIds": ["…"] }   defaults to all approved products
 */
export async function POST(req: NextRequest) {
  let body: { productIds?: string[] } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty */
  }

  const composed = await composeAmazonRows(body.productIds);
  if (composed.length === 0) {
    return NextResponse.json({
      ok: true,
      productCount: 0,
      results: [],
      summary: { ready: 0, warning: 0, blocked: 0 },
    });
  }

  const inputs: ValidateInput[] = composed.map((c) => ({
    productId: c.productId,
    productName: c.productName,
    skuPrefix: c.skuPrefix,
    rows: c.rows,
    skuIdentifiers: c.skuIdentifiers,
  }));
  const results = validateAmazonBatch(inputs);

  const summary = {
    ready: results.filter((r) => r.status === "ready").length,
    warning: results.filter((r) => r.status === "warning").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    /** Surface the no-listing / no-image counts so the UI can hint the
     *  operator to run Generate first if many products are blocked
     *  purely on missing prerequisites. */
    missingListing: composed.filter((c) => !c.hasListing).length,
    missingImages: composed.filter((c) => !c.hasImages).length,
  };

  // Persist a tiny summary (settings k/v table) so the page can render
  // "last validation" without re-running the full batch on every load.
  try {
    sqlite
      .prepare(
        `INSERT INTO settings (key, value, type, module, updated_at)
         VALUES ('amazon_last_validation', ?, 'json', 'catalog', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(JSON.stringify({
        ready: summary.ready,
        warning: summary.warning,
        blocked: summary.blocked,
        productCount: composed.length,
        at: new Date().toISOString(),
      }));
  } catch (e) {
    console.error("[amazon validate] persist summary failed:", e);
  }

  return NextResponse.json({
    ok: true,
    productCount: composed.length,
    results,
    summary,
  });
}
