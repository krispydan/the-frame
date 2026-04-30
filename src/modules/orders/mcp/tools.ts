import { z } from "zod";
import { mcpRegistry } from "@/modules/core/mcp/server";
import { db } from "@/lib/db";
import { orders, orderItems, returns } from "@/modules/orders/schema";
import { companies } from "@/modules/sales/schema";
// createManualOrder removed — orders are created in Shopify, then synced down.
import { updateOrderStatus } from "@/modules/orders/lib/fulfillment";
import { eq, desc, and, like, sql } from "drizzle-orm";

// ── orders.list_orders ──
mcpRegistry.register(
  "orders.list_orders",
  "List orders with optional filters: channel, status, search, limit",
  z.object({
    channel: z.string().optional().describe("Filter by channel: shopify_dtc, shopify_wholesale, faire, direct, phone"),
    status: z.string().optional().describe("Filter by status: pending, confirmed, picking, packed, shipped, delivered, returned, cancelled"),
    search: z.string().optional().describe("Search by order number or company name"),
    limit: z.number().optional().describe("Max results (default 20)"),
  }),
  async (args) => {
    const conditions: ReturnType<typeof eq>[] = [];
    if (args.channel) conditions.push(eq(orders.channel, args.channel as any));
    if (args.status) conditions.push(eq(orders.status, args.status as any));
    if (args.search) conditions.push(like(orders.orderNumber, `%${args.search}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(args.limit || 20, 50);

    const data = db.select().from(orders).where(where).orderBy(desc(orders.placedAt)).limit(limit).all();

    const enriched = data.map((o) => {
      const company = o.companyId ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, o.companyId)).get() : null;
      const itemCount = db.select({ count: sql<number>`count(*)` }).from(orderItems).where(eq(orderItems.orderId, o.id)).get()?.count || 0;
      return { ...o, companyName: company?.name || null, itemCount };
    });

    return { content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }] };
  }
);

// ── orders.get_order ──
mcpRegistry.register(
  "orders.get_order",
  "Get full order detail including items, returns, and timeline",
  z.object({
    orderId: z.string().describe("Order ID"),
  }),
  async (args) => {
    const order = db.select().from(orders).where(eq(orders.id, args.orderId)).get();
    if (!order) return { content: [{ type: "text" as const, text: "Order not found" }], isError: true };

    const items = db.select().from(orderItems).where(eq(orderItems.orderId, args.orderId)).all();
    const rets = db.select().from(returns).where(eq(returns.orderId, args.orderId)).all();
    const company = order.companyId ? db.select().from(companies).where(eq(companies.id, order.companyId)).get() : null;

    return { content: [{ type: "text" as const, text: JSON.stringify({ ...order, company, items, returns: rets }, null, 2) }] };
  }
);

// orders.create_order removed — all orders originate in Shopify and sync via
// /api/v1/orders/shopify-sync or webhooks. Creating orders locally produced
// orphan records that didn't exist in Shopify, which corrupted reporting.

// ── orders.update_status ──
mcpRegistry.register(
  "orders.update_status",
  "Update order status through fulfillment pipeline",
  z.object({
    orderId: z.string().describe("Order ID"),
    status: z.string().describe("New status: confirmed, picking, packed, shipped, delivered, cancelled"),
    trackingNumber: z.string().optional().describe("Tracking number (when shipping)"),
    trackingCarrier: z.string().optional().describe("Carrier name"),
  }),
  async (args) => {
    try {
      const updated = await updateOrderStatus({
        orderId: args.orderId,
        newStatus: args.status,
        trackingNumber: args.trackingNumber,
        trackingCarrier: args.trackingCarrier,
        source: "agent",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

// ── orders.process_return ──
mcpRegistry.register(
  "orders.process_return",
  "Create a return request for an order",
  z.object({
    orderId: z.string().describe("Order ID"),
    reason: z.string().optional().describe("Return reason"),
    items: z.array(z.object({
      orderItemId: z.string(),
      quantity: z.number(),
      reason: z.string().optional(),
    })).optional().describe("Specific items to return (partial return)"),
    refundAmount: z.number().optional().describe("Refund amount"),
  }),
  async (args) => {
    const order = db.select().from(orders).where(eq(orders.id, args.orderId)).get();
    if (!order) return { content: [{ type: "text" as const, text: "Order not found" }], isError: true };

    const ret = db.insert(returns).values({
      orderId: args.orderId,
      reason: args.reason || null,
      status: "requested",
      items: args.items || null,
      refundAmount: args.refundAmount || null,
    }).returning().get();

    return { content: [{ type: "text" as const, text: JSON.stringify(ret, null, 2) }] };
  }
);
