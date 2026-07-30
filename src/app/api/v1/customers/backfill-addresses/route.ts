export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { fetchShopifyOrders, hasShopifyCredentials, type ShopifyStore } from "@/modules/orders/lib/shopify-api";

interface ShopifyOrderLite {
  id: number;
  customer?: { id?: number };
  shipping_address?: {
    address1?: string; city?: string; province?: string; province_code?: string;
    zip?: string; country?: string; country_code?: string;
  };
}

/**
 * POST /api/v1/customers/backfill-addresses
 *
 * The order webhook historically saved only a company's name, not its
 * shipping address — so companies auto-created from orders can't be geocoded.
 * This pulls recent Shopify orders (both stores), matches each to its company
 * by shopify_customer_id, and fills any BLANK address fields from the order's
 * shipping address. Never overwrites manually-entered data.
 *
 * Body: { stores?: ("wholesale"|"dtc")[], maxPages?: number }
 * After running this, re-run geocoding to place the newly-addressed companies.
 */
export async function POST(request: NextRequest) {
  let body: { stores?: ShopifyStore[]; maxPages?: number } = {};
  try { body = await request.json(); } catch { /* empty ok */ }
  const stores = body.stores ?? (["wholesale", "dtc"] as ShopifyStore[]);
  const maxPages = Math.min(body.maxPages ?? 20, 40); // 40 × 250 = 10k orders cap

  // Company lookup by Shopify customer id
  const companyByCustomerId = new Map<string, { id: string; hasAddress: boolean }>();
  const rows = sqlite.prepare(
    "SELECT id, shopify_customer_id, address FROM companies WHERE shopify_customer_id IS NOT NULL",
  ).all() as Array<{ id: string; shopify_customer_id: string; address: string | null }>;
  for (const r of rows) {
    companyByCustomerId.set(r.shopify_customer_id, { id: r.id, hasAddress: !!(r.address && r.address.trim()) });
  }

  const update = sqlite.prepare(`
    UPDATE companies SET
      address = COALESCE(NULLIF(address, ''), ?),
      city    = COALESCE(NULLIF(city, ''), ?),
      state   = COALESCE(NULLIF(state, ''), ?),
      zip     = COALESCE(NULLIF(zip, ''), ?),
      country = COALESCE(NULLIF(country, ''), ?)
    WHERE id = ?
  `);

  const result: Record<string, { orders: number; filled: number }> = {};
  let totalFilled = 0;

  for (const store of stores) {
    result[store] = { orders: 0, filled: 0 };
    if (!(await hasShopifyCredentials(store))) continue;

    let sinceId: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      let orders: ShopifyOrderLite[];
      try {
        orders = (await fetchShopifyOrders(store, { status: "any", limit: 250, since_id: sinceId })) as ShopifyOrderLite[];
      } catch (e) {
        console.error(`[backfill-addresses] ${store} fetch failed:`, e);
        break;
      }
      if (!orders.length) break;
      result[store].orders += orders.length;

      for (const o of orders) {
        const custId = o.customer?.id != null ? String(o.customer.id) : null;
        const sa = o.shipping_address;
        if (!custId || !sa) continue;
        const company = companyByCustomerId.get(custId);
        if (!company) continue;

        const addr = sa.address1?.trim() || null;
        const city = sa.city?.trim() || null;
        const state = sa.province_code?.trim() || sa.province?.trim() || null;
        const zip = sa.zip?.trim() || null;
        const country = sa.country_code?.trim() || sa.country?.trim() || null;
        if (!addr && !city && !state && !zip && !country) continue;

        update.run(addr, city, state, zip, country, company.id);
        result[store].filled++;
        totalFilled++;
      }

      sinceId = String(orders[orders.length - 1].id);
      if (orders.length < 250) break;
    }
  }

  return NextResponse.json({ totalFilled, byStore: result });
}
