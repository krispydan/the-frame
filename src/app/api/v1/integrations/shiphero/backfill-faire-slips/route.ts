export const dynamic = "force-dynamic";
// Long-running endpoint — disable the route handler's default timeout.
// 50 orders × ~1s each + ShipHero pagination ~= up to 5 min.
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { getOrders } from "@/modules/operations/lib/shiphero/api-client";
import {
  attachFairePackingSlipToOrder,
  type AttachStatus,
} from "@/modules/operations/lib/shiphero/attach-faire-slip";

const TERMINAL_STATUSES = new Set([
  "fulfilled",
  "shipped",
  "delivered",
  "canceled",
  "cancelled",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * POST /api/v1/integrations/shiphero/backfill-faire-slips
 *
 * Triggered from an admin button or curl. Runs the same per-order pipeline
 * as scripts/backfill-faire-slips.ts (and the order_allocated webhook
 * handler) over every ShipHero order in a date window. Idempotent — already
 * attached orders short-circuit on the unique partial index.
 *
 * Body (all optional):
 *   {
 *     "sinceDays": 90,            // window size, default 90
 *     "since": "2025-01-01",      // explicit ISO start, overrides sinceDays
 *     "until": "2025-05-01",      // explicit ISO end (default: now)
 *     "unfulfilledOnly": true,    // skip shipped/delivered/canceled
 *     "dryRun": false             // count + list orders without API calls
 *   }
 *
 * Returns: { ok, window, totals: { ... }, orders: [{ orderNumber, status, message }] }.
 */
export async function POST(req: NextRequest) {
  let body: {
    sinceDays?: number;
    since?: string;
    until?: string;
    unfulfilledOnly?: boolean;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — use defaults.
  }

  const sinceMs = body.since
    ? new Date(body.since).getTime()
    : Date.now() - (body.sinceDays ?? 90) * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const until = body.until ? new Date(body.until).toISOString() : undefined;
  const unfulfilledOnly = body.unfulfilledOnly ?? true;
  const dryRun = body.dryRun ?? false;

  let allOrders: Awaited<ReturnType<typeof getOrders>>;
  try {
    allOrders = await getOrders({ updatedFrom: since, updatedTo: until });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `getOrders failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  const filtered = unfulfilledOnly
    ? allOrders.filter(
        (o) => !TERMINAL_STATUSES.has(o.fulfillment_status?.toLowerCase() ?? ""),
      )
    : allOrders;

  const totals: Record<AttachStatus, number> = {
    success: 0,
    error: 0,
    skipped_not_faire: 0,
    skipped_no_slip: 0,
    skipped_no_order_id: 0,
  };
  const orderResults: Array<{
    orderNumber: string;
    shipheroOrderId: string;
    fulfillmentStatus: string;
    status: AttachStatus | "dry_run";
    message: string;
  }> = [];

  for (const o of filtered) {
    if (dryRun) {
      orderResults.push({
        orderNumber: o.order_number || "",
        shipheroOrderId: o.id,
        fulfillmentStatus: o.fulfillment_status,
        status: "dry_run",
        message: "would process",
      });
      continue;
    }

    try {
      const result = await attachFairePackingSlipToOrder({
        shipheroOrderId: o.id,
        orderNumber: o.order_number || null,
      });
      totals[result.status]++;
      orderResults.push({
        orderNumber: o.order_number || "",
        shipheroOrderId: o.id,
        fulfillmentStatus: o.fulfillment_status,
        status: result.status,
        message: result.message,
      });
    } catch (e) {
      totals.error++;
      orderResults.push({
        orderNumber: o.order_number || "",
        shipheroOrderId: o.id,
        fulfillmentStatus: o.fulfillment_status,
        status: "error",
        message: `uncaught: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Pacing for ShipHero credit budget + Faire rate limits.
    await sleep(400);
  }

  return NextResponse.json({
    ok: true,
    window: { since, until: until ?? null, unfulfilledOnly, dryRun },
    counts: {
      total: filtered.length,
      pulledFromShipHero: allOrders.length,
      ...totals,
    },
    orders: orderResults,
  });
}
