export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { purchaseOrders, purchaseOrderItems } from "@/modules/catalog/schema";
import { desc, eq } from "drizzle-orm";

/** GET /api/v1/operations/purchase-orders — list all POs with line counts */
export async function GET() {
  const pos = await db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt));

  // Line counts per PO
  const lines = await db.select({
    purchaseOrderId: purchaseOrderItems.purchaseOrderId,
    quantity: purchaseOrderItems.quantity,
  }).from(purchaseOrderItems);

  const lineCountByPo = new Map<string, { rows: number; units: number }>();
  for (const l of lines) {
    const prev = lineCountByPo.get(l.purchaseOrderId) ?? { rows: 0, units: 0 };
    prev.rows += 1;
    prev.units += l.quantity;
    lineCountByPo.set(l.purchaseOrderId, prev);
  }

  return NextResponse.json({
    pos: pos.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      vendor: po.factoryCode ?? po.supplier,
      orderDate: po.orderDate,
      shipDate: po.shipDate,
      freightType: po.freightType,
      status: po.status,
      createdAt: po.createdAt,
      rowCount: lineCountByPo.get(po.id)?.rows ?? 0,
      unitCount: lineCountByPo.get(po.id)?.units ?? 0,
    })),
  });
}
