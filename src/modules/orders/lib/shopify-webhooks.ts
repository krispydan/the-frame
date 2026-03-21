import { db } from "@/lib/db";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies, contacts } from "@/modules/sales/schema";
import { products, skus } from "@/modules/catalog/schema";
import { webhookRegistry, verifyShopifyHmac } from "@/modules/core/lib/webhooks";
import { eventBus } from "@/modules/core/lib/event-bus";
import { eq, or, like } from "drizzle-orm";

// ── Types for Shopify Order Webhook ──

interface ShopifyLineItem {
  id: number;
  product_id: number;
  variant_id: number;
  title: string;
  variant_title: string;
  sku: string;
  quantity: number;
  price: string;
}

interface ShopifyOrder {
  id: number;
  name: string; // e.g. "#1001"
  order_number: number;
  email: string;
  phone: string;
  subtotal_price: string;
  total_discounts: string;
  total_shipping_price_set?: { shop_money: { amount: string } };
  total_tax: string;
  total_price: string;
  currency: string;
  note: string;
  tags: string;
  source_name: string;
  created_at: string;
  cancelled_at: string | null;
  fulfillment_status: string | null;
  financial_status: string;
  line_items: ShopifyLineItem[];
  customer?: {
    email: string;
    first_name: string;
    last_name: string;
    phone: string;
    default_address?: {
      company: string;
    };
  };
  fulfillments?: Array<{
    tracking_number: string;
    tracking_company: string;
    created_at: string;
  }>;
}

// ── Channel Detection ──

function detectChannel(order: ShopifyOrder): "shopify_dtc" | "shopify_wholesale" {
  const tags = (order.tags || "").toLowerCase();
  if (tags.includes("wholesale") || tags.includes("b2b")) return "shopify_wholesale";
  if (order.source_name === "wholesale" || order.source_name === "b2b") return "shopify_wholesale";
  return "shopify_dtc";
}

// ── Company Matching ──

async function findCompanyByOrder(order: ShopifyOrder): Promise<string | null> {
  const email = order.email || order.customer?.email;
  const companyName = order.customer?.default_address?.company;

  if (email) {
    const domain = email.split("@")[1];
    if (domain) {
      const match = db.select().from(companies).where(eq(companies.domain, domain)).get();
      if (match) return match.id;
    }
    const emailMatch = db.select().from(companies).where(eq(companies.email, email)).get();
    if (emailMatch) return emailMatch.id;
  }

  if (companyName) {
    const nameMatch = db.select().from(companies).where(eq(companies.name, companyName)).get();
    if (nameMatch) return nameMatch.id;
  }

  return null;
}

// ── Map Shopify Status ──

function mapStatus(order: ShopifyOrder): "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" {
  if (order.cancelled_at) return "cancelled";
  if (order.fulfillment_status === "fulfilled") return "shipped";
  if (order.fulfillment_status === "partial") return "confirmed";
  if (order.financial_status === "paid" || order.financial_status === "partially_paid") return "confirmed";
  return "pending";
}

// ── Map Line Items ──

async function mapLineItems(orderId: string, items: ShopifyLineItem[]) {
  for (const item of items) {
    // Try to match product/SKU in catalog
    let productId: string | undefined;
    let skuId: string | undefined;

    if (item.sku) {
      const skuMatch = db.select().from(skus).where(eq(skus.sku, item.sku)).get();
      if (skuMatch) {
        skuId = skuMatch.id;
        productId = skuMatch.productId;
      }
    }

    db.insert(orderItems).values({
      orderId,
      productId: productId || null,
      skuId: skuId || null,
      sku: item.sku || null,
      productName: item.title,
      colorName: item.variant_title || null,
      quantity: item.quantity,
      unitPrice: parseFloat(item.price),
      totalPrice: parseFloat(item.price) * item.quantity,
    }).run();
  }
}

// ── Webhook Handlers ──

async function handleOrderCreate(order: ShopifyOrder) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (existing) return; // idempotent

  const companyId = await findCompanyByOrder(order);
  const channel = detectChannel(order);
  const shipping = order.total_shipping_price_set?.shop_money?.amount
    ? parseFloat(order.total_shipping_price_set.shop_money.amount) : 0;

  const newOrder = db.insert(orders).values({
    orderNumber: order.name,
    companyId,
    channel,
    status: mapStatus(order),
    subtotal: parseFloat(order.subtotal_price),
    discount: parseFloat(order.total_discounts),
    shipping,
    tax: parseFloat(order.total_tax),
    total: parseFloat(order.total_price),
    currency: order.currency,
    notes: order.note || null,
    externalId: String(order.id),
    placedAt: order.created_at,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning().get();

  await mapLineItems(newOrder.id, order.line_items);

  eventBus.emit("order.created", {
    orderId: newOrder.id,
    companyId: companyId || "",
    total: parseFloat(order.total_price),
  });
}

async function handleOrderUpdated(order: ShopifyOrder) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (!existing) {
    await handleOrderCreate(order);
    return;
  }

  const newStatus = mapStatus(order);
  db.update(orders).set({
    status: newStatus,
    subtotal: parseFloat(order.subtotal_price),
    discount: parseFloat(order.total_discounts),
    tax: parseFloat(order.total_tax),
    total: parseFloat(order.total_price),
    notes: order.note || existing.notes,
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();
}

async function handleOrderFulfilled(order: ShopifyOrder) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (!existing) return;

  const fulfillment = order.fulfillments?.[0];
  db.update(orders).set({
    status: "shipped",
    trackingNumber: fulfillment?.tracking_number || null,
    trackingCarrier: fulfillment?.tracking_company || null,
    shippedAt: fulfillment?.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();

  eventBus.emit("order.shipped", {
    orderId: existing.id,
    trackingNumber: fulfillment?.tracking_number,
    carrier: fulfillment?.tracking_company,
  });
}

async function handleOrderCancelled(order: ShopifyOrder) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (!existing) return;

  db.update(orders).set({
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();
}

// ── Register with Webhook Infrastructure ──

webhookRegistry.register("shopify", async (payload) => {
  const topic = payload.headers["x-shopify-topic"];
  const order = payload.parsedBody as ShopifyOrder;

  // Verify HMAC if secret is configured
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (secret) {
    const signature = payload.headers["x-shopify-hmac-sha256"];
    if (!signature || !verifyShopifyHmac(payload.body, signature, secret)) {
      return { ok: false, message: "Invalid HMAC signature" };
    }
  }

  switch (topic) {
    case "orders/create":
      await handleOrderCreate(order);
      break;
    case "orders/updated":
      await handleOrderUpdated(order);
      break;
    case "orders/fulfilled":
      await handleOrderFulfilled(order);
      break;
    case "orders/cancelled":
      await handleOrderCancelled(order);
      break;
    default:
      return { ok: true, message: `Unhandled topic: ${topic}` };
  }

  return { ok: true, message: `Processed ${topic} for order ${order.name}` };
});
