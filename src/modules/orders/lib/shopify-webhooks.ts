import { db, sqlite } from "@/lib/db";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies, contacts } from "@/modules/sales/schema";
import { products, skus } from "@/modules/catalog/schema";
import { inventory, inventoryMovements } from "@/modules/inventory/schema";
import { webhookRegistry, verifyShopifyHmac } from "@/modules/core/lib/webhooks";
import { eventBus } from "@/modules/core/lib/event-bus";
import { ensureCustomerAccount } from "@/modules/customers/lib/account-sync";
import { eq, and } from "drizzle-orm";

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

interface ShopifyFulfillmentLineItem {
  id: number;
  variant_id: number;
  title: string;
  sku: string;
  quantity: number;
}

interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string | null;
  tracking_company: string | null;
  tracking_url: string | null;
  created_at: string;
  line_items: ShopifyFulfillmentLineItem[];
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
  fulfillments?: ShopifyFulfillment[];
}

// ── Channel Detection ──

async function detectChannel(order: ShopifyOrder, shopDomain?: string): Promise<"shopify_dtc" | "shopify_wholesale"> {
  // Primary: look up the channel for the shop domain in the connected stores DB.
  if (shopDomain) {
    const cleaned = shopDomain.toLowerCase().replace(/^https?:\/\//, "").trim();
    try {
      const { listInstalledShops } = await import("@/modules/integrations/lib/shopify/admin-api");
      const all = await listInstalledShops();
      const match = all.find((s) => cleaned === s.shopDomain || cleaned.includes(s.shopDomain));
      if (match?.channel === "wholesale") return "shopify_wholesale";
      if (match?.channel === "retail") return "shopify_dtc";
    } catch {
      // DB unavailable — fall through to tag-based detection.
    }
  }
  // Fallback: tags and source name
  const tags = (order.tags || "").toLowerCase();
  if (tags.includes("wholesale") || tags.includes("b2b")) return "shopify_wholesale";
  if (order.source_name === "wholesale" || order.source_name === "b2b") return "shopify_wholesale";
  return "shopify_dtc";
}

// ── Company Matching / Auto-Create ──

async function findOrCreateCompany(order: ShopifyOrder, shopDomain?: string): Promise<string | null> {
  const email = order.email || order.customer?.email;
  const companyName = order.customer?.default_address?.company;

  // Try existing matches
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

  // For wholesale orders, auto-create a company record
  const channel = await detectChannel(order, shopDomain);
  if (channel === "shopify_wholesale" && (companyName || email)) {
    const newCompany = db.insert(companies).values({
      name: companyName || email || "Unknown",
      email: email || null,
      domain: email ? email.split("@")[1] : null,
      source: "shopify",
    }).returning().get();
    return newCompany.id;
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

// ── Inventory Movements on Fulfillment ──

function createInventoryMovements(fulfillment: ShopifyFulfillment, orderId: string) {
  for (const item of fulfillment.line_items) {
    if (!item.sku) continue;

    const skuMatch = db.select().from(skus).where(eq(skus.sku, item.sku)).get();
    if (!skuMatch) continue;

    // Record sale movement (warehouse → out)
    db.insert(inventoryMovements).values({
      skuId: skuMatch.id,
      fromLocation: "warehouse",
      toLocation: null,
      quantity: item.quantity,
      reason: "sale",
      referenceId: orderId,
    }).run();

    // Decrement warehouse inventory
    const inv = db.select().from(inventory)
      .where(and(eq(inventory.skuId, skuMatch.id), eq(inventory.location, "warehouse")))
      .get();

    if (inv) {
      const newQty = Math.max(0, inv.quantity - item.quantity);
      db.update(inventory).set({
        quantity: newQty,
        needsReorder: newQty < inv.reorderPoint,
        updatedAt: new Date().toISOString(),
      }).where(eq(inventory.id, inv.id)).run();
    }
  }
}

// ── Webhook Handlers ──

export async function handleOrderCreate(order: ShopifyOrder, shopDomain?: string) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (existing) return; // idempotent

  const companyId = await findOrCreateCompany(order, shopDomain);
  const channel = await detectChannel(order, shopDomain);
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

  // Auto-create customer account for the company
  if (companyId) {
    try {
      ensureCustomerAccount(companyId);
    } catch (e) {
      console.error("[Shopify Webhook] ensureCustomerAccount error:", e);
    }
  }

  eventBus.emit("order.created", {
    orderId: newOrder.id,
    companyId: companyId || "",
    total: parseFloat(order.total_price),
  });
}

export async function handleOrderUpdated(order: ShopifyOrder, shopDomain?: string) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (!existing) {
    await handleOrderCreate(order, shopDomain);
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

  // Refresh customer account stats if company is linked
  if (existing.companyId) {
    try {
      ensureCustomerAccount(existing.companyId);
    } catch (e) {
      console.error("[Shopify Webhook] ensureCustomerAccount error:", e);
    }
  }
}

async function handleOrderCancelled(order: ShopifyOrder, _shopDomain?: string) {
  const existing = db.select().from(orders).where(eq(orders.externalId, String(order.id))).get();
  if (!existing) return;

  db.update(orders).set({
    status: "cancelled",
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();

  // Refresh customer stats (cancelled orders excluded from LTV)
  if (existing.companyId) {
    try {
      ensureCustomerAccount(existing.companyId);
    } catch (e) {
      console.error("[Shopify Webhook] ensureCustomerAccount error:", e);
    }
  }
}

async function handleFulfillmentCreate(fulfillment: ShopifyFulfillment) {
  // Find the order by Shopify order_id
  const existing = db.select().from(orders)
    .where(eq(orders.externalId, String(fulfillment.order_id)))
    .get();
  if (!existing) return;

  // Update order with tracking info
  db.update(orders).set({
    status: "shipped",
    trackingNumber: fulfillment.tracking_number || null,
    trackingCarrier: fulfillment.tracking_company || null,
    shippedAt: fulfillment.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();

  // Create inventory movements for fulfilled items
  createInventoryMovements(fulfillment, existing.id);

  eventBus.emit("order.shipped", {
    orderId: existing.id,
    trackingNumber: fulfillment.tracking_number || undefined,
    carrier: fulfillment.tracking_company || undefined,
  });
}

// ── Register with Webhook Infrastructure ──

webhookRegistry.register("shopify", async (payload) => {
  const topic = payload.headers["x-shopify-topic"];
  // Shopify sends the originating store domain in the webhook headers
  const shopDomain = payload.headers["x-shopify-shop-domain"] || "";

  // Verify HMAC against the app's API secret (public-app shared secret).
  const secret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;
  if (secret) {
    const signature = payload.headers["x-shopify-hmac-sha256"];
    if (!signature || !verifyShopifyHmac(payload.body, signature, secret)) {
      return { ok: false, message: "Invalid HMAC signature" };
    }
  }

  switch (topic) {
    case "orders/create": {
      const order = payload.parsedBody as ShopifyOrder;
      await handleOrderCreate(order, shopDomain);
      break;
    }
    case "orders/updated": {
      const order = payload.parsedBody as ShopifyOrder;
      await handleOrderUpdated(order, shopDomain);
      break;
    }
    case "orders/cancelled": {
      const order = payload.parsedBody as ShopifyOrder;
      await handleOrderCancelled(order, shopDomain);
      break;
    }
    case "fulfillments/create": {
      const fulfillment = payload.parsedBody as ShopifyFulfillment;
      await handleFulfillmentCreate(fulfillment);
      break;
    }
    default:
      return { ok: true, message: `Unhandled topic: ${topic}` };
  }

  const name = (payload.parsedBody as { name?: string; order_id?: number }).name
    || (payload.parsedBody as { order_id?: number }).order_id
    || "unknown";
  return { ok: true, message: `Processed ${topic} for ${name}` };
});

// ── Webhook Registration Guide ──
// 
// Register these webhooks in Shopify Admin → Settings → Notifications → Webhooks:
//
// | Topic                | URL                                                  |
// |----------------------|------------------------------------------------------|
// | orders/create        | https://<your-domain>/api/webhooks/shopify            |
// | orders/updated       | https://<your-domain>/api/webhooks/shopify            |
// | orders/cancelled     | https://<your-domain>/api/webhooks/shopify            |
// | fulfillments/create  | https://<your-domain>/api/webhooks/shopify            |
//
// Set format to JSON. Set SHOPIFY_WEBHOOK_SECRET env var to the webhook signing secret.
//
// Or register programmatically via Shopify Admin API:
//
//   POST /admin/api/2024-01/webhooks.json
//   {
//     "webhook": {
//       "topic": "orders/create",
//       "address": "https://<your-domain>/api/webhooks/shopify",
//       "format": "json"
//     }
//   }
