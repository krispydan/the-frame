export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { orders, orderItems, returns } from "@/modules/orders/schema";
import { companies, contacts, segments } from "@/modules/sales/schema";
import { skus as catalogSkus } from "@/modules/catalog/schema";
import { activityFeed } from "@/modules/core/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq, desc, and, inArray } from "drizzle-orm";
import { updateOrderStatus } from "@/modules/orders/lib/fulfillment";
import { getPipedriveConnectionStatus } from "@/modules/sales/lib/pipedrive-client";

// GET /api/v1/orders/:id — order detail
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const items = db.select().from(orderItems).where(eq(orderItems.orderId, id)).all();
  const orderReturns = db.select().from(returns).where(eq(returns.orderId, id)).all();

  // Gross profit calculation. Line costs come from the FIFO engine FIRST —
  // inventory_cost_depletions records the actual landed cost per order item
  // (the same source as the Costing (FIFO) card), so the items table and the
  // card can never disagree. Catalog cost_price is only the fallback for
  // lines the FIFO engine hasn't costed (pre-FIFO orders, not-yet-run days),
  // marked costSource: "catalog". Items with neither get unitCost: null and
  // don't contribute to profit (missing data, not zero cost).
  const skuStrings = items.map((it) => it.sku).filter((s): s is string => !!s);
  const skuMatches = skuStrings.length
    ? db.select({ sku: catalogSkus.sku, cost: catalogSkus.costPrice }).from(catalogSkus).where(inArray(catalogSkus.sku, skuStrings)).all()
    : [];
  const costBySku = new Map<string, number | null>();
  for (const r of skuMatches) {
    if (r.sku) costBySku.set(r.sku, r.cost ?? null);
  }

  const fifoByItem = new Map(
    (sqlite.prepare(
      `SELECT order_item_id AS itemId, SUM(quantity) AS qty,
              SUM(quantity * landed_cost_per_unit) AS cost
       FROM inventory_cost_depletions
       WHERE order_id = ? AND order_item_id IS NOT NULL
       GROUP BY order_item_id`,
    ).all(id) as Array<{ itemId: string; qty: number; cost: number }>).map((r) => [r.itemId, r]),
  );

  let totalCost = 0;
  let totalCostKnown = true;
  const itemsWithProfit = items.map((it) => {
    const fifo = fifoByItem.get(it.id);
    const catalogCost = it.sku ? costBySku.get(it.sku) ?? null : null;
    let unitCost: number | null;
    let lineCost: number | null;
    let costSource: "fifo" | "catalog" | null;
    if (fifo && fifo.qty > 0 && fifo.qty >= it.quantity) {
      // Fully costed by FIFO — landed cost, the real number.
      lineCost = fifo.cost;
      unitCost = fifo.cost / fifo.qty;
      costSource = "fifo";
    } else if (fifo && fifo.qty > 0 && catalogCost != null) {
      // Partially depleted (e.g. split shipment) — FIFO for the costed units,
      // catalog for the remainder.
      lineCost = fifo.cost + catalogCost * (it.quantity - fifo.qty);
      unitCost = lineCost / it.quantity;
      costSource = "fifo";
    } else if (catalogCost != null) {
      unitCost = catalogCost;
      lineCost = catalogCost * it.quantity;
      costSource = "catalog";
    } else if (fifo && fifo.qty > 0) {
      // FIFO covered some units and there's no catalog fallback for the rest.
      lineCost = null;
      unitCost = fifo.cost / fifo.qty;
      costSource = "fifo";
    } else {
      unitCost = null;
      lineCost = null;
      costSource = null;
    }
    if (lineCost == null) totalCostKnown = false;
    const lineRevenue = it.unitPrice * it.quantity;
    const lineProfit = lineCost != null ? lineRevenue - lineCost : null;
    if (lineCost != null) totalCost += lineCost;
    return { ...it, unitCost, lineCost, lineProfit, costSource };
  });

  // Revenue base for gross profit:
  //   subtotal (post-discount, pre-shipping, pre-tax)
  //
  // Why not items × unitPrice? Because line-item prices are gross-of-discount,
  // so summing them inflates revenue when wholesale/Faire commissions are
  // recorded as a discount on the order. order.subtotal already has the
  // discount applied — so it matches the "Subtotal" row shown in the UI and
  // matches what accountants treat as net revenue.
  //
  // Shipping and tax are excluded — shipping is a pass-through to the
  // carrier (we don't have shipping COGS attached here yet), and tax is
  // collected for the government.
  const itemsRevenue = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
  const revenueBase = order.subtotal ?? itemsRevenue;
  const grossProfit = totalCostKnown ? revenueBase - totalCost : null;
  const grossMargin = grossProfit != null && revenueBase > 0 ? grossProfit / revenueBase : null;

  const company = order.companyId
    ? db.select().from(companies).where(eq(companies.id, order.companyId)).get()
    : null;
  const contact = order.contactId
    ? db.select().from(contacts).where(eq(contacts.id, order.contactId)).get()
    : null;
  const companySegment = company?.segmentId
    ? db.select({ name: segments.name }).from(segments).where(eq(segments.id, company.segmentId)).get()?.name ?? null
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
    } else if (order.channel === "amazon") {
      // external_id is stored prefixed ("amazon:111-…") so it can never
      // collide with a Shopify id in the ShipHero matcher; strip it for the
      // Seller Central URL.
      const amazonOrderId = order.externalId.replace(/^amazon:/, "");
      externalUrl = `https://sellercentral.amazon.com/orders-v3/order/${amazonOrderId}`;
    }
  }

  // ShipHero shipments & costs
  const shipments = sqlite.prepare(
    "SELECT * FROM shiphero_shipments WHERE order_id = ? ORDER BY created_date ASC"
  ).all(id) as Array<Record<string, unknown>>;

  const fulfillmentCosts = sqlite.prepare(
    "SELECT * FROM shiphero_order_costs WHERE order_id = ? ORDER BY invoice_date DESC"
  ).all(id) as Array<Record<string, unknown>>;

  // ShipHero dashboard link
  let shipheroUrl: string | null = null;
  const shipheroOrderId = order.shipheroOrderId;
  if (shipheroOrderId) {
    // ShipHero base64 ID decodes to "Order:12345" — extract the numeric ID
    try {
      const decoded = Buffer.from(shipheroOrderId, "base64").toString("utf-8");
      const numericId = decoded.replace("Order:", "");
      shipheroUrl = `https://app.shiphero.com/dashboard/orders/details/${numericId}`;
    } catch {
      shipheroUrl = null;
    }
  }

  // Pipedrive deep links. These ids live in raw columns (added outside the
  // Drizzle schema), so read them directly. Deal is stamped on the order once
  // the order→deal push runs; org/person on the company.
  const pdIds = sqlite
    .prepare(
      `SELECT o.pipedrive_deal_id, c.pipedrive_org_id, c.pipedrive_person_id
         FROM orders o LEFT JOIN companies c ON c.id = o.company_id WHERE o.id = ?`,
    )
    .get(id) as { pipedrive_deal_id: number | null; pipedrive_org_id: number | null; pipedrive_person_id: number | null } | undefined;
  // 3PL invoice charges (Big Sky) attributed to this order — the ACTUAL
  // fulfillment fee + postage billed, from the imported monthly invoices.
  // Powers the Fulfillment Cost card: shipping margin = what the customer
  // paid for shipping minus real postage + labor.
  const threePlCharges = sqlite.prepare(
    `SELECT charge_type AS chargeType, amount, quantity, occurred_at AS occurredAt,
            carrier, service_level AS serviceLevel, tracking_number AS trackingNumber,
            package_type AS packageType, weight_value AS weightValue, weight_unit AS weightUnit
     FROM three_pl_charges WHERE order_id = ? ORDER BY occurred_at ASC`,
  ).all(id) as Array<{ chargeType: string; amount: number; quantity: number; occurredAt: string | null; carrier: string | null; serviceLevel: string | null; trackingNumber: string | null; packageType: string | null; weightValue: number | null; weightUnit: string | null }>;
  const tplPostage = threePlCharges.filter((c) => c.chargeType.startsWith("shipping_")).reduce((a, c) => a + c.amount, 0);
  const tplFulfillment = threePlCharges.filter((c) => c.chargeType.startsWith("fulfillment_")).reduce((a, c) => a + c.amount, 0);
  const tplOther = threePlCharges.filter((c) => !c.chargeType.startsWith("shipping_") && !c.chargeType.startsWith("fulfillment_")).reduce((a, c) => a + c.amount, 0);
  const threePl = threePlCharges.length
    ? {
        charges: threePlCharges,
        postage: Math.round(tplPostage * 100) / 100,
        fulfillment: Math.round(tplFulfillment * 100) / 100,
        other: Math.round(tplOther * 100) / 100,
        total: Math.round((tplPostage + tplFulfillment + tplOther) * 100) / 100,
        shippingMargin: Math.round(((order.shipping ?? 0) - tplPostage) * 100) / 100,
      }
    : null;

  // No invoice data yet → ESTIMATE from the contract rate card + historical
  // postage medians, so the financials section always has a cost figure.
  // Never blended with actuals: exactly one of threePl / threePlEstimate is
  // non-null (per Daniel, Aug 2026 — "we should never have real and estimated").
  let threePlEstimate: { fulfillment: number; postage: number; total: number; shippingMargin: number } | null = null;
  if (!threePl && order.status !== "cancelled") {
    try {
      const { estimateThreePlCost } = await import("@/modules/finance/lib/order-economics");
      const est = estimateThreePlCost(id, order.channel);
      threePlEstimate = {
        fulfillment: est.fulfillment,
        postage: est.postage,
        total: Math.round((est.fulfillment + est.postage) * 100) / 100,
        shippingMargin: Math.round(((order.shipping ?? 0) - est.postage) * 100) / 100,
      };
    } catch (e) {
      console.error("[orders] 3PL estimate failed:", e);
    }
  }

  // The customer account for this order's company — lets the page link to
  // /customers/[accountId] (the customer show page keys on account id).
  const customerAccountId = order.companyId
    ? ((sqlite.prepare("SELECT id FROM customer_accounts WHERE company_id = ?").get(order.companyId) as { id: string } | undefined)?.id ?? null)
    : null;

  const pdBase = getPipedriveConnectionStatus().apiDomain ?? null;
  const pipedrive = pdBase
    ? {
        apiDomain: pdBase,
        dealUrl: pdIds?.pipedrive_deal_id ? `${pdBase}/deal/${pdIds.pipedrive_deal_id}` : null,
        orgUrl: pdIds?.pipedrive_org_id ? `${pdBase}/organization/${pdIds.pipedrive_org_id}` : null,
        personUrl: pdIds?.pipedrive_person_id ? `${pdBase}/person/${pdIds.pipedrive_person_id}` : null,
      }
    : null;

  return NextResponse.json({
    ...order,
    company: company ? { ...company, segment: companySegment || company.segment || null } : null,
    pipedrive,
    contact,
    items: itemsWithProfit,
    returns: orderReturns,
    timeline,
    externalUrl,
    shipheroUrl,
    shipments,
    fulfillmentCosts,
    threePl,
    threePlEstimate,
    customerAccountId,
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
