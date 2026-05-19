/**
 * Helpers for recording integration activity on an order's timeline.
 *
 * The order detail page reads from `activity_feed` keyed on entity_id =
 * orders.id. The strongly-typed `eventBus.emit()` path is reserved for
 * domain events (order.shipped, deal.won, etc.) — for the bespoke
 * ShipHero / Faire integration events we want fine-grained, non-typed
 * entries on the timeline ("Faire packing slip attached", "non-US Faire
 * order needs manual ship-mark", etc.), so we write to the table
 * directly.
 *
 * The same field shape eventBus uses (event_type, module, entity_type,
 * entity_id, data, user_id, created_at) keeps the read path on
 * /orders/[id] unchanged.
 */

import { sqlite } from "@/lib/db";

/**
 * Look up our local `orders.id` from any signal a webhook handler has
 * available: the Shopify-side order_number (e.g. "#PEDBEMP4XK"), the
 * Shopify external_id (numeric Shopify order id), or the ShipHero
 * order_id (base64 GraphQL id we've recorded on the row).
 *
 * Returns null when no row matches — useful for the
 * Order-Allocated-before-Shopify-sync race documented in
 * docs/shiphero-webhooks-and-faire-slips.md.
 */
export function findLocalOrderIdByShipHeroSignals(opts: {
  orderNumber?: string | number | null;
  externalId?: string | number | null;
  shipheroOrderId?: string | number | null;
}): string | null {
  // ShipHero sends ids as numbers in some payload shapes (e.g.
  // order_id: 815262993, shiphero_id: 807574618.0). Coerce to string
  // before any .replace()/.trim() — passing a number used to throw
  // "e.shipheroOrderId?.trim is not a function" and abort the handler.
  const s = (v: string | number | null | undefined): string | null => {
    if (v == null) return null;
    const str = String(v).trim();
    return str || null;
  };
  const orderNumber = s(opts.orderNumber)?.replace(/^#/, "").trim() || null;
  const orderNumberHashed = orderNumber ? `#${orderNumber}` : null;
  const externalId = s(opts.externalId);
  const shipheroOrderId = s(opts.shipheroOrderId);

  // Try the most-specific signal first. shiphero_order_id is unique once
  // we've recorded it; order_number is also unique within a shop;
  // external_id is the Shopify order id.
  if (shipheroOrderId) {
    const row = sqlite
      .prepare(`SELECT id FROM orders WHERE shiphero_order_id = ? LIMIT 1`)
      .get(shipheroOrderId) as { id: string } | undefined;
    if (row) return row.id;
  }
  if (externalId) {
    const row = sqlite
      .prepare(`SELECT id FROM orders WHERE external_id = ? LIMIT 1`)
      .get(externalId) as { id: string } | undefined;
    if (row) return row.id;
  }
  if (orderNumber) {
    const row = sqlite
      .prepare(
        `SELECT id FROM orders
         WHERE order_number = ? OR order_number = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(orderNumber, orderNumberHashed) as { id: string } | undefined;
    if (row) return row.id;
  }
  return null;
}

/**
 * Insert a row into activity_feed. Silent on failure (logged to console)
 * — the audit log is best-effort; we never want a feed-insert error to
 * tank the actual integration flow.
 */
export function logOrderActivity(opts: {
  orderId: string | null;
  eventType: string;
  /** Module bucket — defaults to "operations" since most of these
   *  originate from the ShipHero / Faire integration. */
  module?: string;
  data?: Record<string, unknown>;
}): void {
  if (!opts.orderId) return; // nothing to attach to
  try {
    sqlite
      .prepare(
        `INSERT INTO activity_feed
         (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
         VALUES (?, ?, ?, 'order', ?, ?, NULL, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        opts.eventType,
        opts.module ?? "operations",
        opts.orderId,
        opts.data ? JSON.stringify(opts.data) : null,
      );
  } catch (e) {
    console.error("[order activity-log] insert failed:", e);
  }
}
