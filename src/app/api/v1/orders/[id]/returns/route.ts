export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { orders, orderItems, returns } from "@/modules/orders/schema";
import { changeLogs, activityFeed } from "@/modules/core/schema";
import { eq } from "drizzle-orm";

// POST /api/v1/orders/:id/returns — create return request
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const body = await req.json();
  const { reason, items, refundAmount } = body as {
    reason?: string;
    items?: Array<{ orderItemId: string; quantity: number; reason?: string }>;
    refundAmount?: number;
  };

  // Validate items exist on order
  if (items?.length) {
    const orderItemIds = db.select().from(orderItems).where(eq(orderItems.orderId, id)).all().map((i) => i.id);
    for (const item of items) {
      if (!orderItemIds.includes(item.orderItemId)) {
        return NextResponse.json({ error: `Item ${item.orderItemId} not found on this order` }, { status: 400 });
      }
    }
  }

  const ret = db.insert(returns).values({
    orderId: id,
    reason: reason || null,
    status: "requested",
    items: items || null,
    refundAmount: refundAmount || null,
  }).returning().get();

  // Log activity
  db.insert(activityFeed).values({
    eventType: "order.return_requested",
    module: "orders",
    entityType: "order",
    entityId: id,
    data: { returnId: ret.id, reason, itemCount: items?.length || 0 } as unknown as Record<string, unknown>,
  }).run();

  return NextResponse.json(ret, { status: 201 });
}

// GET /api/v1/orders/:id/returns — list returns for order
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = db.select().from(returns).where(eq(returns.orderId, id)).all();
  return NextResponse.json(data);
}
