export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const po = db.get(sql`
      SELECT
        po.*,
        f.code as factory_code,
        f.name as factory_name,
        f.contact_name,
        f.contact_email,
        f.contact_phone,
        f.production_lead_days,
        f.transit_lead_days
      FROM inventory_purchase_orders po
      JOIN inventory_factories f ON po.factory_id = f.id
      WHERE po.id = ${id}
    `);

    if (!po) {
      return NextResponse.json({ error: "PO not found" }, { status: 404 });
    }

    const lineItems = db.all(sql`
      SELECT
        li.*,
        s.sku,
        s.color_name,
        p.name as product_name
      FROM inventory_po_line_items li
      JOIN catalog_skus s ON li.sku_id = s.id
      JOIN catalog_products p ON s.product_id = p.id
      WHERE li.po_id = ${id}
    `);

    const qcInspections = db.all(sql`
      SELECT * FROM inventory_qc_inspections
      WHERE po_id = ${id}
      ORDER BY created_at DESC
    `);

    return NextResponse.json({ ...po, lineItems, qcInspections });
  } catch (error) {
    console.error("PO detail error:", error);
    return NextResponse.json({ error: "Failed to fetch PO" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { status, trackingNumber, trackingCarrier, notes, shippingCost, dutiesCost, freightCost, actualArrivalDate } = body;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (status) { sets.push("status = ?"); values.push(status); }
    if (trackingNumber !== undefined) { sets.push("tracking_number = ?"); values.push(trackingNumber); }
    if (trackingCarrier !== undefined) { sets.push("tracking_carrier = ?"); values.push(trackingCarrier); }
    if (notes !== undefined) { sets.push("notes = ?"); values.push(notes); }
    if (shippingCost !== undefined) { sets.push("shipping_cost = ?"); values.push(shippingCost); }
    if (dutiesCost !== undefined) { sets.push("duties_cost = ?"); values.push(dutiesCost); }
    if (freightCost !== undefined) { sets.push("freight_cost = ?"); values.push(freightCost); }
    if (actualArrivalDate !== undefined) { sets.push("actual_arrival_date = ?"); values.push(actualArrivalDate); }

    if (sets.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // Use raw sqlite for dynamic updates
    const { sqlite } = await import("@/lib/db");
    sqlite.prepare(`UPDATE inventory_purchase_orders SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PO update error:", error);
    return NextResponse.json({ error: "Failed to update PO" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    db.run(sql`DELETE FROM inventory_purchase_orders WHERE id = ${id} AND status = 'draft'`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PO delete error:", error);
    return NextResponse.json({ error: "Failed to delete PO" }, { status: 500 });
  }
}
