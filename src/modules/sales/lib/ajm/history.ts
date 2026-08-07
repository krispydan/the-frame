/**
 * One company's A.J. Morgan purchase history.
 *
 * AJM ceased trading Dec 2025 and Jaxy employs the person who ran its
 * wholesale book, so this history is the single most useful thing on a
 * retailer's page: it says whether they were a real buyer, how much they
 * spent, and what they bought — before anyone picks up the phone.
 *
 * Shared by the customer page (/customers/[id]) and the company page
 * (/prospects/[id]). It lived inline in the customer page, which meant a
 * retailer with AJM history but no Jaxy account — the ones the sales team most
 * needs to see — had a page that showed nothing at all.
 */
import { sqlite } from "@/lib/db";

export interface AjmHistory {
  orders: number;
  units: number | null;
  revenue: number | null;
  firstOrder: string | null;
  lastOrder: string | null;
  sources: string | null;
  orderRows: Array<{
    id: string; source: string; order_number: string;
    order_date: string | null; total: number; units: number; status: string | null;
  }>;
  topProducts: Array<{ product: string; units: number; revenue: number }>;
  /**
   * Legacy lump-sum orders billed as a single line whose "product name" is an
   * invoice number (categorised `no_detail` on import). They are not products
   * and listing them reads as a wall of meaningless digits — 324803, 299444 —
   * so they are excluded from topProducts and reported as one honest total.
   */
  noDetail: { orders: number; revenue: number } | null;
}

/** Null when this company has no AJM history, so callers can skip the section. */
export function getAjmHistory(companyId: string): AjmHistory | null {
  const summary = sqlite.prepare(`
    SELECT COUNT(*) AS orders, SUM(units) AS units, ROUND(SUM(total), 2) AS revenue,
           MIN(order_date) AS firstOrder, MAX(order_date) AS lastOrder,
           GROUP_CONCAT(DISTINCT source) AS sources
    FROM ajm_orders WHERE company_id = ? AND cancelled = 0
  `).get(companyId) as Omit<AjmHistory, "orderRows" | "topProducts">;
  if (!summary || summary.orders === 0) return null;

  const orderRows = sqlite.prepare(`
    SELECT id, source, order_number, order_date, total, units, status
    FROM ajm_orders WHERE company_id = ? AND cancelled = 0
    ORDER BY order_date DESC LIMIT 100
  `).all(companyId) as AjmHistory["orderRows"];

  /**
   * A line that is not a product.
   *
   * Primary signal is the category the importer assigned. The second clause
   * is only a FALLBACK for rows imported before categorisation ran
   * (`category IS NULL`), and it mirrors `isNoDetailLine` in categorize.ts
   * exactly — no SKU, quantity of one, and a name that opens with four or
   * more digits. An earlier version tested the name shape alone, which would
   * have swept up a genuine product that happens to be named by its style
   * number and then described it as a lump-sum invoice, which is false.
   *
   * COALESCE on product_name is load-bearing: `NULL GLOB '...'` is NULL, not
   * false, so a nameless row satisfied neither `WHERE NOT (P)` nor
   * `WHERE (P)` and its revenue disappeared from both aggregates while
   * remaining inside the header total.
   */
  const NOT_A_PRODUCT = `(
    COALESCE(i.category,'') = 'no_detail'
    OR (i.category IS NULL
        AND COALESCE(TRIM(i.sku),'') = ''
        AND COALESCE(i.quantity, 0) <= 1
        AND COALESCE(i.product_name,'') GLOB '[0-9][0-9][0-9][0-9]*')
  )`;

  const topProducts = sqlite.prepare(`
    SELECT i.product_name AS product, SUM(i.quantity) AS units, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.company_id = ? AND o.cancelled = 0 AND NOT ${NOT_A_PRODUCT}
    GROUP BY i.product_name ORDER BY revenue DESC LIMIT 8
  `).all(companyId) as AjmHistory["topProducts"];

  const nd = sqlite.prepare(`
    SELECT COUNT(DISTINCT o.id) AS orders, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.company_id = ? AND o.cancelled = 0 AND ${NOT_A_PRODUCT}
  `).get(companyId) as { orders: number; revenue: number | null };

  return {
    ...summary,
    orderRows,
    topProducts,
    noDetail: nd && nd.orders > 0 ? { orders: nd.orders, revenue: nd.revenue ?? 0 } : null,
  };
}
