/**
 * AJ Morgan historical sales importer.
 *
 * AJM (the acquired brand) sold through Faire, a Shopify wholesale store, a
 * Shopify retail store, and an OMS (phone orders). This ingests their exports
 * into ajm_orders / ajm_order_items so Jaxy can compare channels, browse AJM's
 * customer base, and see AJM history on each Frame customer page.
 *
 * Sources & formats:
 *   faire            Faire "orders summary" export — one row per LINE ITEM
 *                    (Order Number, Retailer Name, SKU, Quantity, Wholesale
 *                    Price…). No emails, no shipping. Money like "$3".
 *   faire_payouts    Faire payouts summary — one row per ORDER (Order Total,
 *                    commission, shipping you paid, payout). ENRICHES faire
 *                    orders in place; imports nothing standalone.
 *   shopify_wholesale / shopify_retail
 *                    Standard Shopify order export — one row per line item;
 *                    order-level fields (Email, Subtotal…, Total) filled only
 *                    on the order's FIRST row. Dates "M/D/YYYY H:mm" (old) or
 *                    ISO (new).
 *   faire_emails     Researched retailer-name → email list (no orders).
 *
 * Idempotent per (source, order_number): re-importing replaces the order and
 * its items. Matching to Frame companies runs after import (rematchAjmOrders)
 * via email → contacts, then normalized name → companies.
 */
import Papa from "papaparse";
import { sqlite } from "@/lib/db";

