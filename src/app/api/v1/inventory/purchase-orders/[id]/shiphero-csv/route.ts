export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/v1/inventory/purchase-orders/[id]/shiphero-csv
 *
 * Download the PO as a ShipHero purchase-order upload CSV (matches ShipHero's
 * sample_purchase_order_upload_v3 template — one row per line item with the
 * header fields repeated). Upload it in ShipHero under Purchase Orders →
 * Import so the 3PL can receive against the same PO.
 *
 * Field conventions (established workflow):
 *   Vendor = factory code (JX2…), Status = pending, Sell Ahead = 1,
 *   Payment Due By = unlimited, Price = unit product cost (FOB),
 *   Shipping Carrier/Method + Tracking from the PO record.
 */

const HEADER = [
  "PO Number", "Vendor", "Ship Date", "PO Date", "Status",
  "Shipping Carrier", "Shipping Method", "Shipping Price", "Discount", "Tax",
  "Tracking Number", "Payment Method", "Payment Due By", "PO Note", "Packer Note",
  "Sku", "Vendor Sku", "Quantity", "Sell Ahead", "Price",
];

const csvEscape = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const po = db.get(sql`
      SELECT po.*, f.code AS factory_code, f.name AS factory_name
      FROM inventory_purchase_orders po
      JOIN inventory_factories f ON po.factory_id = f.id
      WHERE po.id = ${id}
    `) as Record<string, string | number | null> | undefined;
    if (!po) return NextResponse.json({ error: "PO not found" }, { status: 404 });

    const lines = db.all(sql`
      SELECT s.sku, li.quantity, li.unit_cost
      FROM inventory_po_line_items li
      JOIN catalog_skus s ON s.id = li.sku_id
      WHERE li.po_id = ${id}
      ORDER BY s.sku
    `) as Array<{ sku: string; quantity: number; unit_cost: number }>;
    if (lines.length === 0) {
      return NextResponse.json({ error: "PO has no line items" }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const shipDate = (po.expected_ship_date as string) || (po.order_date as string) || today;
    const poDate = (po.order_date as string) || today;
    // Carrier/method: prefer the tracked carrier (e.g. DHL); fall back to the
    // shipping_method (air/ocean) so the receiver still sees how it's coming.
    const carrier = (po.tracking_carrier as string) || "";
    const method = (po.tracking_carrier as string)
      || ((po.shipping_method as string) === "air" ? "DHL" : (po.shipping_method as string) || "");

    const common = [
      po.po_number, po.factory_code || po.factory_name, shipDate, poDate, "pending",
      carrier, method, 0, 0, 0,
      po.tracking_number || "", "", "unlimited", "", "",
    ];
    const rows = lines.map((l) =>
      [...common, l.sku, "", l.quantity, 1, l.unit_cost].map(csvEscape).join(","),
    );
    const csv = [HEADER.join(","), ...rows].join("\n") + "\n";

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="shiphero_po_${po.po_number}.csv"`,
      },
    });
  } catch (e) {
    console.error("[shiphero-csv] failed:", e);
    return NextResponse.json({ error: "Failed to generate ShipHero CSV" }, { status: 500 });
  }
}
