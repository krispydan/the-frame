/**
 * ShipHero order sync — matches ShipHero orders to local orders via partner_order_id,
 * stores fulfillment status and shipment details (supports partial fulfillments).
 *
 * Also acts as the safety net for Faire's "mark shipped" notification: when an
 * order transitions to fulfilled on this poll (and the ShipHero "Shipment
 * Update" webhook didn't arrive for any reason), the Faire ship-mark fires
 * here too. The mark function is idempotent — if the webhook already handled
 * it, this no-ops at the audit-log layer.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md, and order #XJDXF2SACA on
 * 2026-06-22 which is the canonical case study for this gap.
 */

import { sqlite } from "@/lib/db";
import { getOrders, isConfigured } from "./api-client";
import type { ShipHeroOrder } from "./api-client";
import { markFaireShippedIfApplicable } from "./mark-faire-shipped";

export interface OrderSyncResult {
  success: boolean;
  ordersMatched: number;
  shipmentsUpserted: number;
  ordersSkipped: number;
  syncedAt: string;
  error?: string;
}

/**
 * Pull all orders from ShipHero and match to local orders via partner_order_id → external_id.
 * Updates ShipHero metadata on orders and upserts shipment records.
 */
export async function syncShipHeroOrders(): Promise<OrderSyncResult> {
  if (!isConfigured()) {
    return { success: false, ordersMatched: 0, shipmentsUpserted: 0, ordersSkipped: 0, syncedAt: new Date().toISOString(), error: "SHIPHERO_ACCESS_TOKEN not set" };
  }

  const syncedAt = new Date().toISOString();

  try {
    const shOrders = await getOrders();

    // Build a map of external_id → local order snapshot for matching.
    // We snapshot channel + prior fulfillment status so we can detect the
    // "just shipped" transition below and trigger the Faire mark.
    const localOrders = sqlite.prepare(
      `SELECT id, external_id, channel, shiphero_fulfillment_status
         FROM orders
        WHERE external_id IS NOT NULL`,
    ).all() as Array<{
      id: string;
      external_id: string;
      channel: string | null;
      shiphero_fulfillment_status: string | null;
    }>;

    const externalIdToLocal = new Map<string, (typeof localOrders)[number]>();
    for (const row of localOrders) {
      externalIdToLocal.set(row.external_id, row);
    }

    const updateOrder = sqlite.prepare(`
      UPDATE orders SET
        shiphero_order_id = ?,
        shiphero_order_number = ?,
        shiphero_fulfillment_status = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const upsertShipment = sqlite.prepare(`
      INSERT INTO shiphero_shipments (id, order_id, shiphero_shipment_id, shiphero_order_id, carrier, tracking_number, tracking_url, label_cost, status, picked_up, total_packages, created_date, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shiphero_shipment_id) DO UPDATE SET
        carrier = excluded.carrier,
        tracking_number = excluded.tracking_number,
        tracking_url = excluded.tracking_url,
        label_cost = excluded.label_cost,
        status = excluded.status,
        picked_up = excluded.picked_up,
        total_packages = excluded.total_packages,
        synced_at = excluded.synced_at
    `);

    let ordersMatched = 0;
    let shipmentsUpserted = 0;
    let ordersSkipped = 0;

    // Orders that flipped to fulfilled on THIS sync — fire the Faire mark
    // for each after the transaction commits. We collect during the batch
    // and dispatch after so async work doesn't block the SQL transaction.
    type JustShipped = {
      localOrderId: string;
      orderNumber: string | null;
      trackingNumber: string | null;
      carrier: string | null;
    };
    const newlyShipped: JustShipped[] = [];

    const batch = sqlite.transaction(() => {
      for (const shOrder of shOrders) {
        const local = externalIdToLocal.get(shOrder.partner_order_id);
        if (!local) {
          ordersSkipped++;
          continue;
        }

        ordersMatched++;

        // Detect the "just transitioned to fulfilled" event so we can
        // notify Faire below. Webhook-driven flow is the fast path; this
        // is the safety net for when "Shipment Update" never arrives.
        const wasFulfilled = local.shiphero_fulfillment_status === "fulfilled";
        const nowFulfilled = shOrder.fulfillment_status === "fulfilled";
        const justShipped = !wasFulfilled && nowFulfilled;
        const isFaireChannel =
          local.channel === "faire" || local.channel === "shopify_wholesale";
        if (justShipped && isFaireChannel) {
          // Pull tracking from the first labelled shipment — same
          // selection the webhook handler uses.
          const primaryLabel = shOrder.shipments
            .flatMap((s) => s.shipping_labels ?? [])
            .find((l) => l?.tracking_number);
          newlyShipped.push({
            localOrderId: local.id,
            orderNumber: shOrder.order_number || null,
            trackingNumber: primaryLabel?.tracking_number ?? null,
            carrier: primaryLabel?.carrier ?? null,
          });
        }

        // Update order with ShipHero metadata
        updateOrder.run(
          shOrder.id,
          shOrder.order_number,
          shOrder.fulfillment_status,
          syncedAt,
          local.id,
        );

        // Upsert each shipment (supports partial fulfillments)
        for (const shipment of shOrder.shipments) {
          // A shipment can have multiple labels; take the primary one
          const label = shipment.shipping_labels?.[0];
          const labelCost = label?.cost ? parseFloat(label.cost) : null;

          upsertShipment.run(
            crypto.randomUUID(),
            local.id,
            shipment.id,
            shOrder.id,
            label?.carrier ?? null,
            label?.tracking_number ?? null,
            label?.tracking_url ?? null,
            labelCost,
            label?.status ?? null,
            shipment.picked_up ? 1 : 0,
            shipment.total_packages,
            shipment.created_date,
            syncedAt,
          );
          shipmentsUpserted++;
        }
      }
    });

    batch();

    // Dispatch Faire ship-marks for orders that just transitioned to
    // fulfilled. Fire-and-forget — the cron returns its summary
    // immediately; each mark logs to faire_shipment_marks on its own.
    // markFaireShippedIfApplicable is idempotent against existing success
    // rows, so duplicates from a racing webhook are safely no-op'd.
    for (const order of newlyShipped) {
      void (async () => {
        try {
          await markFaireShippedIfApplicable(order);
        } catch (e) {
          // Mark function logs its own errors to faire_shipment_marks;
          // this catch is a backstop for anything that escaped that path.
          console.error(
            `[syncShipHeroOrders] Faire mark threw for ${order.orderNumber}:`,
            e,
          );
        }
      })();
    }

    return {
      success: true,
      ordersMatched,
      shipmentsUpserted,
      ordersSkipped,
      syncedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, ordersMatched: 0, shipmentsUpserted: 0, ordersSkipped: 0, syncedAt, error: message };
  }
}
