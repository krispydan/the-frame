export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";

/**
 * POST /api/v1/operations/inventory/shiphero/costs
 *
 * Import ShipHero fulfillment cost CSV.
 * Expects multipart form data with a CSV file.
 *
 * TODO: Implement once we receive the first ShipHero invoice CSV
 * and understand the exact column format. Expected columns:
 *   - Order ID / order number
 *   - Shipping/postage cost
 *   - Fulfillment/processing fee
 *   - Picking fee
 *   - Packaging/materials cost
 *   - Surcharges / oversize fees
 *
 * Each row will be matched to local orders via shiphero_order_id
 * and upserted into the shiphero_order_costs table.
 */
export const POST = apiHandler(
  async (request: NextRequest) => {
    // Placeholder — will parse CSV and upsert into shiphero_order_costs
    return NextResponse.json(
      { error: "Not yet implemented. Upload a ShipHero invoice CSV once available to define the import format." },
      { status: 501 },
    );
  },
  { auth: true, roles: ["owner", "finance"] },
);

/**
 * GET /api/v1/operations/inventory/shiphero/costs?order_id=xxx
 *
 * Retrieve fulfillment costs for a specific order.
 */
export const GET = apiHandler(
  async (request: NextRequest) => {
    const orderId = request.nextUrl.searchParams.get("order_id");

    if (orderId) {
      const costs = sqlite.prepare(
        "SELECT * FROM shiphero_order_costs WHERE order_id = ? ORDER BY invoice_date DESC"
      ).all(orderId);
      return NextResponse.json({ costs });
    }

    // Summary of all costs
    const summary = sqlite.prepare(`
      SELECT
        COUNT(DISTINCT order_id) as orders_with_costs,
        SUM(shipping_rate) as total_shipping,
        SUM(processing_fee) as total_processing,
        SUM(picking_fee) as total_picking,
        SUM(overcharge_fee) as total_overcharges,
        SUM(total_cost) as grand_total,
        MIN(invoice_date) as earliest_invoice,
        MAX(invoice_date) as latest_invoice
      FROM shiphero_order_costs
    `).get();

    return NextResponse.json(summary);
  },
  { auth: true, roles: ["owner", "finance"] },
);
