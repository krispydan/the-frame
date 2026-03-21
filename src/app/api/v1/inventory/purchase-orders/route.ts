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
    const { factoryId, lineItems, notes } = body;

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
    let totalUnits = 0;
    let totalCost = 0;

    for (const item of lineItems) {
      totalUnits += item.quantity;
      totalCost += item.quantity * item.unitCost;
    }

    // Insert PO
    db.run(sql`
      INSERT INTO inventory_purchase_orders (id, po_number, factory_id, status, total_units, total_cost, order_date, notes)
      VALUES (${poId}, ${poNumber}, ${factoryId}, 'draft', ${totalUnits}, ${totalCost}, ${new Date().toISOString().split("T")[0]}, ${notes || null})
    `);

    // Insert line items
    for (const item of lineItems) {
      db.run(sql`
        INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, unit_cost, total_cost)
        VALUES (${crypto.randomUUID()}, ${poId}, ${item.skuId}, ${item.quantity}, ${item.unitCost}, ${item.quantity * item.unitCost})
      `);
    }

    return NextResponse.json({ id: poId, poNumber }, { status: 201 });
  } catch (error) {
    console.error("PO create error:", error);
    return NextResponse.json({ error: "Failed to create PO" }, { status: 500 });
  }
}
