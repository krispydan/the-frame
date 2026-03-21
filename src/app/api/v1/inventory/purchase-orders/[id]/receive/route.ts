export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * POST /api/v1/inventory/purchase-orders/[id]/receive
 * Receive items against a PO (partial or full).
 * Body: { items: [{ lineItemId, receivedQty }] }
 *
 * Creates inventory_movements for each received item,
 * updates inventory quantities, and updates PO status.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { items } = body as {
      items: { lineItemId: string; receivedQty: number }[];
    };

    if (!items?.length) {
      return NextResponse.json(
        { error: "items array required" },
        { status: 400 }
      );
    }

    // Verify PO exists and is in a receivable state
    const po = db.get(sql`
      SELECT id, status FROM inventory_purchase_orders WHERE id = ${id}
    `) as { id: string; status: string } | undefined;

    if (!po) {
      return NextResponse.json({ error: "PO not found" }, { status: 404 });
    }

    const receivableStatuses = [
      "submitted",
      "confirmed",
      "in_production",
      "shipped",
      "in_transit",
      "received",
    ];
    if (!receivableStatuses.includes(po.status)) {
      return NextResponse.json(
        { error: `Cannot receive against PO in ${po.status} status` },
        { status: 400 }
      );
    }

    const { sqlite } = await import("@/lib/db");

    // Process in a transaction
    const receiveItems = sqlite.transaction(() => {
      const today = new Date().toISOString().split("T")[0];

      for (const item of items) {
        if (item.receivedQty <= 0) continue;

        // Get line item details
        const lineItem = sqlite
          .prepare(
            `SELECT sku_id, quantity FROM inventory_po_line_items WHERE id = ? AND po_id = ?`
          )
          .get(item.lineItemId, id) as
          | { sku_id: string; quantity: number }
          | undefined;

        if (!lineItem) continue;

        // Create inventory movement
        sqlite
          .prepare(
            `INSERT INTO inventory_movements (id, sku_id, from_location, to_location, quantity, reason, reference_id, created_at)
             VALUES (?, ?, 'in_transit', 'warehouse', ?, 'purchase', ?, datetime('now'))`
          )
          .run(
            crypto.randomUUID(),
            lineItem.sku_id,
            item.receivedQty,
            id
          );

        // Update inventory — upsert warehouse quantity
        const existing = sqlite
          .prepare(
            `SELECT id, quantity FROM inventory WHERE sku_id = ? AND location = 'warehouse'`
          )
          .get(lineItem.sku_id) as
          | { id: string; quantity: number }
          | undefined;

        if (existing) {
          sqlite
            .prepare(
              `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`
            )
            .run(item.receivedQty, existing.id);
        } else {
          sqlite
            .prepare(
              `INSERT INTO inventory (id, sku_id, location, quantity, updated_at)
               VALUES (?, ?, 'warehouse', ?, datetime('now'))`
            )
            .run(crypto.randomUUID(), lineItem.sku_id, item.receivedQty);
        }
      }

      // Check if all line items are fully received
      const lineItems = sqlite
        .prepare(`SELECT id, sku_id, quantity FROM inventory_po_line_items WHERE po_id = ?`)
        .all(id) as { id: string; sku_id: string; quantity: number }[];

      let allReceived = true;
      let anyReceived = false;

      for (const li of lineItems) {
        // Sum all movements for this SKU against this PO
        const received = sqlite
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) as total
             FROM inventory_movements
             WHERE sku_id = ? AND reference_id = ? AND reason = 'purchase'`
          )
          .get(li.sku_id, id) as { total: number };

        if (received.total > 0) anyReceived = true;
        if (received.total < li.quantity) allReceived = false;
      }

      // Update PO status
      let newStatus = po.status;
      if (allReceived) {
        newStatus = "received";
        sqlite
          .prepare(
            `UPDATE inventory_purchase_orders SET status = 'received', actual_arrival_date = ? WHERE id = ?`
          )
          .run(today, id);
      } else if (anyReceived && po.status !== "received") {
        // Keep existing status but we track partial receipt via movements
        // Optionally move to in_transit if still in earlier states
        if (
          ["submitted", "confirmed", "in_production"].includes(po.status)
        ) {
          newStatus = "in_transit";
          sqlite
            .prepare(
              `UPDATE inventory_purchase_orders SET status = 'in_transit' WHERE id = ?`
            )
            .run(id);
        }
      }

      return { newStatus, allReceived };
    });

    const result = receiveItems();

    return NextResponse.json({
      ok: true,
      status: result.newStatus,
      fullyReceived: result.allReceived,
    });
  } catch (error) {
    console.error("PO receive error:", error);
    return NextResponse.json(
      { error: "Failed to receive items" },
      { status: 500 }
    );
  }
}
