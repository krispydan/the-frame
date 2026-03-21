export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { returns } from "@/modules/orders/schema";
import { activityFeed } from "@/modules/core/schema";
import { eq } from "drizzle-orm";

// PATCH /api/v1/orders/:id/returns/:returnId — update return status
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; returnId: string }> }) {
  const { id, returnId } = await params;
  const body = await req.json();

  const ret = db.select().from(returns).where(eq(returns.id, returnId)).get();
  if (!ret || ret.orderId !== id) return NextResponse.json({ error: "Return not found" }, { status: 404 });

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.status) updates.status = body.status;
  if (body.refundAmount !== undefined) updates.refundAmount = body.refundAmount;
  if (body.notes !== undefined) updates.notes = body.notes;

  db.update(returns).set(updates).where(eq(returns.id, returnId)).run();

  // Log
  db.insert(activityFeed).values({
    eventType: `order.return_${body.status || "updated"}`,
    module: "orders",
    entityType: "order",
    entityId: id,
    data: { returnId, status: body.status } as unknown as Record<string, unknown>,
  }).run();

  return NextResponse.json(db.select().from(returns).where(eq(returns.id, returnId)).get());
}
