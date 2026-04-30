export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { orders, orderItems, returns } from "@/modules/orders/schema";
import { companies, contacts } from "@/modules/sales/schema";
import { skus as catalogSkus } from "@/modules/catalog/schema";
import { activityFeed } from "@/modules/core/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq, desc, and, inArray } from "drizzle-orm";
import { updateOrderStatus } from "@/modules/orders/lib/fulfillment";

// GET /api/v1/orders/:id — order detail
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const items = db.select().from(orderItems).where(eq(orderItems.orderId, id)).all();
  const orderReturns = db.select().from(returns).where(eq(returns.orderId, id)).all();

  // Gross profit calculation — pull catalog cost_price for every SKU on the
  // order and attach unitCost / lineCost / lineProfit per item, plus order
  // totals. Items missing a SKU match (e.g. shipping line items) get
  // unitCost: null and don't contribute to profit (treated as missing data,
  // not zero cost).
  const skuStrings = items.map((it) => it.sku).filter((s): s is string => !!s);
  const skuMatches = skuStrings.length
    ? db.select({ sku: catalogSkus.sku, cost: catalogSkus.costPrice }).from(catalogSkus).where(inArray(catalogSkus.sku, skuStrings)).all()
    : [];
  const costBySku = new Map<string, number | null>();
  for (const r of skuMatches) {
    if (r.sku) costBySku.set(r.sku, r.cost ?? null);
  }

  let totalCost = 0;
  let totalCostKnown = true;
  const itemsWithProfit = items.map((it) => {
    const unitCost = it.sku ? costBySku.get(it.sku) ?? null : null;
    if (unitCost == null) totalCostKnown = false;
    const lineCost = unitCost != null ? unitCost * it.quantity : null;
    const lineRevenue = it.unitPrice * it.quantity;
    const lineProfit = lineCost != null ? lineRevenue - lineCost : null;
    if (lineCost != null) totalCost += lineCost;
    return { ...it, unitCost, lineCost, lineProfit };
  });

  const itemsRevenue = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
  const grossProfit = totalCostKnown ? itemsRevenue - totalCost : null;
  const grossMargin = grossProfit != null && itemsRevenue > 0 ? grossProfit / itemsRevenue : null;

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
    items: itemsWithProfit,
    returns: orderReturns,
    timeline,
    externalUrl,
    profit: {
      itemsRevenue,
      totalCost: totalCostKnown ? totalCost : null,
      grossProfit,
      grossMargin,
      hasFullCostData: totalCostKnown,
    },
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
