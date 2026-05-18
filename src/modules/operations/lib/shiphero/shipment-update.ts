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
import { logOrderActivity } from "@/modules/orders/lib/activity-log";

interface ShipmentUpdateFields {
  order_id?: string;
  shiphero_id?: number | string;
  order_number?: string;
  partner_order_id?: string;
  tracking_number?: string;
  tracking_url?: string;
  carrier?: string;
  shipping_carrier?: string;
  shipping_name?: string;
  shipped_at?: string;
  shipping_method?: string;
}

interface ShipmentUpdateBody extends ShipmentUpdateFields {
  /** ShipHero nests the actual payload under `fulfillment` on Shipment
   *  Update events. Older / other event shapes put fields at the root. */
  fulfillment?: ShipmentUpdateFields;
}

/**
 * Flatten ShipHero's Shipment Update payload. The webhook delivers the
 * useful fields under a `fulfillment` key (confirmed via captured prod
 * payloads), but other ShipHero event shapes put them at the root. We
 * prefer the nested fields when present, falling back to the root.
 */
function flattenPayload(body: ShipmentUpdateBody): ShipmentUpdateFields {
  const f = body.fulfillment ?? {};
  return {
    order_id: f.order_id ?? body.order_id,
    shiphero_id: f.shiphero_id ?? body.shiphero_id,
    order_number: f.order_number ?? body.order_number,
    partner_order_id: f.partner_order_id ?? body.partner_order_id,
    tracking_number: f.tracking_number ?? body.tracking_number,
    tracking_url: f.tracking_url ?? body.tracking_url,
    carrier: f.carrier ?? body.carrier,
    shipping_carrier: f.shipping_carrier ?? body.shipping_carrier,
    shipping_name: f.shipping_name ?? body.shipping_name,
    shipped_at: f.shipped_at ?? body.shipped_at,
    shipping_method: f.shipping_method ?? body.shipping_method,
  };
}

function pickTracking(fields: ShipmentUpdateFields): {
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: string | null;
} {
  return {
    trackingNumber: fields.tracking_number ?? null,
    // ShipHero uses `shipping_name` for the carrier name in some events
    // (e.g. "UPS Ground"); accept whichever variant fires.
    carrier:
      fields.carrier ??
      fields.shipping_carrier ??
      fields.shipping_name ??
      null,
    shippedAt: fields.shipped_at ?? new Date().toISOString(),
  };
}

async function handleShipmentUpdate(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const rawBody = payload.parsedBody as ShipmentUpdateBody | null;
  if (!rawBody) return { ok: true, message: "Empty body" };
  const body = flattenPayload(rawBody);

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

  // Order activity timeline — record every Shipment Update we apply,
  // including duplicates (so ops can see ShipHero re-deliveries). The
  // "wasShipped" branching below decides whether to fire side effects,
  // but the audit row goes in either way.
  logOrderActivity({
    orderId: row.id,
    eventType: wasShipped
      ? "shiphero.shipment_update.duplicate"
      : "shiphero.shipment_update.shipped",
    data: {
      shipheroOrderId: shipheroOrderId,
      trackingNumber: trackingNumber,
      trackingCarrier: carrier,
      trackingUrl: body.tracking_url ?? null,
      shippedAt,
    },
  });

  // One-shot side effects — gated on the non-shipped → shipped
  // transition so they fire exactly once even though the SAME physical
  // shipment also reaches us via the Shopify fulfillments/create webhook
  // (ShipHero → Shopify channel). Whichever handler flips the local
  // status first wins; the other sees wasShipped and skips these:
  //   1. eventBus "order.shipped" (downstream listeners — digests etc.)
  //   2. Slack "📦 order fulfilled" alert via the shared notifier.
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
  }

  // Faire ship-mark runs on EVERY Shipment Update, regardless of the
  // local transition gate. This is deliberate: the Shopify
  // fulfillments/create webhook can win the race and flip the local
  // status to 'shipped' first — if the Faire mark were gated on
  // !wasShipped, that race would silently skip marking the order in
  // Faire. markFaireShippedIfApplicable is fully idempotent on its own
  // (unique success row in faire_shipment_marks + Faire-state check +
  // already-marked short-circuit), so running it on duplicates is a
  // cheap no-op rather than a double-post. This is also the ONLY path
  // that talks to Faire — the Shopify webhook handler never does.
  void (async () => {
    const { markFaireShippedIfApplicable } = await import("./mark-faire-shipped");
    await markFaireShippedIfApplicable({
      localOrderId: row.id,
      orderNumber: orderNumber || (row as unknown as { order_number: string }).order_number || null,
      trackingNumber,
      carrier,
    });
  })();

  return {
    ok: true,
    message: wasShipped
      ? `Tracking updated (already shipped) for ${row.id}`
      : `Marked shipped: ${row.id}`,
  };
}

registerShipHeroTopicHandler("Shipment Update", handleShipmentUpdate);
