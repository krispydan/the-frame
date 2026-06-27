export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    const rows = db.all(sql`
      SELECT
        po.id,
        po.po_number,
        po.factory_id,
        po.status,
        po.total_units,
        po.total_cost,
        po.order_date,
        po.expected_ship_date,
        po.expected_arrival_date,
        po.actual_arrival_date,
        po.tracking_number,
        po.tracking_carrier,
        po.shipping_cost,
        po.duties_cost,
        po.freight_cost,
        po.notes,
        po.created_at,
        f.code as factory_code,
        f.name as factory_name,
        f.contact_name,
        f.contact_email,
        f.contact_phone,
        f.production_lead_days,
        f.transit_lead_days
      FROM inventory_purchase_orders po
      JOIN inventory_factories f ON po.factory_id = f.id
      ORDER BY po.created_at DESC
    `);

    return NextResponse.json({ purchaseOrders: rows });
  } catch (error) {
    console.error("PO list error:", error);
    return NextResponse.json({ error: "Failed to fetch POs" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      factoryId, lineItems, notes,
      shippingMethod = null,   // "air" | "ocean" | null
      freightCost = 0,         // PO-header total, allocated across lines at receipt
      dutiesCost = 0,          // PO-header total
      shippingCost = 0,        // optional extra (drayage etc.)
    } = body;

    if (!factoryId || !lineItems?.length) {
      return NextResponse.json({ error: "factoryId and lineItems required" }, { status: 400 });
    }

    // Generate PO number
    const lastPo = db.get(sql`
      SELECT po_number FROM inventory_purchase_orders
      ORDER BY po_number DESC LIMIT 1
    `) as { po_number: string } | undefined;

    let nextNum = 1;
    if (lastPo) {
      const match = lastPo.po_number.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const poNumber = `PO-2026-${String(nextNum).padStart(3, "0")}`;

    const poId = crypto.randomUUID();
    let totalUnits = 0;  // true individual units (qty × packSize)
    let totalCost = 0;   // product cost only (freight/duty are PO-header totals)

    for (const item of lineItems) {
      const packSize = item.packSize && item.packSize > 0 ? item.packSize : 1;
      const units = item.quantity * packSize;
      totalUnits += units;
      totalCost += units * item.unitCost; // unitCost is per individual unit
    }

    // Insert PO (freight/duty/shipping captured as header totals — allocated
    // across line items into FIFO cost layers when the PO is received)
    db.run(sql`
      INSERT INTO inventory_purchase_orders
        (id, po_number, factory_id, status, total_units, total_cost, order_date, notes,
         shipping_method, freight_cost, duties_cost, shipping_cost)
      VALUES (${poId}, ${poNumber}, ${factoryId}, 'draft', ${totalUnits}, ${totalCost},
              ${new Date().toISOString().split("T")[0]}, ${notes || null},
              ${shippingMethod}, ${freightCost || 0}, ${dutiesCost || 0}, ${shippingCost || 0})
    `);

    // Insert line items (quantity as entered + packSize so units = qty × packSize)
    for (const item of lineItems) {
      const packSize = item.packSize && item.packSize > 0 ? item.packSize : 1;
      const units = item.quantity * packSize;
      db.run(sql`
        INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, pack_size, unit_cost, total_cost)
        VALUES (${crypto.randomUUID()}, ${poId}, ${item.skuId}, ${item.quantity}, ${packSize}, ${item.unitCost}, ${units * item.unitCost})
      `);
    }

    return NextResponse.json({ id: poId, poNumber }, { status: 201 });
  } catch (error) {
    console.error("PO create error:", error);
    return NextResponse.json({ error: "Failed to create PO" }, { status: 500 });
  }
}
