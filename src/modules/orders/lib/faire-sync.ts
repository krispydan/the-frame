import { db } from "@/lib/db";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies } from "@/modules/sales/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "@/modules/core/lib/event-bus";
import { ensureCustomerAccount } from "@/modules/customers/lib/account-sync";

// ── Faire CSV Import ──

interface FaireCsvRow {
  order_number: string;
  retailer_name: string;
  retailer_email: string;
  product_name: string;
  sku: string;
  quantity: string;
  unit_price: string;
  total: string;
  order_date: string;
  status: string;
}

export async function importFaireOrders(csvRows: FaireCsvRow[]): Promise<{ imported: number; skipped: number }> {
  // Group rows by order number
  const grouped = new Map<string, FaireCsvRow[]>();
  for (const row of csvRows) {
    const key = row.order_number;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  let imported = 0;
  let skipped = 0;

  for (const [orderNum, rows] of grouped) {
    // Check if already exists
    const existing = db.select().from(orders).where(eq(orders.externalId, orderNum)).get();
    if (existing) {
      skipped++;
      continue;
    }

    // Try to match company
    const retailerName = rows[0].retailer_name;
    const company = db.select().from(companies).where(eq(companies.name, retailerName)).get();

    const subtotal = rows.reduce((sum, r) => sum + parseFloat(r.total || "0"), 0);

    const newOrder = db.insert(orders).values({
      orderNumber: `F-${orderNum}`,
      companyId: company?.id || null,
      channel: "faire",
      status: mapFaireStatus(rows[0].status),
      subtotal,
      total: subtotal,
      externalId: orderNum,
      placedAt: rows[0].order_date || new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).returning().get();

    for (const row of rows) {
      db.insert(orderItems).values({
        orderId: newOrder.id,
        sku: row.sku,
        productName: row.product_name,
        quantity: parseInt(row.quantity) || 1,
        unitPrice: parseFloat(row.unit_price) || 0,
        totalPrice: parseFloat(row.total) || 0,
      }).run();
    }

    eventBus.emit("order.created", {
      orderId: newOrder.id,
      companyId: company?.id || "",
      total: subtotal,
    });

    // Auto-create/update customer account
    if (company?.id) {
      try { ensureCustomerAccount(company.id); } catch (e) { console.error("[AccountSync] Faire import error:", e); }
    }

    imported++;
  }

  return { imported, skipped };
}

function mapFaireStatus(status: string): "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" {
  const s = (status || "").toLowerCase();
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("deliver")) return "delivered";
  if (s.includes("ship")) return "shipped";
  if (s.includes("confirm") || s.includes("process")) return "confirmed";
  return "pending";
}

// ── Manual Order Creation ──

export interface CreateOrderInput {
  companyId?: string;
  contactId?: string;
  channel: "direct" | "phone" | "shopify_dtc" | "shopify_wholesale" | "faire";
  paymentTerms?: string;
  items: Array<{
    productId?: string;
    skuId?: string;
    productName: string;
    sku?: string;
    colorName?: string;
    quantity: number;
    unitPrice: number;
  }>;
  shipping?: number;
  discount?: number;
  tax?: number;
  notes?: string;
}

export function createManualOrder(input: CreateOrderInput) {
  const subtotal = input.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const total = subtotal - (input.discount || 0) + (input.shipping || 0) + (input.tax || 0);

  // Generate order number
  const count = db.select().from(orders).all().length;
  const orderNumber = `M-${String(count + 1).padStart(4, "0")}`;

  const newOrder = db.insert(orders).values({
    orderNumber,
    companyId: input.companyId || null,
    contactId: input.contactId || null,
    channel: input.channel,
    status: "pending",
    subtotal,
    discount: input.discount || 0,
    shipping: input.shipping || 0,
    tax: input.tax || 0,
    total,
    notes: input.notes || null,
    placedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning().get();

  for (const item of input.items) {
    db.insert(orderItems).values({
      orderId: newOrder.id,
      productId: item.productId || null,
      skuId: item.skuId || null,
      sku: item.sku || null,
      productName: item.productName,
      colorName: item.colorName || null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.unitPrice * item.quantity,
    }).run();
  }

  eventBus.emit("order.created", {
    orderId: newOrder.id,
    companyId: input.companyId || "",
    total,
  });

  // Auto-create/update customer account
  if (input.companyId) {
    try { ensureCustomerAccount(input.companyId); } catch (e) { console.error("[AccountSync] Manual order error:", e); }
  }

  return newOrder;
}
