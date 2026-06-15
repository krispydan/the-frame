export const dynamic = "force-dynamic";
// Wraps the heavy backfill — up to 5 minutes for a wide window.
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { getOrders } from "@/modules/operations/lib/shiphero/api-client";
import {
  attachFairePackingSlipToOrder,
  type AttachStatus,
} from "@/modules/operations/lib/shiphero/attach-faire-slip";

/**
 * POST /api/admin/shiphero/backfill-faire-slips
 *
 * Admin-key-gated copy of /api/v1/integrations/shiphero/backfill-faire-slips
 * (which sits behind login). Same per-order logic — pulls every ShipHero
 * order in the window, calls attachFairePackingSlipToOrder() for each.
 *
 * Body (all optional):
 *   {
 *     sinceDays?: number,        // default 30
 *     since?: string,            // ISO, overrides sinceDays
 *     until?: string,            // ISO, default now
 *     unfulfilledOnly?: boolean, // default true
 *     dryRun?: boolean,          // default false — count + list, no API calls
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 */
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

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
    // empty body OK
  }

  const sinceMs = body.since
    ? new Date(body.since).getTime()
    : Date.now() - (body.sinceDays ?? 30) * 24 * 60 * 60 * 1000;
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
