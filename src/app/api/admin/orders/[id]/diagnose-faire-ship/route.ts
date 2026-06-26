export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/orders/[id]/diagnose-faire-ship
 *
 * One-shot diagnostic for "this order shipped but Faire wasn't notified."
 * Returns the local order row + every related ShipHero webhook event and
 * Faire ship-mark log row, so you can see in one response WHY Faire never
 * got the ship notification.
 *
 * No SSH, no CLI — just curl with x-admin-key.
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const order = sqlite
    .prepare(
      `SELECT id, order_number, external_id, channel, status,
              shiphero_fulfillment_status, shiphero_order_id,
              tracking_number, tracking_carrier, shipped_at,
              ship_to_name, placed_at, total
         FROM orders WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!order) {
    return NextResponse.json({ error: `Order ${id} not found` }, { status: 404 });
  }

  const orderNumber = (order.order_number as string) || "";
  const orderNumberStripped = orderNumber.replace(/^#/, "");

  // 1. Faire ship-mark audit log for this order_number. This is the
  // authoritative table — if a row exists, the mark function ran and
  // logged its outcome.
  const faireMarks = sqlite
    .prepare(
      `SELECT id, faire_order_id, order_number, country_code, carrier,
              tracking_code, status, response_status,
              substr(COALESCE(response_body, ''), 1, 300) AS response_body_snippet,
              substr(COALESCE(error_message, ''), 1, 300) AS error_message_snippet,
              marked_at
         FROM faire_shipment_marks
        WHERE order_number = ? OR order_number = ?
        ORDER BY marked_at DESC`,
    )
    .all(orderNumber, orderNumberStripped) as Array<Record<string, unknown>>;

  // 2. ShipHero webhook events that might reference this order. We search
  // by external_id (where the matcher puts the order #) plus a substring
  // search in raw_body as a catch-all.
  const webhookEvents = sqlite
    .prepare(
      `SELECT id, topic, hmac_valid, handler_status,
              substr(COALESCE(handler_message, ''), 1, 200) AS handler_message,
              external_id, received_at
         FROM shiphero_webhook_events
        WHERE external_id = ?
           OR external_id = ?
           OR raw_body LIKE ?
        ORDER BY received_at DESC
        LIMIT 20`,
    )
    .all(orderNumber, orderNumberStripped, `%${orderNumberStripped}%`) as Array<
    Record<string, unknown>
  >;

  // 3. Order activity timeline (if it exists for this order)
  let activity: Array<Record<string, unknown>> = [];
  try {
    activity = sqlite
      .prepare(
        `SELECT event_type, substr(COALESCE(data, ''), 1, 300) AS data, created_at
           FROM activity_feed
          WHERE entity_type = 'order' AND entity_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
      )
      .all(id) as Array<Record<string, unknown>>;
  } catch {
    // Table might be named differently in older deploys — non-fatal.
  }

  // Diagnostic summary — derives the most likely root cause from the
  // data we just pulled.
  const summary: string[] = [];
  if (faireMarks.length === 0) {
    summary.push(
      "No row in faire_shipment_marks — the mark function NEVER attempted this order. " +
        "Either the ShipHero Shipment Update webhook didn't arrive, didn't pass HMAC, " +
        "didn't match the local order, or the order's channel isn't faire/shopify_wholesale.",
    );
  } else {
    const latest = faireMarks[0];
    summary.push(
      `Latest mark attempt: status="${latest.status}" at ${latest.marked_at}` +
        (latest.error_message_snippet
          ? ` — error: ${latest.error_message_snippet}`
          : ""),
    );
  }
  if (webhookEvents.length === 0) {
    summary.push(
      "No matching webhook events found. Either the webhook didn't fire, didn't include " +
        "this order_number in external_id or raw_body, or the search missed it.",
    );
  } else {
    const shipUpdates = webhookEvents.filter((e) =>
      String(e.topic || "").toLowerCase().includes("ship"),
    );
    if (shipUpdates.length === 0) {
      summary.push(
        `Saw ${webhookEvents.length} webhook(s) but NO "Shipment Update" — only allocation events. ` +
          "ShipHero may not have fired the Ship event yet.",
      );
    }
    const hmacFails = webhookEvents.filter((e) => e.hmac_valid === 0);
    if (hmacFails.length > 0) {
      summary.push(
        `${hmacFails.length} of ${webhookEvents.length} webhooks FAILED HMAC validation — ` +
          "the handler never ran for those. Likely consequence of stale shared_secret in " +
          "shiphero_webhook_subscriptions.",
      );
    }
  }

  return NextResponse.json({
    order,
    faireMarks,
    webhookEvents,
    activity,
    summary,
  });
}
