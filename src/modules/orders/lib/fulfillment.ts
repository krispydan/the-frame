import { db } from "@/lib/db";
import { orders } from "@/modules/orders/schema";
import { changeLogs, activityFeed } from "@/modules/core/schema";
import { eventBus } from "@/modules/core/lib/event-bus";
import { eq } from "drizzle-orm";
import { createShopifyFulfillment, hasShopifyCredentials, type ShopifyStore } from "./shopify-api";

// ── Status Pipeline ──

const statusPipeline: Record<string, string> = {
  pending: "confirmed",
  confirmed: "picking",
  picking: "packed",
  packed: "shipped",
  shipped: "delivered",
};

export function getNextStatus(current: string): string | null {
  return statusPipeline[current] || null;
}

export interface StatusUpdateInput {
  orderId: string;
  newStatus: string;
  userId?: string;
  trackingNumber?: string;
  trackingCarrier?: string;
  source?: "ui" | "api" | "agent" | "system" | "webhook";
}

export function updateOrderStatus(input: StatusUpdateInput) {
  const order = db.select().from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new Error(`Order not found: ${input.orderId}`);

  const oldStatus = order.status;
  const updates: Record<string, unknown> = {
    status: input.newStatus,
    updatedAt: new Date().toISOString(),
  };

  if (input.newStatus === "shipped") {
    updates.shippedAt = new Date().toISOString();
    if (input.trackingNumber) updates.trackingNumber = input.trackingNumber;
    if (input.trackingCarrier) updates.trackingCarrier = input.trackingCarrier;
  }
  if (input.newStatus === "delivered") {
    updates.deliveredAt = new Date().toISOString();
  }

  db.update(orders).set(updates).where(eq(orders.id, input.orderId)).run();

  // Log change
  db.insert(changeLogs).values({
    entityType: "order",
    entityId: input.orderId,
    field: "status",
    oldValue: oldStatus,
    newValue: input.newStatus,
    userId: input.userId || null,
    source: input.source || "ui",
  }).run();

  // Activity feed
  db.insert(activityFeed).values({
    eventType: `order.${input.newStatus}`,
    module: "orders",
    entityType: "order",
    entityId: input.orderId,
    data: { from: oldStatus, to: input.newStatus, trackingNumber: input.trackingNumber } as unknown as Record<string, unknown>,
    userId: input.userId,
  }).run();

  // Emit events
  if (input.newStatus === "confirmed") {
    eventBus.emit("order.created", { orderId: input.orderId, companyId: order.companyId || "", total: order.total });
  }
  if (input.newStatus === "shipped") {
    eventBus.emit("order.shipped", { orderId: input.orderId, trackingNumber: input.trackingNumber, carrier: input.trackingCarrier });

    // Push fulfillment back to Shopify if this order came from Shopify
    if (order.externalId && (order.channel === "shopify_dtc" || order.channel === "shopify_wholesale") && input.source !== "webhook") {
      const store: ShopifyStore = order.channel === "shopify_wholesale" ? "wholesale" : "dtc";
      if (hasShopifyCredentials(store)) {
        createShopifyFulfillment(store, order.externalId, input.trackingNumber, input.trackingCarrier)
          .catch((err) => console.error("[Fulfillment] Shopify push error:", err));
      }
    }
  }

  return db.select().from(orders).where(eq(orders.id, input.orderId)).get();
}
