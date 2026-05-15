export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { markFaireShippedIfApplicable } from "@/modules/operations/lib/shiphero/mark-faire-shipped";

/**
 * POST /api/v1/integrations/faire/backfill-ship-marks
 *
 * Finds Faire-channel orders that are already marked shipped locally
 * (status='shipped' AND tracking_number IS NOT NULL) but don't yet
 * have a successful row in faire_shipment_marks, and runs the
 * markFaireShippedIfApplicable pipeline for each. Idempotency is
 * preserved by the unique partial index on faire_shipment_marks, so
 * concurrent calls or re-runs are safe.
 *
 * Used after the 'fulfillment' nesting fix to catch up on any
 * shipments whose Shipment Update webhook fired during the bug window
 * and didn't reach the Faire ship-mark step.
 *
 * Body (optional):
 *   { "limit": 50, "dryRun": false }
 *
 * Response: { ok, candidates, processed, results: [{ orderNumber, status, ... }] }
 */
export async function POST(req: NextRequest) {
  let body: { limit?: number; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { limit?: number; dryRun?: boolean };
  } catch {
    // empty body fine
  }
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 500);
  const dryRun = !!body.dryRun;

  // Candidates: shipped wholesale orders with tracking, no success row.
  // Match by order_number since faire_shipment_marks doesn't reference
  // our local orders.id directly. We also LEFT JOIN on the success row so
  // we exclude orders we've already marked.
  const candidates = sqlite
    .prepare(
      `SELECT o.id, o.order_number, o.shiphero_order_id, o.tracking_number, o.tracking_carrier, o.total, o.channel
       FROM orders o
       LEFT JOIN faire_shipment_marks m
         ON m.order_number IN (o.order_number, REPLACE(o.order_number, '#', ''))
         AND m.status = 'success'
       WHERE o.channel IN ('shopify_wholesale', 'faire')
         AND o.status = 'shipped'
         AND o.tracking_number IS NOT NULL
         AND m.id IS NULL
       ORDER BY o.shipped_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      order_number: string | null;
      shiphero_order_id: string | null;
      tracking_number: string | null;
      tracking_carrier: string | null;
      total: number;
      channel: string;
    }>;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      candidates: candidates.length,
      preview: candidates.slice(0, 20).map((c) => ({
        orderNumber: c.order_number,
        tracking: c.tracking_number,
        carrier: c.tracking_carrier,
        total: c.total,
      })),
    });
  }

  const results: Array<{
    orderNumber: string | null;
    status: string;
  }> = [];
  for (const c of candidates) {
    const status = await markFaireShippedIfApplicable({
      localOrderId: c.id,
      orderNumber: c.order_number,
      trackingNumber: c.tracking_number,
      carrier: c.tracking_carrier,
    });
    results.push({ orderNumber: c.order_number, status });
    // Tiny pacing — markFaireShippedIfApplicable hits Faire's API twice
    // (orders list scan + shipments POST), so don't burst.
    await new Promise((r) => setTimeout(r, 250));
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    processed: results.length,
    results,
  });
}
