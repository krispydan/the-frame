export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settlements, settlementLineItems } from "@/modules/finance/schema";
import { orders } from "@/modules/orders/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq, and, inArray } from "drizzle-orm";
import { syncSettlementToXero } from "@/modules/finance/lib/xero-client";

// Map a settlement.channel to the shopify_shops.channel value
const SETTLEMENT_CHANNEL_TO_SHOP_CHANNEL: Record<string, string | undefined> = {
  shopify_dtc: "retail",
  shopify_wholesale: "wholesale",
};

// GET /api/v1/finance/settlements/:id — returns settlement + line items
// enriched with Shopify admin deep-link and local order matches (so the UI
// drawer can link line items to /orders/{localId}).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settlement = db.select().from(settlements).where(eq(settlements.id, id)).get();
  if (!settlement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lineItemRows = db.select().from(settlementLineItems).where(eq(settlementLineItems.settlementId, id)).all();

  // Match line item order_ids (Shopify order IDs) to local orders by externalId.
  const shopifyOrderIds = Array.from(
    new Set(lineItemRows.map((li) => li.orderId).filter((v): v is string => !!v)),
  );
  const localOrderMap = new Map<string, { id: string; orderNumber: string }>();
  if (shopifyOrderIds.length > 0) {
    const rows = db
      .select({ id: orders.id, externalId: orders.externalId, orderNumber: orders.orderNumber })
      .from(orders)
      .where(inArray(orders.externalId, shopifyOrderIds))
      .all();
    for (const r of rows) {
      if (r.externalId) localOrderMap.set(r.externalId, { id: r.id, orderNumber: r.orderNumber });
    }
  }

  const lineItems = lineItemRows.map((li) => ({
    ...li,
    localOrderId: li.orderId ? localOrderMap.get(li.orderId)?.id ?? null : null,
    localOrderNumber: li.orderId ? localOrderMap.get(li.orderId)?.orderNumber ?? null : null,
  }));

  // Build a Shopify admin deep-link for the payout when we can identify the shop.
  // external_id format: "shopify_payout_{payout_id}"
  let shopifyAdminUrl: string | null = null;
  const payoutMatch = /^shopify_payout_(\d+)$/.exec(settlement.externalId || "");
  if (payoutMatch) {
    const payoutId = payoutMatch[1];
    const shopChannel = SETTLEMENT_CHANNEL_TO_SHOP_CHANNEL[settlement.channel];
    if (shopChannel) {
      const shop = db
        .select({ shopDomain: shopifyShops.shopDomain })
        .from(shopifyShops)
        .where(and(eq(shopifyShops.channel, shopChannel), eq(shopifyShops.isActive, true)))
        .get();
      if (shop?.shopDomain) {
        shopifyAdminUrl = `https://${shop.shopDomain}/admin/settlements/${payoutId}`;
      }
    }
  }

  return NextResponse.json({ ...settlement, lineItems, shopifyAdminUrl });
}

// PATCH /api/v1/finance/settlements/:id — update status or sync to Xero
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  if (body.action === "sync_to_xero") {
    const result = await syncSettlementToXero(id);
    return NextResponse.json(result);
  }

  if (body.status) {
    db.update(settlements).set({ status: body.status }).where(eq(settlements.id, id)).run();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "No action specified" }, { status: 400 });
}
