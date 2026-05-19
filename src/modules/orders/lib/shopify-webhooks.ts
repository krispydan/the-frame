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

// Consumer / free email providers. A shared domain here means NOTHING
// about the businesses being related — matching companies on these
// silently collapses unrelated retailers (e.g. a Faire buyer and an
// unrelated stockist both on @hotmail.com → order attributed to the
// wrong company in the "order fulfilled" Slack alert). Domain matching
// is only meaningful for genuine business domains.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk",
  "outlook.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk",
  "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
  "cox.net", "earthlink.net", "frontier.com",
]);

async function findOrCreateCompany(order: ShopifyOrder, shopDomain?: string): Promise<string | null> {
  const email = order.email || order.customer?.email;
  const companyName = order.customer?.default_address?.company;

  // 1. Exact email match — most specific, always safe.
  if (email) {
    const emailMatch = db.select().from(companies).where(eq(companies.email, email)).get();
    if (emailMatch) return emailMatch.id;
  }

  // 2. Exact company-name match — for wholesale/Faire the buyer's store
  //    name comes through default_address.company.
  if (companyName) {
    const nameMatch = db.select().from(companies).where(eq(companies.name, companyName)).get();
    if (nameMatch) return nameMatch.id;
  }

  // 3. Business-domain match — ONLY for non-free domains. Skipping free
  //    providers is the fix for the Molly Monkey mis-attribution: a
  //    coincidental shared @hotmail.com no longer collapses two
  //    unrelated companies.
  if (email) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
      const match = db.select().from(companies).where(eq(companies.domain, domain)).get();
      if (match) return match.id;
    }
  }

  // For wholesale orders, auto-create a company record. Only persist a
  // domain when it's a real business domain — storing "hotmail.com"
  // would make this new company a future false-match magnet for every
  // other hotmail buyer.
  const channel = await detectChannel(order, shopDomain);
  if (channel === "shopify_wholesale" && (companyName || email)) {
    const rawDomain = email ? email.split("@")[1]?.toLowerCase() : null;
    const businessDomain = rawDomain && !FREE_EMAIL_DOMAINS.has(rawDomain) ? rawDomain : null;
    const newCompany = db.insert(companies).values({
      name: companyName || email || "Unknown",
      email: email || null,
      domain: businessDomain,
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

  // Slack alert for wholesale orders only — Daniel deliberately opted out
  // of high-value retail / first-time customer pings to keep noise down.
  if (channel === "shopify_wholesale") {
    try {
      const { notifyWholesaleOrder } = await import("@/modules/integrations/lib/slack/notifications");
      const topSkus = (order.line_items || []).slice(0, 5).map((li) => ({
        sku: li.sku || "—",
        name: li.title || "",
        qty: li.quantity,
      }));
      const companyName = order.customer?.default_address?.company || null;
      const shopUrl = shopDomain ? `https://${shopDomain.replace(/^https?:\/\//, "")}/admin/orders/${order.id}` : null;
      await notifyWholesaleOrder({
        orderNumber: order.name,
        channel,
        total: parseFloat(order.total_price),
        currency: order.currency,
        itemCount: order.line_items?.reduce((s, li) => s + li.quantity, 0) || 0,
        companyName,
        shopUrl,
        topSkus,
      });
    } catch (e) {
      console.error("[Shopify Webhook] Slack wholesale alert failed:", e);
    }
  }
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

  // Slack alerts on financial-status transitions: voided/refunded → payment_failed
  // The "chargeback" topic is fired by the disputes/create webhook (handled separately
  // when we wire it). Voided/refunded counts as a payment fail for our team's purposes.
  const oldFinancial = (existing as { financialStatus?: string }).financialStatus;
  const newFinancial = order.financial_status;
  if (newFinancial !== oldFinancial && (newFinancial === "voided" || newFinancial === "refunded")) {
    try {
      const { notifyPaymentFailed } = await import("@/modules/integrations/lib/slack/notifications");
      await notifyPaymentFailed({
        orderNumber: order.name,
        channel: existing.channel,
        total: parseFloat(order.total_price),
        currency: order.currency,
        customerEmail: order.email || order.customer?.email || null,
        reason: newFinancial === "voided" ? "voided" : "refunded",
      });
    } catch (e) {
      console.error("[Shopify Webhook] Slack payment_failed alert failed:", e);
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

async function handleFulfillmentCreate(fulfillment: ShopifyFulfillment, shopDomain?: string) {
  // Find the order by Shopify order_id
  const existing = db.select().from(orders)
    .where(eq(orders.externalId, String(fulfillment.order_id)))
    .get();
  if (!existing) return;

  // Transition gate. The SAME physical shipment reaches us twice: once
  // here (ShipHero → Shopify channel → Shopify fulfillments/create
  // webhook) and once via the ShipHero Shipment Update webhook
  // (modules/operations/lib/shiphero/shipment-update.ts). Whichever
  // handler runs its synchronous read→update block first "wins" — the
  // other sees status already 'shipped' and must NOT re-fire the
  // event / Slack alert. better-sqlite3 is synchronous and Node is
  // single-threaded, and there is no `await` between this read and the
  // update below, so the block is atomic relative to the other handler.
  const wasShipped = existing.status === "shipped" || existing.status === "delivered";

  // Update order with tracking info (idempotent — same values on a repeat)
  db.update(orders).set({
    status: "shipped",
    trackingNumber: fulfillment.tracking_number || null,
    trackingCarrier: fulfillment.tracking_company || null,
    shippedAt: fulfillment.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(orders.id, existing.id)).run();

  // Create inventory movements for fulfilled items
  createInventoryMovements(fulfillment, existing.id);

  if (wasShipped) {
    // Already shipped by the other webhook path — tracking is refreshed
    // above (cheap, idempotent) but the one-shot side effects (event +
    // Slack) were already fired by whoever won the race. Stop here.
    return;
  }

  eventBus.emit("order.shipped", {
    orderId: existing.id,
    trackingNumber: fulfillment.tracking_number || undefined,
    carrier: fulfillment.tracking_company || undefined,
  });

  // Slack: "📦 order shipped" with deep links to Shopify + Faire (if applicable)
  void (async () => {
    try {
      const {
        notifyOrderFulfilled,
        faireOrderUrlFromName,
        shopifyAdminOrderUrl,
      } = await import("@/modules/integrations/lib/slack/notifications");

      const companyName = existing.companyId
        ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, existing.companyId)).get()?.name ?? null
        : null;

      // Total frame count for the lead line — sum quantities on the local
      // order rather than the webhook payload (more accurate, and stable
      // even for partial-fulfillment webhooks).
      const totals = db
        .select({ qty: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, existing.id))
        .all();
      const itemCount = totals.reduce((s, r) => s + (r.qty || 0), 0);

      const faireUrl = faireOrderUrlFromName(existing.orderNumber);
      const shopifyUrl = shopifyAdminOrderUrl(shopDomain, existing.externalId);

      await notifyOrderFulfilled({
        orderNumber: existing.orderNumber,
        channel: existing.channel,
        total: existing.total,
        currency: existing.currency || "USD",
        itemCount,
        companyName,
        trackingNumber: fulfillment.tracking_number ?? null,
        trackingCarrier: fulfillment.tracking_company ?? null,
        trackingUrl: fulfillment.tracking_url ?? null,
        shopifyAdminUrl: shopifyUrl,
        faireUrl,
      });
    } catch (e) {
      console.error("[Shopify Webhook] Slack fulfilled alert failed:", e);
    }
  })();
}

async function handleFulfillmentUpdate(fulfillment: ShopifyFulfillment) {
  // Update tracking details if they've changed
  const existing = db.select().from(orders)
    .where(eq(orders.externalId, String(fulfillment.order_id)))
    .get();
  if (!existing) return;

  if (fulfillment.tracking_number || fulfillment.tracking_company) {
    db.update(orders).set({
      trackingNumber: fulfillment.tracking_number || existing.trackingNumber,
      trackingCarrier: fulfillment.tracking_company || existing.trackingCarrier,
      updatedAt: new Date().toISOString(),
    }).where(eq(orders.id, existing.id)).run();
  }
}

interface ShopifyRefund {
  id: number;
  order_id: number;
  created_at: string;
  note?: string;
  refund_line_items?: Array<{
    quantity: number;
    line_item: { sku?: string };
  }>;
  transactions?: Array<{
    amount: string;
    kind: string;
    status: string;
  }>;
}

async function handleRefundCreate(refund: ShopifyRefund) {
  const existing = db.select().from(orders)
    .where(eq(orders.externalId, String(refund.order_id)))
    .get();
  if (!existing) return;

  // Compute refund total from transactions
  const refundTotal = (refund.transactions ?? [])
    .filter((t) => t.kind === "refund" && t.status === "success")
    .reduce((sum, t) => sum + parseFloat(t.amount), 0);

  if (refundTotal > 0) {
    db.update(orders).set({
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    }).where(eq(orders.id, existing.id)).run();
  }
}

interface ShopifyInventoryLevel {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}

async function handleInventoryLevelUpdate(level: ShopifyInventoryLevel, shopDomain?: string) {
  // Log only — our inventory source of truth is ShipHero (synced via cron).
  // We don't overwrite ShipHero data with Shopify changes, but we log the
  // event for observability. The shopify_webhook_events table captures the raw
  // payload; this handler is a no-op placeholder.
  void level;
  void shopDomain;
}

interface ShopifyProductUpdate {
  id: number;
  title: string;
  handle: string;
  status: string;
  updated_at: string;
  variants?: Array<{ sku: string; inventory_quantity: number }>;
}

async function handleProductUpdate(product: ShopifyProductUpdate, _shopDomain?: string) {
  // Products are managed from the-frame → Shopify (not the reverse).
  // Log only — the raw payload is in shopify_webhook_events.
  // If we detect a SKU rename or status change we could surface a warning,
  // but for now we treat Shopify product edits as out-of-band.
  void product;
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
    case "orders/updated":
    case "orders/paid": {
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
      await handleFulfillmentCreate(fulfillment, shopDomain);
      break;
    }
    case "fulfillments/update": {
      const fulfillment = payload.parsedBody as ShopifyFulfillment;
      await handleFulfillmentUpdate(fulfillment);
      break;
    }
    case "refunds/create": {
      const refund = payload.parsedBody as ShopifyRefund;
      await handleRefundCreate(refund);
      break;
    }
    case "inventory_levels/update": {
      const level = payload.parsedBody as ShopifyInventoryLevel;
      await handleInventoryLevelUpdate(level, shopDomain);
      break;
    }
    case "customers/create":
    case "customers/update": {
      // Customer data is managed via order webhooks (ensureCustomerAccount).
      // These events are logged in shopify_webhook_events for observability.
      break;
    }
    case "products/update": {
      const product = payload.parsedBody as ShopifyProductUpdate;
      await handleProductUpdate(product, shopDomain);
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

// ── Webhook Registration ──
//
// All subscriptions are managed programmatically via:
//
//   POST /api/v1/integrations/shopify/setup-webhooks
//   GET  /api/v1/integrations/shopify/setup-webhooks  (status check)
//
// Or from Railway SSH:
//   npx tsx scripts/setup-shopify-webhooks.ts          # dry run
//   npx tsx scripts/setup-shopify-webhooks.ts --apply  # register
//
// All topics point to: ${SHOPIFY_APP_URL}/api/v1/webhooks/shopify
// HMAC is verified against SHOPIFY_API_SECRET (shared across both stores).
