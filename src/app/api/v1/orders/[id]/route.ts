export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { orders, orderItems, returns } from "@/modules/orders/schema";
import { companies, contacts } from "@/modules/sales/schema";
import { activityFeed } from "@/modules/core/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq, desc, and } from "drizzle-orm";
import { updateOrderStatus } from "@/modules/orders/lib/fulfillment";

// GET /api/v1/orders/:id — order detail
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const items = db.select().from(orderItems).where(eq(orderItems.orderId, id)).all();
  const orderReturns = db.select().from(returns).where(eq(returns.orderId, id)).all();

  const company = order.companyId
    ? db.select().from(companies).where(eq(companies.id, order.companyId)).get()
    : null;
  const contact = order.contactId
    ? db.select().from(contacts).where(eq(contacts.id, order.contactId)).get()
    : null;

  // Activity timeline
  const timeline = db
    .select()
    .from(activityFeed)
    .where(eq(activityFeed.entityId, id))
    .orderBy(desc(activityFeed.createdAt))
    .all();

  // Build a deep link to the upstream order in its source system.
  // For Shopify channels we resolve the connected shop's domain so the link
  // points at the correct retail or wholesale admin.
  let externalUrl: string | null = null;
  if (order.externalId) {
    if (order.channel === "shopify_dtc" || order.channel === "shopify_wholesale") {
      const channel = order.channel === "shopify_wholesale" ? "wholesale" : "retail";
      const [shop] = await db
        .select()
        .from(shopifyShops)
        .where(and(eq(shopifyShops.channel, channel), eq(shopifyShops.isActive, true)));
      if (shop) {
        externalUrl = `https://${shop.shopDomain}/admin/orders/${order.externalId}`;
      }
    } else if (order.channel === "faire") {
      externalUrl = `https://www.faire.com/brand-portal/orders/${order.externalId}`;
    }
  }

  return NextResponse.json({
    ...order,
    company,
    contact,
    items,
    returns: orderReturns,
    timeline,
    externalUrl,
  });
}

// PATCH /api/v1/orders/:id — update order (uses fulfillment pipeline)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  try {
    if (body.status) {
      const updated = await updateOrderStatus({
        orderId: id,
        newStatus: body.status,
        trackingNumber: body.trackingNumber,
        trackingCarrier: body.trackingCarrier,
        source: "api",
      });
      return NextResponse.json(updated);
    }

    // Non-status updates (notes, etc.)
    const order = db.select().from(orders).where(eq(orders.id, id)).get();
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.notes !== undefined) updates.notes = body.notes;
    db.update(orders).set(updates).where(eq(orders.id, id)).run();

    return NextResponse.json(db.select().from(orders).where(eq(orders.id, id)).get());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
