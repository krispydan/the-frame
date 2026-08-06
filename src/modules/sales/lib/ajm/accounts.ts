/**
 * AJM's account book with Jaxy conversion status.
 *
 * This is THE definition of "did this AJM account convert to Jaxy" — the
 * /customers/ajm page renders it and the ops diagnose endpoint reports it, so
 * when someone says "account X shows $0 Jaxy revenue but they've ordered",
 * both surfaces answer from the same query and the answer is trustworthy.
 * Keeping a second copy of this SQL in the diagnose route would let the two
 * drift and make that check meaningless.
 *
 * Fan-out warning: order totals and line-level category sums are aggregated in
 * SEPARATE CTEs before joining. Joining ajm_orders to ajm_order_items and then
 * summing order.total multiplies each total by its line count — a bug that
 * once inflated this list 21x.
 */
import { sqlite } from "@/lib/db";
import { READER_CATEGORIES } from "@/modules/sales/lib/ajm/categorize";
import { AJM_DATA_FROM } from "@/modules/sales/lib/ajm/channels";

const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");

export interface AjmAccount {
  companyId: string;
  name: string;
  accountId: string | null;
  ajmRevenue: number;
  ajmOrders: number;
  lastOrder: string;
  jaxyRevenue: number;
  jaxyOrders: number;
  jaxyFirstOrder: string | null;
  jaxyLastOrder: string | null;
  jaxyLtv: number;
  readerShare: number | null;
}

export function ajmAccountsWithJaxy(): AjmAccount[] {
  return sqlite.prepare(`
    WITH ord AS (
      SELECT company_id, ROUND(SUM(total),2) AS ajmRevenue, COUNT(*) AS ajmOrders,
             MAX(order_date) AS lastOrder
      FROM ajm_orders WHERE cancelled=0 AND order_date >= '${AJM_DATA_FROM}' AND company_id IS NOT NULL GROUP BY company_id
    ),
    cats AS (
      SELECT o.company_id,
             SUM(CASE WHEN i.category IN (${READERS}) THEN i.line_total ELSE 0 END) AS readerRev,
             SUM(i.line_total) AS lineRev
      FROM ajm_orders o JOIN ajm_order_items i ON i.order_id=o.id
      WHERE o.cancelled=0 AND o.order_date >= '${AJM_DATA_FROM}' AND o.company_id IS NOT NULL GROUP BY o.company_id
    ),
    jaxy AS (
      SELECT company_id, ROUND(SUM(total),2) AS jaxyRevenue, COUNT(*) AS jaxyOrders,
             MAX(substr(placed_at,1,10)) AS jaxyLastOrder, MIN(substr(placed_at,1,10)) AS jaxyFirstOrder
      FROM orders WHERE status NOT IN ('cancelled','returned') AND company_id IS NOT NULL GROUP BY company_id
    )
    SELECT ord.company_id AS companyId, c.name, ca.id AS accountId,
           ord.ajmRevenue, ord.ajmOrders, ord.lastOrder,
           COALESCE(j.jaxyRevenue,0) AS jaxyRevenue,
           COALESCE(j.jaxyOrders,0) AS jaxyOrders,
           j.jaxyFirstOrder, j.jaxyLastOrder,
           COALESCE(ca.lifetime_value,0) AS jaxyLtv,
           ROUND(COALESCE(cats.readerRev,0)*100.0/NULLIF(cats.lineRev,0),1) AS readerShare
    FROM ord
    JOIN companies c ON c.id = ord.company_id
    LEFT JOIN customer_accounts ca ON ca.company_id = ord.company_id
    LEFT JOIN cats ON cats.company_id = ord.company_id
    LEFT JOIN jaxy j ON j.company_id = ord.company_id
    ORDER BY ord.ajmRevenue DESC
  `).all() as AjmAccount[];
}
