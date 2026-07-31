export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { fetchShopifyOrders, hasShopifyCredentials, type ShopifyStore } from "@/modules/orders/lib/shopify-api";

interface ShopifyOrderLite {
  id: number;
  email?: string;
  customer?: {
    id?: number;
    email?: string;
    first_name?: string;
    last_name?: string;
    default_address?: { company?: string };
  };
  shipping_address?: {
    company?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    address1?: string; city?: string; province?: string; province_code?: string;
    zip?: string; country?: string; country_code?: string;
  };
}

/**
 * POST /api/v1/customers/backfill-addresses
 *
 * Companies auto-created from orders often have no mailing address (the webhook
 * saved only a name; the Faire direct-API path stores at most city/state), so
 * they can't be geocoded for the customer map. This pulls Shopify orders (both
 * stores) — where Faire orders arrive WITH a full shipping address — and fills
 * any BLANK address fields on the matching company. Never overwrites data.
 *
 * Matching is deliberately broad, because companies get created three ways with
 * different identity keys: we match each order to a company by
 *   1. shopify_customer_id   (Shopify-webhook-created companies)
 *   2. contact email         (email-matched companies)
 *   3. company name          (Faire-direct-API companies, which have no
 *                             shopify_customer_id — the reason the old
 *                             customer-id-only backfill left them empty)
 *
 * Body: { stores?: ("wholesale"|"dtc")[], maxPages?: number }
 * After running this, re-run geocoding to place the newly-addressed companies.
 */
export async function POST(request: NextRequest) {
  let body: { stores?: ShopifyStore[]; maxPages?: number } = {};
  try { body = await request.json(); } catch { /* empty ok */ }
  const stores = body.stores ?? (["wholesale", "dtc"] as ShopifyStore[]);
  const maxPages = Math.min(body.maxPages ?? 20, 40); // 40 × 250 = 10k orders cap

  const norm = (s: string | null | undefined) => (s ? s.trim().toLowerCase() : "");

  // ── Build company lookup maps ──
  const companyByCustomerId = new Map<string, string>();
  const companyByName = new Map<string, string>();
  for (const r of sqlite.prepare(
    "SELECT id, name, shopify_customer_id FROM companies",
  ).all() as Array<{ id: string; name: string | null; shopify_customer_id: string | null }>) {
    if (r.shopify_customer_id) companyByCustomerId.set(r.shopify_customer_id, r.id);
    if (r.name && !companyByName.has(norm(r.name))) companyByName.set(norm(r.name), r.id);
  }
  const companyByEmail = new Map<string, string>();
  for (const r of sqlite.prepare(
    "SELECT company_id, email FROM contacts WHERE email IS NOT NULL AND email != ''",
  ).all() as Array<{ company_id: string; email: string }>) {
    const k = norm(r.email);
    if (k && !companyByEmail.has(k)) companyByEmail.set(k, r.company_id);
  }

  // Resolve an order to a company id via any available key.
  function matchCompany(o: ShopifyOrderLite): string | null {
    const custId = o.customer?.id != null ? String(o.customer.id) : null;
    if (custId && companyByCustomerId.has(custId)) return companyByCustomerId.get(custId)!;

    for (const email of [o.email, o.customer?.email]) {
      const k = norm(email);
      if (k && companyByEmail.has(k)) return companyByEmail.get(k)!;
      // Some companies are named after the buyer's email (no company/name on file).
      if (k && companyByName.has(k)) return companyByName.get(k)!;
    }

    const sa = o.shipping_address;
    const names = [
      sa?.company,
      o.customer?.default_address?.company,
      sa?.name,
      [sa?.first_name, sa?.last_name].filter(Boolean).join(" "),
      [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" "),
    ];
    for (const n of names) {
      const k = norm(n);
      if (k && companyByName.has(k)) return companyByName.get(k)!;
    }
    return null;
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

  const result: Record<string, { orders: number; matched: number }> = {};
  const filledCompanies = new Set<string>();

  for (const store of stores) {
    result[store] = { orders: 0, matched: 0 };
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
        const sa = o.shipping_address;
        if (!sa) continue;
        const companyId = matchCompany(o);
        if (!companyId) continue;
        result[store].matched++;

        const addr = sa.address1?.trim() || null;
        const city = sa.city?.trim() || null;
        const state = sa.province_code?.trim() || sa.province?.trim() || null;
        const zip = sa.zip?.trim() || null;
        const country = sa.country_code?.trim() || sa.country?.trim() || null;
        if (!addr && !city && !state && !zip && !country) continue;

        update.run(addr, city, state, zip, country, companyId);
        filledCompanies.add(companyId);
      }

      sinceId = String(orders[orders.length - 1].id);
      if (orders.length < 250) break;
    }
  }

  // How many customer companies STILL can't be geocoded (no street and no
  // city/state) — the honest "we genuinely don't have this address" count.
  const remainingUnlocatable = (sqlite.prepare(`
    SELECT COUNT(*) AS c
    FROM companies co
    JOIN customer_accounts ca ON ca.company_id = co.id
    WHERE co.latitude IS NULL
      AND TRIM(COALESCE(co.address,'')) = ''
      AND TRIM(COALESCE(co.city,'')) = ''
      AND TRIM(COALESCE(co.state,'')) = ''
  `).get() as { c: number }).c;

  return NextResponse.json({
    companiesFilled: filledCompanies.size,
    byStore: result,
    remainingUnlocatable,
    note: "Now re-run geocoding (Retry failed) to place the newly-addressed companies.",
  });
}