const num = (v: string | null | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s && s.toLowerCase() !== "n/a" && s.toLowerCase() !== "none" ? s : null;
};
/** Normalize a business name for matching: lowercase, strip punctuation. */
export const normName = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** "December 1, 2025" | "1/31/2022 8:30" | ISO → YYYY-MM-DD. */
function toIsoDate(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export type AjmSource = "faire" | "shopify_wholesale" | "shopify_retail" | "oms" | "faire_payouts" | "faire_emails";

export interface AjmImportResult {
  source: AjmSource;
  ordersImported: number;
  itemsImported: number;
  ordersUpdated: number;
  skippedRows: number;
  matched?: number;
  unmatched?: number;
}

function parseCsv(text: string): Record<string, string>[] {
  const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return res.data;
}

export function importAjmCsv(source: AjmSource, csvText: string): AjmImportResult {
  const rows = parseCsv(csvText);
  switch (source) {
    case "faire": return importFaire(rows);
    case "shopify_wholesale":
    case "shopify_retail": return importShopify(source, rows);
    case "faire_payouts": return enrichFairePayouts(rows);
    case "faire_emails": return importFaireEmails(rows);
    default: throw new Error(`Unsupported source: ${source}`);
  }
}

// ── Faire orders summary (line-level) ──

function importFaire(rows: Record<string, string>[]): AjmImportResult {
  const byOrder = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const n = clean(r["Order Number"]);
    if (!n) continue;
    (byOrder.get(n) ?? byOrder.set(n, []).get(n)!).push(r);
  }

  const insOrder = sqlite.prepare(`INSERT INTO ajm_orders
    (id, source, order_number, order_date, customer_name, city, state, country, total, status, cancelled, units)
    VALUES (?, 'faire', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insItem = sqlite.prepare(`INSERT INTO ajm_order_items
    (id, order_id, sku, product_name, option_name, quantity, unit_price, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const delExisting = sqlite.prepare("SELECT id FROM ajm_orders WHERE source='faire' AND order_number = ?");
  const delOrder = sqlite.prepare("DELETE FROM ajm_orders WHERE id = ?");
  const delItems = sqlite.prepare("DELETE FROM ajm_order_items WHERE order_id = ?");

  let orders = 0, items = 0, updated = 0, skipped = 0;
  const run = sqlite.transaction(() => {
    for (const [orderNumber, lines] of byOrder) {
      const first = lines[0];
      const existing = delExisting.get(orderNumber) as { id: string } | undefined;
      if (existing) { delItems.run(existing.id); delOrder.run(existing.id); updated++; }

      const status = clean(first["Status"]) ?? "";
      const cancelled = /cancel/i.test(status) ? 1 : 0;
      const orderId = crypto.randomUUID();
      // Order row FIRST (items reference it), so totals are precomputed.
      let total = 0, units = 0;
      for (const l of lines) { total += num(l["Quantity"]) * num(l["Wholesale Price"]); units += num(l["Quantity"]); }
      insOrder.run(
        orderId, orderNumber, toIsoDate(first["Order Date"]), clean(first["Retailer Name"]),
        clean(first["City"]), clean(first["State"]), clean(first["Country"]),
        Math.round(total * 100) / 100, status, cancelled, units,
      );
      for (const l of lines) {
        const qty = num(l["Quantity"]);
        const price = num(l["Wholesale Price"]);
        insItem.run(crypto.randomUUID(), orderId, clean(l["SKU"]), clean(l["Product Name"]), clean(l["Option Name"]), qty, price, Math.round(qty * price * 100) / 100);
        items++;
      }
      orders++;
    }
  });
  run();
  if (rows.length === 0) skipped = 0;
  return { source: "faire", ordersImported: orders, itemsImported: items, ordersUpdated: updated, skippedRows: skipped };
}

// ── Faire payouts (order-level enrichment) ──

function enrichFairePayouts(rows: Record<string, string>[]): AjmImportResult {
  const upd = sqlite.prepare(`UPDATE ajm_orders SET
      faire_payout = ?, faire_commission = ?, faire_shipping_cost = ?,
      total = CASE WHEN ? > 0 THEN ? ELSE total END
    WHERE source = 'faire' AND order_number = ?`);
  let updated = 0, skipped = 0;
  const run = sqlite.transaction(() => {
    for (const r of rows) {
      const n = clean(r["Order Number"]);
      if (!n) { skipped++; continue; }
      const orderTotal = num(r["Order Total"]);
      const res = upd.run(
        num(r["Payout Amount"]),
        num(r["Total Commission"]) || num(r["Commission"]),
        num(r["Shipping Cost You Paid"]),
        orderTotal, orderTotal, n,
      );
      if (res.changes > 0) updated++; else skipped++;
    }
  });
  run();
  return { source: "faire_payouts", ordersImported: 0, itemsImported: 0, ordersUpdated: updated, skippedRows: skipped };
}

// ── Shopify order exports (line-level, order fields on first row) ──

function importShopify(source: "shopify_wholesale" | "shopify_retail", rows: Record<string, string>[]): AjmImportResult {
  const byOrder = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const n = clean(r["Name"]);
    if (!n) continue;
    (byOrder.get(n) ?? byOrder.set(n, []).get(n)!).push(r);
  }

  const insOrder = sqlite.prepare(`INSERT INTO ajm_orders
    (id, source, order_number, order_date, customer_name, email, city, state, country,
     subtotal, shipping, taxes, total, currency, status, cancelled, units)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insItem = sqlite.prepare(`INSERT INTO ajm_order_items
    (id, order_id, sku, product_name, option_name, quantity, unit_price, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const findExisting = sqlite.prepare(`SELECT id FROM ajm_orders WHERE source = ? AND order_number = ?`);
  const delOrder = sqlite.prepare("DELETE FROM ajm_orders WHERE id = ?");
  const delItems = sqlite.prepare("DELETE FROM ajm_order_items WHERE order_id = ?");

  let orders = 0, items = 0, updated = 0, skipped = 0;
  const run = sqlite.transaction(() => {
    for (const [orderNumber, lines] of byOrder) {
      // Order-level fields live on whichever row has them (normally the first).
      const head = lines.find((l) => clean(l["Total"])) ?? lines[0];
      const existing = findExisting.get(source, orderNumber) as { id: string } | undefined;
      if (existing) { delItems.run(existing.id); delOrder.run(existing.id); updated++; }

      const company = clean(head["Shipping Company"]) ?? clean(head["Billing Company"]);
      const person = clean(head["Shipping Name"]) ?? clean(head["Billing Name"]);
      const cancelled = clean(head["Cancelled at"]) ? 1 : 0;
      const orderId = crypto.randomUUID();
      // Order row FIRST (items reference it).
      const units = lines.reduce((s, l) => s + num(l["Lineitem quantity"]), 0);
      insOrder.run(
        orderId, source, orderNumber, toIsoDate(head["Created at"]),
        company ?? person, clean(head["Email"])?.toLowerCase() ?? null,
        clean(head["Shipping City"]) ?? clean(head["Billing City"]),
        clean(head["Shipping Province"]) ?? clean(head["Billing Province"]),
        clean(head["Shipping Country"]) ?? clean(head["Billing Country"]),
        num(head["Subtotal"]), num(head["Shipping"]), num(head["Taxes"]), num(head["Total"]),
        clean(head["Currency"]) ?? "USD",
        clean(head["Financial Status"]) ?? "", cancelled, units,
      );
      for (const l of lines) {
        const qty = num(l["Lineitem quantity"]);
        const price = num(l["Lineitem price"]);
        insItem.run(crypto.randomUUID(), orderId, clean(l["Lineitem sku"]), clean(l["Lineitem name"]), null, qty, price, Math.round(qty * price * 100) / 100);
        items++;
      }
      orders++;
    }
  });
  run();
  return { source, ordersImported: orders, itemsImported: items, ordersUpdated: updated, skippedRows: skipped };
}

// ── Researched Faire retailer emails ──

function importFaireEmails(rows: Record<string, string>[]): AjmImportResult {
  const ins = sqlite.prepare(`INSERT INTO ajm_faire_emails (store_name_norm, store_name, email, website)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_name_norm) DO UPDATE SET email = excluded.email, website = excluded.website`);
  let n = 0, skipped = 0;
  const run = sqlite.transaction(() => {
    for (const r of rows) {
      const store = clean(r["Store Name"]);
      const email = clean(r["Email Found"])?.toLowerCase();
      if (!store || !email || !email.includes("@")) { skipped++; continue; }
      ins.run(normName(store), store, email, clean(r["Website"]));
      n++;
    }
  });
  run();
  return { source: "faire_emails", ordersImported: n, itemsImported: 0, ordersUpdated: 0, skippedRows: skipped };
}

// ── Matching: AJM orders → Frame companies ──

/**
 * Re-run company matching across all AJM orders.
 * Priority: order email → contacts; Faire retailer name → researched email →
 * contacts; normalized name → companies.name. Person-named retail orders
 * mostly won't match — that's expected (consumers, not companies).
 */
export function rematchAjmOrders(): { matched: number; unmatched: number } {
  const companyByEmail = new Map<string, string>();
  for (const r of sqlite.prepare(
    "SELECT company_id, email FROM contacts WHERE email IS NOT NULL AND email != ''",
  ).all() as Array<{ company_id: string; email: string }>) {
    const k = r.email.trim().toLowerCase();
    if (k && !companyByEmail.has(k)) companyByEmail.set(k, r.company_id);
  }
  const companyByName = new Map<string, string>();
  for (const r of sqlite.prepare("SELECT id, name FROM companies").all() as Array<{ id: string; name: string }>) {
    const k = normName(r.name);
    if (k && !companyByName.has(k)) companyByName.set(k, r.id);
  }
  const faireEmailByName = new Map<string, string>();
  for (const r of sqlite.prepare("SELECT store_name_norm, email FROM ajm_faire_emails WHERE email IS NOT NULL").all() as Array<{ store_name_norm: string; email: string }>) {
    faireEmailByName.set(r.store_name_norm, r.email);
  }

  const orders = sqlite.prepare(
    "SELECT id, source, customer_name, email FROM ajm_orders",
  ).all() as Array<{ id: string; source: string; customer_name: string | null; email: string | null }>;
  const upd = sqlite.prepare("UPDATE ajm_orders SET company_id = ?, match_status = ? WHERE id = ?");

  let matched = 0, unmatched = 0;
  const run = sqlite.transaction(() => {
    for (const o of orders) {
      let companyId: string | null = null;
      const email = o.email?.toLowerCase() ?? (o.customer_name ? faireEmailByName.get(normName(o.customer_name)) ?? null : null);
      if (email) companyId = companyByEmail.get(email) ?? null;
      if (!companyId && o.customer_name) companyId = companyByName.get(normName(o.customer_name)) ?? null;
      upd.run(companyId, companyId ? "matched" : "unmatched", o.id);
      if (companyId) matched++; else unmatched++;
    }
  });
  run();
  return { matched, unmatched };
}

/** Headline stats for the ops endpoint / UI. */
export function ajmStats() {
  const bySource = sqlite.prepare(`
    SELECT source, COUNT(*) AS orders, SUM(units) AS units, ROUND(SUM(total), 2) AS revenue,
           SUM(CASE WHEN company_id IS NOT NULL THEN 1 ELSE 0 END) AS matchedOrders,
           MIN(order_date) AS firstOrder, MAX(order_date) AS lastOrder
    FROM ajm_orders WHERE cancelled = 0
    GROUP BY source
  `).all();
  const customers = sqlite.prepare(`
    SELECT COUNT(DISTINCT COALESCE(company_id, customer_name)) AS c FROM ajm_orders WHERE cancelled = 0
  `).get() as { c: number };
  return { bySource, distinctCustomers: customers.c };
}
