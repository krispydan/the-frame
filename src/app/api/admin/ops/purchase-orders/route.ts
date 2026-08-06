export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";

/**
 * Token-guarded purchase-order overview (x-ops-key: OPS_TOKEN). Read-only.
 *
 * GET /api/admin/ops/purchase-orders
 * Built for cash-flow questions: how much is committed on open POs (product
 * cost + freight/duties/shipping), broken down by status and by PO with
 * expected arrival dates. "Open" = not yet received/complete.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const byStatus = sqlite.prepare(`
    SELECT status, COUNT(*) AS pos, SUM(total_units) AS units,
           ROUND(SUM(total_cost), 2) AS productCost,
           ROUND(SUM(COALESCE(shipping_cost,0) + COALESCE(duties_cost,0) + COALESCE(freight_cost,0)), 2) AS logisticsCost,
           ROUND(SUM(total_cost + COALESCE(shipping_cost,0) + COALESCE(duties_cost,0) + COALESCE(freight_cost,0)), 2) AS totalCost
    FROM inventory_purchase_orders
    GROUP BY status
  `).all();

  const openPos = sqlite.prepare(`
    SELECT po.po_number AS poNumber, f.code AS factory, po.status,
           po.total_units AS units,
           ROUND(po.total_cost, 2) AS productCost,
           ROUND(COALESCE(po.shipping_cost,0) + COALESCE(po.duties_cost,0) + COALESCE(po.freight_cost,0), 2) AS logisticsCost,
           ROUND(po.total_cost + COALESCE(po.shipping_cost,0) + COALESCE(po.duties_cost,0) + COALESCE(po.freight_cost,0), 2) AS totalCost,
           po.shipping_method AS shippingMethod,
           po.order_date AS orderDate,
           po.expected_ship_date AS expectedShipDate,
           po.expected_arrival_date AS expectedArrivalDate
    FROM inventory_purchase_orders po
    JOIN inventory_factories f ON f.id = po.factory_id
    WHERE po.status NOT IN ('received', 'complete')
    ORDER BY COALESCE(po.expected_arrival_date, '9999') ASC
  `).all() as Array<{ totalCost: number }>;

  const openTotal = Math.round(openPos.reduce((s, p) => s + (p.totalCost ?? 0), 0) * 100) / 100;

  return NextResponse.json({
    openTotal,
    openCount: openPos.length,
    byStatus,
    openPos,
    note: "openTotal = product + freight/duties/shipping on POs not yet received/complete. Payment terms (deposits/balances) are not modeled — apply your factory terms to these commitments.",
  });
}
