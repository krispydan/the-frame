/**
 * Handler for ShipHero's "Shipment Update" webhook topic.
 *
 * Mirrors carrier label + tracking events into our local orders table so the
 * Orders page reflects fulfillment without polling ShipHero. The order is
 * matched on either external_id (Shopify order id) or order_number — we try
 * both because ShipHero's payload shape varies by integration source.
 *
 * Idempotency: setting tracking_number / carrier to the same value is a
 * no-op. eventBus.emit("order.shipped") is guarded — only fires when the
 * status transitions from non-shipped to shipped on this update.
 *
 * Per docs/shiphero-webhooks-and-faire-slips.md ordering edge case: if the
 * Shopify→Frame sync hasn't yet inserted the local order row, the UPDATE
 * matches zero rows and we record "no local order" but still return ok.
 */

import { sqlite } from "@/lib/db";
import type { WebhookPayload } from "@/modules/core/lib/webhooks";
import { registerShipHeroTopicHandler } from "./webhook-handlers";
import { eventBus } from "@/modules/core/lib/event-bus";

interface ShipmentUpdateBody {
  order_id?: string;
  order_number?: string;
  partner_order_id?: string;
  tracking_number?: string;
  tracking_url?: string;
  carrier?: string;
  shipping_carrier?: string;
  shipped_at?: string;
  shipping_method?: string;
}

function pickTracking(body: ShipmentUpdateBody): {
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: string | null;
} {
  return {
    trackingNumber: body.tracking_number ?? null,
    carrier: body.carrier ?? body.shipping_carrier ?? null,
    shippedAt: body.shipped_at ?? new Date().toISOString(),
  };
}

async function handleShipmentUpdate(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const body = payload.parsedBody as ShipmentUpdateBody | null;
  if (!body) return { ok: true, message: "Empty body" };

  const orderNumber = (body.order_number || body.partner_order_id || "").replace(/^#/, "").trim();
  const shipheroOrderId = body.order_id || null;

  if (!orderNumber && !shipheroOrderId) {
    return { ok: true, message: "No order identifier in payload" };
  }

  const { trackingNumber, carrier, shippedAt } = pickTracking(body);

  // Find the local row first so we know whether the status was already
  // 'shipped' (to gate the event emit). Match by external_id (Shopify order
  // id propagates as ShipHero's partner_order_id), order_number, or
  // shiphero_order_id as a last resort.
  const row = sqlite
    .prepare(
      `SELECT id, status, tracking_number, company_id, total
       FROM orders
       WHERE (order_number = ? OR external_id = ? OR shiphero_order_id = ?)
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(orderNumber, orderNumber, shipheroOrderId) as
    | { id: string; status: string; tracking_number: string | null; company_id: string | null; total: number }
    | undefined;

  if (!row) {
    return {
      ok: true,
      message: `No local order matched (order_number=${orderNumber}, shiphero_id=${shipheroOrderId})`,
    };
  }

  const wasShipped = row.status === "shipped" || row.status === "delivered";

  // Build a partial UPDATE so we don't overwrite columns we don't have data for.
  const sets: string[] = ["status = ?", "updated_at = datetime('now')"];
  const vals: Array<string | number | null> = ["shipped"];
  if (trackingNumber) {
    sets.push("tracking_number = ?");
    vals.push(trackingNumber);
  }
  if (carrier) {
    sets.push("tracking_carrier = ?");
    vals.push(carrier);
  }
  if (shippedAt) {
    sets.push("shipped_at = ?");
    vals.push(shippedAt);
  }
  if (shipheroOrderId) {
    sets.push("shiphero_order_id = COALESCE(shiphero_order_id, ?)");
    vals.push(shipheroOrderId);
  }
  vals.push(row.id);

  sqlite.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  // Emit only on the non-shipped → shipped transition. Side effects gated:
  //   1. eventBus "order.shipped" (downstream listeners — Slack digest etc.)
  //   2. Slack "📦 order fulfilled" alert posted via the shared notifier.
  //   3. Mark the order shipped in Faire (US only) or post a manual-ship
  //      alert (non-US). Mirrors what Shopify ships do at the destination.
  if (!wasShipped) {
    try {
      eventBus.emit("order.shipped", {
        orderId: row.id,
        trackingNumber: trackingNumber || undefined,
        carrier: carrier || undefined,
      });
    } catch (e) {
      console.error("[shiphero/shipment-update] eventBus emit failed:", e);
    }
    void (async () => {
      const { notifyOrderShippedById } = await import("@/modules/orders/lib/notify-fulfilled");
      await notifyOrderShippedById({
        orderId: row.id,
        trackingNumber,
        trackingCarrier: carrier,
        trackingUrl: body.tracking_url ?? null,
        shipheroOrderId,
      });
    })();
    void (async () => {
      const { markFaireShippedIfApplicable } = await import("./mark-faire-shipped");
      await markFaireShippedIfApplicable({
        localOrderId: row.id,
        orderNumber: orderNumber || (row as unknown as { order_number: string }).order_number || null,
        trackingNumber,
        carrier,
      });
    })();
  }

  return {
    ok: true,
    message: wasShipped
      ? `Tracking updated (already shipped) for ${row.id}`
      : `Marked shipped: ${row.id}`,
  };
}

registerShipHeroTopicHandler("Shipment Update", handleShipmentUpdate);
