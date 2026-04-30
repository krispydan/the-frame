import { db } from "@/lib/db";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies } from "@/modules/sales/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "@/modules/core/lib/event-bus";
import { ensureCustomerAccount } from "@/modules/customers/lib/account-sync";

// ── Faire API Types ──

interface FaireRetailer {
  id: string;
  name: string;
  email: string;
  phone?: string;
  website?: string;
  address?: {
    city: string;
    state: string;
    country: string;
  };
}

interface FaireOrderItem {
  product_id: string;
  product_name: string;
  variant_name?: string;
  sku: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
}

interface FaireOrder {
  id: string;
  display_id: string; // e.g. "FO-ABC123"
  state: string; // NEW, PROCESSING, PRE_TRANSIT, IN_TRANSIT, DELIVERED, CANCELED
  retailer: FaireRetailer;
  items: FaireOrderItem[];
  payout_costs: {
    subtotal_cents: number;
    commission_cents: number;
    shipping_cents: number;
    total_payout_cents: number;
  };
  opening_order: boolean;
  net_terms_days?: number; // 0 = prepaid, 30/60 = net terms
  created_at: string;
  updated_at: string;
  ship_by_date?: string;
}

interface FaireApiResponse {
  orders: FaireOrder[];
  has_more: boolean;
  cursor?: string;
}

// ── Faire CSV Import (legacy) ──

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
  const grouped = new Map<string, FaireCsvRow[]>();
  for (const row of csvRows) {
    const key = row.order_number;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  let imported = 0;
  let skipped = 0;

  for (const [orderNum, rows] of grouped) {
    const existing = db.select().from(orders).where(eq(orders.externalId, orderNum)).get();
    if (existing) { skipped++; continue; }

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

    eventBus.emit("order.created", { orderId: newOrder.id, companyId: company?.id || "", total: subtotal });
    if (company?.id) {
      try { ensureCustomerAccount(company.id); } catch (e) { console.error("[Faire CSV] ensureCustomerAccount:", e); }
    }
    imported++;
  }

  return { imported, skipped };
}

// ── Faire API Sync ──

const FAIRE_API_BASE = "https://www.faire.com/external-api/v2";

