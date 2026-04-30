/**
 * ShipHero order sync — matches ShipHero orders to local orders via partner_order_id,
 * stores fulfillment status and shipment details (supports partial fulfillments).
 */

import { sqlite } from "@/lib/db";
import { getOrders, isConfigured } from "./api-client";
import type { ShipHeroOrder } from "./api-client";

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

    // Build a map of external_id → local order id for matching
    const localOrders = sqlite.prepare(
      "SELECT id, external_id FROM orders WHERE external_id IS NOT NULL"
    ).all() as Array<{ id: string; external_id: string }>;

    const externalIdToLocalId = new Map<string, string>();
    for (const row of localOrders) {
      externalIdToLocalId.set(row.external_id, row.id);
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

    const batch = sqlite.transaction(() => {
      for (const shOrder of shOrders) {
        const localOrderId = externalIdToLocalId.get(shOrder.partner_order_id);
        if (!localOrderId) {
          ordersSkipped++;
          continue;
        }

        ordersMatched++;

        // Update order with ShipHero metadata
        updateOrder.run(
          shOrder.id,
          shOrder.order_number,
          shOrder.fulfillment_status,
          syncedAt,
          localOrderId,
        );

        // Upsert each shipment (supports partial fulfillments)
        for (const shipment of shOrder.shipments) {
          // A shipment can have multiple labels; take the primary one
          const label = shipment.shipping_labels?.[0];
          const labelCost = label?.cost ? parseFloat(label.cost) : null;

          upsertShipment.run(
            crypto.randomUUID(),
            localOrderId,
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

    return { success: true, ordersMatched, shipmentsUpserted, ordersSkipped, syncedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, ordersMatched: 0, shipmentsUpserted: 0, ordersSkipped: 0, syncedAt, error: message };
  }
}