async function faireApiFetch(path: string): Promise<Response> {
  const token = process.env.FAIRE_API_TOKEN;
  if (!token) throw new Error("FAIRE_API_TOKEN not configured");

  return fetch(`${FAIRE_API_BASE}${path}`, {
    headers: {
      "X-FAIRE-ACCESS-TOKEN": token,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Find or create a company from Faire retailer data.
 */
function findOrCreateRetailerCompany(retailer: FaireRetailer): string {
  // Try matching by name first
  const nameMatch = db.select().from(companies).where(eq(companies.name, retailer.name)).get();
  if (nameMatch) return nameMatch.id;

  // Try matching by email
  if (retailer.email) {
    const emailMatch = db.select().from(companies).where(eq(companies.email, retailer.email)).get();
    if (emailMatch) return emailMatch.id;
  }

  // Create new company from retailer data
  const newCompany = db.insert(companies).values({
    name: retailer.name,
    email: retailer.email || null,
    phone: retailer.phone || null,
    website: retailer.website || null,
    city: retailer.address?.city || null,
    state: retailer.address?.state || null,
    country: retailer.address?.country || null,
    source: "faire",
  }).returning().get();

  return newCompany.id;
}

/**
 * Sync a single Faire order into the database.
 */
function syncFaireOrder(faireOrder: FaireOrder): { action: "created" | "updated" | "skipped" } {
  const existing = db.select().from(orders).where(eq(orders.externalId, faireOrder.id)).get();

  const companyId = findOrCreateRetailerCompany(faireOrder.retailer);
  const status = mapFaireStatus(faireOrder.state);
  const subtotal = faireOrder.payout_costs.subtotal_cents / 100;
  const shipping = faireOrder.payout_costs.shipping_cents / 100;
  const total = faireOrder.payout_costs.total_payout_cents / 100;

  // Build notes with Faire-specific metadata
  const noteParts: string[] = [];
  if (faireOrder.opening_order) noteParts.push("🆕 Opening Order");
  if (faireOrder.net_terms_days != null) {
    noteParts.push(faireOrder.net_terms_days === 0 ? "Prepaid" : `Net ${faireOrder.net_terms_days}`);
  }
  if (faireOrder.ship_by_date) noteParts.push(`Ship by: ${faireOrder.ship_by_date}`);
  const notes = noteParts.join(" | ") || null;

  if (existing) {
    // Only update if status changed
    if (existing.status === status) return { action: "skipped" };

    db.update(orders).set({
      status,
      subtotal,
      shipping,
      total,
      notes: notes || existing.notes,
      updatedAt: new Date().toISOString(),
    }).where(eq(orders.id, existing.id)).run();

    if (companyId) {
      try { ensureCustomerAccount(companyId); } catch (e) { /* ignore */ }
    }
    return { action: "updated" };
  }

  // Create new order
  const newOrder = db.insert(orders).values({
    orderNumber: faireOrder.display_id,
    companyId,
    channel: "faire",
    status,
    subtotal,
    discount: faireOrder.payout_costs.commission_cents / 100,
    shipping,
    total,
    currency: "USD",
    notes,
    externalId: faireOrder.id,
    placedAt: faireOrder.created_at,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning().get();

  // Insert line items
  for (const item of faireOrder.items) {
    db.insert(orderItems).values({
      orderId: newOrder.id,
      sku: item.sku || null,
      productName: item.product_name,
      colorName: item.variant_name || null,
      quantity: item.quantity,
      unitPrice: item.unit_price_cents / 100,
      totalPrice: item.total_price_cents / 100,
    }).run();
  }

  // Auto-create customer account
  try { ensureCustomerAccount(companyId); } catch (e) { console.error("[Faire Sync] ensureCustomerAccount:", e); }

  eventBus.emit("order.created", { orderId: newOrder.id, companyId, total });
  return { action: "created" };
}

/**
 * Sync all Faire orders from the API. Paginates through all results.
 * Returns summary of actions taken.
 */
export async function syncFaireOrders(): Promise<{
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };

  try {
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const url = cursor ? `/orders?cursor=${cursor}` : "/orders";
      const response = await faireApiFetch(url);

      if (!response.ok) {
        result.errors.push(`Faire API error: ${response.status} ${response.statusText}`);
        break;
      }

      const data = (await response.json()) as FaireApiResponse;

      for (const faireOrder of data.orders) {
        try {
          const { action } = syncFaireOrder(faireOrder);
          result[action]++;
        } catch (e) {
          result.errors.push(`Order ${faireOrder.display_id}: ${(e as Error).message}`);
        }
      }

      hasMore = data.has_more;
      cursor = data.cursor;
    }
  } catch (e) {
    result.errors.push(`Faire sync failed: ${(e as Error).message}`);
  }

  return result;
}

// ── Status Mapping ──

function mapFaireStatus(status: string): "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" {
  const s = (status || "").toLowerCase();
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("deliver")) return "delivered";
  if (s.includes("ship") || s.includes("transit") || s.includes("pre_transit") || s.includes("in_transit")) return "shipped";
  if (s.includes("processing") || s.includes("confirm") || s.includes("process")) return "confirmed";
  return "pending";
}

// ── Manual Order Creation: removed ──
//
// `createManualOrder` and `CreateOrderInput` were dropped because all orders
// originate in Shopify. Faire orders flow through Faire's Shopify channel
// integration, so the wholesale Shopify store is the source of truth for
// every B2B order too. Anything that needs to "create an order" should do it
// in Shopify and let the sync (POST /api/v1/orders/shopify-sync) or webhook
// pull it down.
